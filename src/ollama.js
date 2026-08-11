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
  'exhibition': { ko: '전시', catClass: 'tag-exhibition' },
  'convention': { ko: '컨벤션', catClass: 'tag-convention' },
  'incentive': { ko: '인센티브', catClass: 'tag-incentive' },
  'tech': { ko: '테크', catClass: 'tag-tech' },
  'bio': { ko: '바이오', catClass: 'tag-bio' },
  'policy': { ko: '정책', catClass: 'tag-policy' },
  'general': { ko: '일반', catClass: 'tag-convention' },
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
  const content = (article.content || article.title || '').substring(0, 1500);

  const prompt = `You are a MICE industry expert. Analyze this article and return ONLY a valid JSON object, no markdown, no explanation.

Title: ${article.title}
Source: ${article.source}
Content: ${content}

Return this exact JSON structure:
{
  "category": "one of: exhibition|convention|incentive|tech|bio|policy|general",
  "article_type": "one of: 속보|분석|리포트",
  "title_ko": "Korean translation of the title",
  "summary_points": ["Korean fact 1", "Korean data/figure 2", "Korean MICE market impact 3"],
  "insight": "2-3 sentences of strategic insight for Korean PCOs/CVBs/Venues in Korean",
  "content_ko": "<p>Korean translation of the article</p>"
}`;

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
    messages: [
      { role: 'system', content: 'You are a MICE industry analyst. Respond ONLY with valid JSON, no extra text.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 1500,
  });

  const responseText = result?.response || '';
  const firstBrace = responseText.indexOf('{');
  const lastBrace = responseText.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('CW AI returned no JSON: ' + responseText.substring(0, 100));
  }
  return JSON.parse(responseText.slice(firstBrace, lastBrace + 1));
}

// ─────────────────────────────────────────────
// Title Translation
// ─────────────────────────────────────────────

export async function translateTitle(text, env) {
  if (!text) return text;

  // Primary: Cloudflare Workers AI
  if (env.AI) {
    try {
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
        messages: [
          {
            role: 'system',
            content: '당신은 MICE 산업 전문 번역가입니다. 영어 헤드라인을 자연스럽고 전문적인 한국어로 번역하세요. 번역된 제목만 출력하고 다른 설명은 일절 하지 마세요.',
          },
          { role: 'user', content: text },
        ],
        max_tokens: 150,
      });
      const translated = (result?.response || '').trim();
      if (translated && translated !== text) return translated;
    } catch (err) {
      console.error('[CW-AI] Title translation failed:', err.message);
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
    category: catKey,          // English key for DB (exhibition|convention|incentive|tech|bio|policy|general)
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
    '  "category": "exhibition|convention|incentive|tech|bio|policy|general",\n' +
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
    category: '일반',
    catClass: 'tag-convention',
    articleType: '뉴스',
    titleKo: '',
    summaryPoints: [],
    insight: '',
    contentKo: '',
    url: article.link || article.url,
    source: article.source,
    author: article.author || '',
    pubDate: article.pubDate || new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// CW AI 전용 분석 파이프라인 (D1 직접 접근)
// run_local_ai.js 대체 — Mac 없이 클라우드에서 처리
// ─────────────────────────────────────────────

const CAT_CLASS_MAP = {
  convention:     'tag-convention',
  exhibition:     'tag-exhibition',
  incentive:      'tag-incentive',
  event:          'tag-event',
  sustainability: 'tag-sustainability',
  market:         'tag-convention',   // market → convention으로 표시
  policy:         'tag-policy',
  general:        'tag-convention',
};
const VALID_CATS = new Set(Object.keys(CAT_CLASS_MAP));

/** CW AI 단일 호출 — JSON 구조 분석 (제목번역 + 카테고리 + 시사점 + 3줄요약) */
async function cwaiAnalyze(article, env) {
  const excerpt = (article.content_en || article.title || '').slice(0, 1200);
  const prompt = `You are a JSON generator for Korean MICE industry news. Return ONLY valid JSON, no markdown, no explanation.

Schema:
{
  "title_ko": string,       // Natural Korean translation of the title
  "category": string,       // EXACTLY one of: convention|exhibition|incentive|event|sustainability|policy|general
  "insight": string,        // One Korean sentence (15-60 chars), key insight for Korean MICE professionals
  "summary_points": [       // Exactly 3 Korean sentences, each 20-50 chars
    string, string, string
  ]
}

CATEGORY GUIDE:
- convention: conferences, summits, congresses, convention centers, PCO/CVB, hosted buyers, association meetings
- exhibition: trade shows, expos, trade fairs, exhibitors, UFI/IAEE, show floor, booth
- incentive: incentive travel, reward trips, DMC, corporate group travel rewards
- event: festivals, experiential events, brand activations, event tech/platforms/apps, AI tools for events
- sustainability: ESG, green meetings, carbon-neutral events
- policy: government policy, ministry, visa, regulations, public grants
- general: other

Article title: "${article.title}"
Source: ${article.source || ''}
Content: ${excerpt}`;

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
    messages: [
      { role: 'system', content: 'You are a MICE industry analyst. Output ONLY valid JSON.' },
      { role: 'user',   content: prompt },
    ],
    max_tokens: 800,
  });

  const raw = result?.response || '';
  const fb  = raw.indexOf('{');
  const lb  = raw.lastIndexOf('}');
  if (fb === -1 || lb <= fb) throw new Error('No JSON in CW AI response');
  return JSON.parse(raw.slice(fb, lb + 1));
}

