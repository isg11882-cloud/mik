/**
 * MIK AI Module
 * Handles full MICE article analysis.
 * Priority: rapid-mlx → Ollama → Cloudflare Workers AI → Fallback
 *
 * Required env vars:
 *   RAPID_MLX_URL   — e.g. https://your-tunnel.trycloudflare.com  (rapid-mlx preferred)
 *   RAPID_MLX_MODEL — e.g. mlx-community/gemma-3-4b-it-4bit       (default)
 *   OLLAMA_URL      — fallback if rapid-mlx not set
 *   OLLAMA_MODEL    — e.g. qwen2.5:7b
 *   AI              — Cloudflare Workers AI binding (wrangler.toml)
 */

const DEFAULT_MODEL = 'qwen2.5:7b';
const DEFAULT_MLX_MODEL = 'mlx-community/gemma-3-4b-it-4bit';
const FETCH_TIMEOUT_MS = 30000;

const CATEGORY_MAP = {
  'convention':     { ko: '컨벤션·회의',   catClass: 'tag-convention' },
  'exhibition':     { ko: '전시·박람회',   catClass: 'tag-exhibition' },
  'incentive':      { ko: '인센티브·여행', catClass: 'tag-incentive' },
  'tech':           { ko: '기술·플랫폼',   catClass: 'tag-tech' },
  'sustainability': { ko: '지속가능성',    catClass: 'tag-sustainability' },
  'market':         { ko: '시장·통계',     catClass: 'tag-market' },
  'policy':         { ko: '정책·규제',     catClass: 'tag-policy' },
  // 하위 호환
  'bio':            { ko: '지속가능성',    catClass: 'tag-sustainability' },
  'general':        { ko: '시장·통계',     catClass: 'tag-market' },
};

// ─────────────────────────────────────────────
// Ollama
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// rapid-mlx  (OpenAI-compatible /v1/chat/completions)
// ─────────────────────────────────────────────

async function callRapidMLX(prompt, env) {
  const baseUrl = (env.RAPID_MLX_URL || '').replace(/\/$/, '');
  const model   = env.RAPID_MLX_MODEL || DEFAULT_MLX_MODEL;
  if (!baseUrl) throw new Error('RAPID_MLX_URL not configured');

  let response;
  try {
    response = await fetch(baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      }),
    });
  } catch (err) {
    throw new Error('rapid-mlx unreachable: ' + err.message);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error('rapid-mlx HTTP ' + response.status + ': ' + errText.substring(0, 200));
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Empty response from rapid-mlx');

  // JSON 파싱
  let cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace  = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────
// Ollama  (/api/generate — classic)
// ─────────────────────────────────────────────

async function callOllama(prompt, env) {
  const baseUrl = (env.OLLAMA_URL || '').replace(/\/$/, '');
  const model = env.OLLAMA_MODEL || DEFAULT_MODEL;
  if (!baseUrl) throw new Error('OLLAMA_URL is not configured');

  let response;
  try {
    response = await fetch(baseUrl + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        model, prompt, stream: false, format: 'json',
        options: { temperature: 0.1, top_p: 0.8, num_predict: 2048 },
      }),
    });
  } catch (err) {
    throw new Error('Ollama unreachable: ' + err.message);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error('Ollama HTTP ' + response.status + ': ' + errText.substring(0, 200));
  }

  const data = await response.json();
  const text = (data && data.response) ? data.response : null;
  if (!text) throw new Error('Empty response from Ollama');

  let cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────
// Cloudflare Workers AI (fallback)
// ─────────────────────────────────────────────

