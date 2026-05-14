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

  const prompt = `Analyze this MICE article. Return ONLY valid JSON, no other text.

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

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
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
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
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
    category: 'general',
    catClass: 'tag-convention',
    articleType: '뉴스',
    titleKo: article.title,
    summaryPoints: [],
    insight: 'pending',
    contentKo: '',
    url: article.link || article.url,
    source: article.source,
    author: article.author || '',
    pubDate: article.pubDate || new Date().toISOString(),
  };
}
