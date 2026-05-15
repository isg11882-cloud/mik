/**
 * MIK AI Module
 * Handles full MICE article analysis.
 * Priority: Local Ollama → Cloudflare Workers AI → Fallback placeholder
 *
 * Required env vars:
 *   OLLAMA_URL   — e.g. https://your-tunnel.trycloudflare.com (optional)
 *   OLLAMA_MODEL — e.g. qwen2.5:7b  (default: qwen2.5:7b)
 *   AI           — Cloudflare Workers AI binding (automatic via wrangler.toml)
 */

const DEFAULT_MODEL = 'qwen2.5:7b';
const FETCH_TIMEOUT_MS = 25000;

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

Rules:
- category must be exactly one of: convention exhibition incentive tech sustainability market policy
  (convention=meetings/congress, exhibition=tradeshows/expos, incentive=incentive travel,
   tech=event technology/platforms, sustainability=ESG/green meetings,
   market=industry stats/research/trends, policy=regulations/government)
- title_ko: translate the title to Korean
- summary_points: 3 key facts in Korean
- insight: 2 sentences in Korean for Korean PCO/CVB/venue managers

Title: ${article.title}
Source: ${article.source || ''}
Content: ${content.substring(0, 500)}`;

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
  // 1st choice: Ollama (best quality, runs locally)
  if (env.OLLAMA_URL) {
    try {
      const result = await callOllama(buildOllamaPrompt(article), env);
      return buildResult(article, result, 'ollama');
    } catch (err) {
      console.error('[Ollama] processArticle failed, trying CW AI:', err.message);
    }
  }

  // 2nd choice: Cloudflare Workers AI (always available, free tier)
  if (env.AI) {
    try {
      const result = await callCWAI(article, env);
      return buildResult(article, result, 'cwai');
    } catch (err) {
      console.error('[CW-AI] processArticle failed:', err.message);
    }
  }

  // Last resort: placeholder
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

function buildOllamaPrompt(article) {
  return 'You are a Senior MICE Industry Strategy Consultant.\n' +
    'Analyze the following English article and provide a high-precision analysis in Korean.\n' +
    'Respond ONLY in valid JSON — no markdown fences, no extra text.\n\n' +
    '[SOURCE]: ' + (article.source || '') + '\n' +
    '[ARTICLE TITLE]: ' + (article.title || '') + '\n' +
    '[CONTENT]:\n' + (article.content || article.title || '') + '\n\n' +
    '{\n' +
    '  "category": "convention|exhibition|incentive|tech|sustainability|market|policy",\n' +
    '  // convention=국제회의, exhibition=전시박람회, incentive=인센티브여행,\n' +
    '  // tech=이벤트기술, sustainability=친환경ESG, market=시장통계리서치, policy=정책규제\n' +
    '  "article_type": "속보|분석|리포트",\n' +
    '  "title_ko": "...",\n' +
    '  "summary_points": ["핵심 사실", "구체적 수치/인용", "한국 MICE 시장 영향"],\n' +
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