async function callCWAI(article, env) {
  const content = (article.content || article.title || '').substring(0, 1000);

  // ── Step 1: 분석 (JSON) ─── llama로 구조화 출력
  const analysisPrompt = `You are a MICE industry analyst. Output ONLY this JSON object with no other text:
{"category":"convention","article_type":"분석","title_ko":"Korean title here","summary_points":["point1","point2","point3"],"insight":"2-sentence strategic insight for Korean MICE professionals"}

CATEGORY DECISION RULES (pick the BEST match — read all rules before deciding):
- "convention"    → international congress/conference, PCO, PCMA, ICCA, MPI, CVB, DMO, convention center, association meeting, hosted buyer, meeting planner, business event
- "exhibition"    → trade show, expo, tradeshow, trade fair, booth, exhibitor, UFI, IAEE, show floor, exhibit hall, pavilion, display floor
- "incentive"     → incentive travel, incentive trip, incentive program, DMC, SITE Global, fam trip, reward travel, group incentive, incentive destination
- "tech"          → Cvent, Bizzabo, Stova, event app, event platform, virtual event, hybrid event technology, event software, AI tool for events, registration tech, streaming
- "sustainability"→ ESG, green meeting, carbon neutral, net zero, sustainable event, eco-friendly, climate, renewable energy, environmental certification, GMIC
- "market"        → market research, industry report, survey results, forecast, revenue data, statistics, economic impact, spending trend, growth outlook
- "policy"        → government policy, regulation, ministry, legislation, visa, certification standard, official mandate, compliance, grant, subsidy
IMPORTANT: If the article is about a specific EVENT or CONFERENCE → "convention". If about a TRADE SHOW or EXHIBITION → "exhibition". Do NOT default to "market" unless it is explicitly about data/research/statistics.

- title_ko: translate the title to Korean
- summary_points: 3 key facts in Korean (be specific with names, numbers, dates)
- insight: 2 sentences in Korean for Korean PCO/CVB/venue managers

Title: ${article.title}
Source: ${article.source || ''}
Content: ${content.substring(0, 600)}`;

  const r1 = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: 'Output only valid JSON. No markdown. No explanation.' },
      { role: 'user', content: analysisPrompt },
    ],
    max_tokens: 800,
  });

  const t1 = r1?.response || '';
  const fb1 = t1.indexOf('{'), lb1 = t1.lastIndexOf('}');
  if (fb1 === -1 || lb1 <= fb1) throw new Error('CW AI analysis returned no JSON: ' + t1.substring(0, 80));
  const parsed = JSON.parse(t1.slice(fb1, lb1 + 1));

  // ── Step 2: 번역 — Qwen(다국어 특화)으로 한국어 본문 생성
  let content_ko = '';
  try {
    const srcText = content.substring(0, 700);
    // Qwen2.5 모델이 한국어 번역에 훨씬 강함
    const r2 = await env.AI.run('@cf/qwen/qwen2.5-7b-instruct-fp8', {
      messages: [
        {
          role: 'system',
          content: 'You are a professional Korean translator specializing in MICE industry. Translate the English article to fluent Korean. Output ONLY the Korean translation, no English, no explanation.',
        },
        {
          role: 'user',
          content: `Translate to Korean:\n\nTitle: ${article.title}\n\n${srcText}`,
        },
      ],
      max_tokens: 1500,
    });
    const raw = (r2?.response || '').trim();
    if (raw.length > 30) {
      content_ko = '<p>' + raw.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    }
    console.log(`[CW-AI] Translation OK: ${raw.length} chars`);
  } catch (e) {
    console.warn('[CW-AI] Qwen translation failed, trying llama fallback:', e.message);
    // llama 폴백 번역
    try {
      const r2b = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: 'Translate the following English text to Korean. Output only the Korean translation.' },
          { role: 'user', content: `${article.title}\n\n${content.substring(0, 500)}` },
        ],
        max_tokens: 1000,
      });
      const raw2 = (r2b?.response || '').trim();
      if (raw2.length > 30) {
        content_ko = '<p>' + raw2.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
      }
    } catch (e2) {
      console.warn('[CW-AI] Llama translation fallback also failed:', e2.message);
    }
  }

  return { ...parsed, content_ko };
}

// ─────────────────────────────────────────────
// Title Translation
// ─────────────────────────────────────────────

export async function translateTitle(text, env) {
  if (!text) return text;

  // Primary: Cloudflare Workers AI — Qwen (다국어 특화)
  if (env.AI) {
    try {
      const result = await env.AI.run('@cf/qwen/qwen2.5-7b-instruct-fp8', {
        messages: [
          {
            role: 'system',
            content: 'Translate the English MICE industry headline to Korean. Output ONLY the Korean translation, nothing else.',
          },
          { role: 'user', content: text },
        ],
        max_tokens: 150,
      });
      const translated = (result?.response || '').trim();
      if (translated && translated.length > 3 && translated !== text) return translated;
    } catch (err) {
      console.warn('[CW-AI] Qwen title translation failed, trying llama:', err.message);
      // llama 폴백
      try {
        const r2 = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: 'Translate English headline to Korean. Output only Korean.' },
            { role: 'user', content: text },
          ],
          max_tokens: 150,
        });
        const t2 = (r2?.response || '').trim();
        if (t2 && t2 !== text) return t2;
      } catch (err2) {
        console.error('[CW-AI] Title translation failed:', err2.message);
      }
    }
  }

  // rapid-mlx 우선 (빠름)
  if (env.RAPID_MLX_URL) {
    try {
      const prompt = 'Translate to Korean (MICE industry professional style). Return JSON only: {"title_ko": "..."}\n\nInput: "' + text + '"';
      const result = await callRapidMLX(prompt, env);
      if (result?.title_ko && result.title_ko !== text) return result.title_ko;
    } catch (err) {
      console.error('[rapid-mlx] Title translation failed:', err.message);
    }
  }

  // Fallback: Ollama
  if (env.OLLAMA_URL) {
    try {
      const prompt = 'Translate to Korean (MICE industry professional style). Return JSON only: {"title_ko": "..."}\n\nInput: "' + text + '"';
      const result = await callOllama(prompt, env);
      if (result?.title_ko && result.title_ko !== text) return result.title_ko;
    } catch (err) {
      console.error('[Ollama] Title fallback failed:', err.message);
    }
  }

  return text;
}