/** CW AI 단일 호출 — 본문 한국어 번역 */
async function cwaiTranslate(text, env) {
  if (!text || text.length < 20) return '';
  const content = text.slice(0, 1500); // 토큰 한도 내로 제한

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
    messages: [
      {
        role: 'system',
        content: 'You are a professional Korean translator specializing in MICE industry content. Translate the entire English text to natural, fluent Korean. Output ONLY the Korean translation, nothing else.',
      },
      { role: 'user', content: content },
    ],
    max_tokens: 1200,
  });

  const translated = (result?.response || '').trim();
  if (!translated || !/[가-힣]/.test(translated)) return '';
  return '<p>' + translated.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
}

/**
 * Cloudflare Workers AI 기반 AI 처리 큐
 * - D1에서 pending 기사를 가져와 CW AI로 분석 후 직접 업데이트
 * - Mac 로컬 AI 없이 클라우드에서 완전 자동 처리
 * @param {object} env - Cloudflare Worker env (env.DB, env.AI 필요)
 * @param {number} batchSize - 1회 처리할 최대 기사 수 (기본 5)
 */
export async function processAIQueue(env, batchSize = 5) {
  if (!env.AI) { console.log('[CWAI] env.AI binding not available'); return { processed: 0 }; }

  // 1. 미번역 기사 조회
  const { results: pending } = await env.DB.prepare(`
    SELECT id, title, content_en, source
    FROM articles
    WHERE (insight IS NULL OR insight = '' OR insight = 'pending')
      AND (insight IS NULL OR insight != 'skip-non-mice')
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(batchSize).all();

  if (!pending || pending.length === 0) {
    console.log('[CWAI] No pending articles');
    return { processed: 0 };
  }
  console.log(`[CWAI] Processing ${pending.length} articles`);

  let processed = 0, skipped = 0, errors = 0;

  for (const article of pending) {
    const short = (article.title || '').slice(0, 50);
    try {
      // 2. 분석 (제목번역 + 카테고리 + 시사점 + 요약)
      let meta;
      try {
        meta = await cwaiAnalyze(article, env);
      } catch (e) {
        console.error(`[CWAI] Analyze failed [${article.id}]: ${e.message}`);
        errors++;
        continue;
      }

      // 카테고리 검증 및 보정
      let cat = (meta.category || 'general').toLowerCase().trim();
      if (cat === 'tech') cat = 'event';
      if (!VALID_CATS.has(cat)) cat = 'general';

      const catClass = CAT_CLASS_MAP[cat] || 'tag-convention';

      // title_ko 검증
      const titleKo = (meta.title_ko || '').trim();
      if (!titleKo || !/[가-힣]/.test(titleKo)) {
        console.error(`[CWAI] Bad title_ko [${article.id}]: "${titleKo}"`);
        errors++;
        continue;
      }

      // summary_points 검증 및 보정
      let summaryPoints = Array.isArray(meta.summary_points)
        ? meta.summary_points.filter(s => s && /[가-힣]/.test(s)).slice(0, 3)
        : [];
      while (summaryPoints.length < 3) {
        const fallbacks = [
          `${titleKo.slice(0, 30)} 관련 소식이 보도됐다.`,
          'MICE 산업에 영향을 미칠 수 있는 사안이다.',
          '업계 전문가들의 주목을 받고 있다.',
        ];
        summaryPoints.push(fallbacks[summaryPoints.length]);
      }

      // insight 검증
      let insight = (meta.insight || '').trim();
      if (!insight || !/[가-힣]/.test(insight)) {
        insight = `${article.title.slice(0, 30)} 관련 MICE 산업 동향이 주목받고 있다.`;
      }

      // 3. 본문 번역
      let contentKo = '';
      try {
        contentKo = await cwaiTranslate(article.content_en, env);
      } catch (e) {
        console.warn(`[CWAI] Translation failed [${article.id}], skipping body: ${e.message}`);
      }

      // 4. D1 업데이트
      await env.DB.prepare(`
        UPDATE articles SET
          title_ko = ?, summary_json = ?, insight = ?,
          content_ko = ?, category = ?, cat_class = ?, article_type = ?
        WHERE id = ?
      `).bind(
        titleKo,
        JSON.stringify(summaryPoints),
        insight,
        contentKo,
        cat,
        catClass,
        '분석',
        article.id,
      ).run();

      console.log(`[CWAI] ✅ [${article.id}] ${cat} | ${titleKo.slice(0, 40)}`);
      processed++;

    } catch (e) {
      console.error(`[CWAI] Fatal [${article.id}] ${short}: ${e.message}`);
      errors++;
    }

    // AI 호출 간 짧은 딜레이
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[CWAI] Done — processed:${processed} skipped:${skipped} errors:${errors}`);
  return { processed, skipped, errors };
}