// ─────────────────────────────────────────────
// Full Article Analysis
// ─────────────────────────────────────────────

export async function processArticle(article, env) {
  const prompt = buildOllamaPrompt(article); // rapid-mlx도 같은 프롬프트 사용

  // 1순위: rapid-mlx (가장 빠름 — Apple Silicon MLX)
  if (env.RAPID_MLX_URL) {
    try {
      const result = await callRapidMLX(prompt, env);
      return buildResult(article, result, 'rapid-mlx');
    } catch (err) {
      console.error('[rapid-mlx] processArticle failed, trying Ollama:', err.message);
    }
  }

  // 2순위: Ollama (로컬 GPU/CPU)
  if (env.OLLAMA_URL) {
    try {
      const result = await callOllama(prompt, env);
      return buildResult(article, result, 'ollama');
    } catch (err) {
      console.error('[Ollama] processArticle failed, trying CW AI:', err.message);
    }
  }

  // 3순위: Cloudflare Workers AI (항상 사용 가능, 무료)
  if (env.AI) {
    try {
      const result = await callCWAI(article, env);
      return buildResult(article, result, 'cwai');
    } catch (err) {
      console.error('[CW-AI] processArticle failed:', err.message);
    }
  }

  // 최종 폴백
  return fallbackResult(article);
}

export async function processArticles(articles, env) {
  const results = [];
  for (let i = 0; i < articles.length; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 300));
    console.log('[AI] Processing ' + (i + 1) + '/' + articles.length + ': ' + articles[i].title);
    results.push(await processArticle(articles[i], env));
  }
  return results;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function buildResult(article, parsed, source) {
  const catKey = (parsed.category || 'general').toLowerCase();
  const catInfo = CATEGORY_MAP[catKey] || CATEGORY_MAP['general'];
  return {
    id: article.id || null,
    guid: article.guid,
    title: article.title,
    category: catKey,          // English key for DB (convention|exhibition|incentive|tech|sustainability|market|policy)
    catClass: catInfo.catClass,
    articleType: parsed.article_type || '분석',
    titleKo: parsed.title_ko || article.title,
    summaryPoints: Array.isArray(parsed.summary_points) ? parsed.summary_points : [],
    insight: parsed.insight || '',
    contentKo: parsed.content_ko || '',
    url: article.link || article.url,
    source: article.source,
    author: article.author || '',
    pubDate: article.pubDate || new Date().toISOString(),
    aiSource: source,
  };
}

/**
 * 키워드 스코어링으로 카테고리 힌트 산출 (AI 분류 정확도 보조)
 */
export function guessCategoryHint(title, content) {
  const txt = ((title || '') + ' ' + (content || '')).toLowerCase();

  const scores = {
    convention:     0,
    exhibition:     0,
    incentive:      0,
    tech:           0,
    sustainability: 0,
    market:         0,
    policy:         0,
  };

  // convention
  for (const kw of ['congress','conference','pcma','icca ','mpi ','cvb ','dmo ','pco ','convention center','convention bureau','meeting planner','meeting professional','business event','hosted buyer','association meeting','annual meeting','delegate','keynote','breakout session','networking event','convention'])
    if (txt.includes(kw)) scores.convention += 3;
  for (const kw of ['meeting','meetings','summit','forum','symposium','seminar','workshop'])
    if (txt.includes(kw)) scores.convention += 1;

  // exhibition
  for (const kw of ['trade show','tradeshow','trade fair','tradefair','exhibition ','exhibitor','ufi ','iaee','show floor','exhibit hall','booth ','booths','pavilion','floor plan','display floor','expo ','exposition'])
    if (txt.includes(kw)) scores.exhibition += 3;
  for (const kw of ['exhibit','expo','fair ','show '])
    if (txt.includes(kw)) scores.exhibition += 1;

  // incentive
  for (const kw of ['incentive travel','incentive trip','incentive program','incentive group','dmc ','site global','fam trip','familiarization trip','reward travel','incentive destination','incentive tour'])
    if (txt.includes(kw)) scores.incentive += 4;
  for (const kw of ['incentive','reward','luxury travel','group travel'])
    if (txt.includes(kw)) scores.incentive += 2;

  // tech
  for (const kw of ['cvent','bizzabo','stova','aventri','eventbrite','event app','event platform','event software','virtual event','hybrid event','event tech','eventtech','registration technology','event management software','ai-powered event','chatbot','rfid','facial recognition'])
    if (txt.includes(kw)) scores.tech += 4;
  for (const kw of ['technology platform','digital event','online event','livestream','streaming','mobile app','qr code'])
    if (txt.includes(kw)) scores.tech += 2;

  // sustainability
  for (const kw of ['esg','green meeting','carbon neutral','net zero','sustainable event','eco-friendly event','gmic','climate','sustainability','renewable energy','environmental certification','carbon offset','zero waste'])
    if (txt.includes(kw)) scores.sustainability += 4;
  for (const kw of ['sustainable','green ','carbon','environment','ecology'])
    if (txt.includes(kw)) scores.sustainability += 1;

  // market
  for (const kw of ['market research','industry report','survey results','forecast','revenue data','statistics','economic impact','spending trend','growth outlook','market size','market share','industry data','benchmark','study finds','report shows','according to research'])
    if (txt.includes(kw)) scores.market += 4;
  for (const kw of ['report','survey','research','data','trend','growth','revenue','forecast','outlook'])
    if (txt.includes(kw)) scores.market += 1;

  // policy
  for (const kw of ['government policy','regulation','ministry','legislation','visa policy','certification standard','official mandate','compliance','grant','subsidy','government support','industry regulation','trade policy','tax incentive'])
    if (txt.includes(kw)) scores.policy += 4;
  for (const kw of ['policy','regulation','government','law ','standard','authority','official'])
    if (txt.includes(kw)) scores.policy += 1;

  // 최고 점수 카테고리 반환 (동점 시 우선순위: convention > exhibition > incentive > tech > sustainability > market > policy)
  const priority = ['convention','exhibition','incentive','tech','sustainability','market','policy'];
  let best = 'convention';
  let bestScore = -1;
  for (const cat of priority) {
    if (scores[cat] > bestScore) {
      bestScore = scores[cat];
      best = cat;
    }
  }
  return best;
}

function buildOllamaPrompt(article) {
  // 키워드 기반 카테고리 힌트 산출 (AI 분류 정확도 향상)
  const hint = guessCategoryHint(article.title, article.content);

  return 'You are a Senior MICE Industry Strategy Consultant.\n' +
    'Analyze the following English article and provide a high-precision analysis in Korean.\n' +
    'Respond ONLY in valid JSON — no markdown fences, no extra text.\n\n' +
    '[SOURCE]: ' + (article.source || '') + '\n' +
    '[ARTICLE TITLE]: ' + (article.title || '') + '\n' +
    '[CONTENT]:\n' + (article.content || article.title || '').substring(0, 1500) + '\n\n' +
    '[CATEGORY HINT — strong signal from keyword analysis]: ' + hint + '\n\n' +
    'CATEGORY RULES (choose the MOST specific match):\n' +
    '  convention    = PCO/PCMA/ICCA/MPI/CVB, congress, conference, convention center, meeting planner, business event, hosted buyer\n' +
    '  exhibition    = trade show/expo/tradeshow/trade fair, booth, exhibitor, UFI/IAEE, show floor, exhibit hall\n' +
    '  incentive     = incentive travel/trip/program, DMC, SITE Global, fam trip, reward travel\n' +
    '  tech          = Cvent/Bizzabo/Stova, event app/platform/software, virtual/hybrid event technology, AI tools for events\n' +
    '  sustainability= ESG, green meeting, carbon neutral, net zero, sustainable events, eco certification\n' +
    '  market        = market research, industry report, statistics, forecast, revenue data, economic impact study\n' +
    '  policy        = government policy, regulation, ministry, legislation, visa, certification, grant\n' +
    'RULE: Follow the hint unless clear evidence in content contradicts it.\n\n' +
    '{\n' +
    '  "category": "' + hint + '",\n' +
    '  "article_type": "속보|분석|리포트",\n' +
    '  "title_ko": "...",\n' +
    '  "summary_points": ["핵심 사실 + 수치", "구체적 인용/출처", "한국 MICE 시장 영향"],\n' +
    '  "insight": "한국 PCO/CVB/베뉴 담당자를 위한 2-3문장 전략적 인사이트",\n' +
    '  "content_ko": "<p>전문 한국어 번역</p>"\n' +
    '}';
}

function fallbackResult(article) {
  return {
    id: article.id || null,
    guid: article.guid,
    title: article.title,
    category: 'general',
    catClass: 'tag-convention',
    articleType: '뉴스',
    titleKo: article.title,  // Keep English; AI will retry later
    summaryPoints: [],
    insight: 'pending',      // Non-empty: prevents infinite re-queue
    contentKo: '',
    url: article.link || article.url,
    source: article.source,
    author: article.author || '',
    pubDate: article.pubDate || new Date().toISOString(),
  };
}
