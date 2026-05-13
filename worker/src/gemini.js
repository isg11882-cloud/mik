/**
 * MIK Gemini AI Module
 * Integrates with Google Gemini 1.5 Flash for article summarization,
 * insight extraction, categorization, and translation.
 */

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

/**
 * Category mapping for MICE industry
 */
const CATEGORY_MAP = {
  'exhibition': { ko: '전시', catClass: 'tag-exhibition' },
  'convention': { ko: '컨벤션', catClass: 'tag-convention' },
  'incentive': { ko: '인센티브', catClass: 'tag-incentive' },
  'tech': { ko: '테크', catClass: 'tag-tech' },
  'bio': { ko: '바이오', catClass: 'tag-bio' },
  'policy': { ko: '정책', catClass: 'tag-policy' },
  'general': { ko: '일반', catClass: 'tag-convention' },
};

/**
 * Process a single article through Gemini AI.
 */
export async function processArticle(article, apiKey) {
  const prompt = buildPrompt(article);

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1, // Stick to facts
          topP: 0.8,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Gemini] API error ${response.status}:`, errText);
      return fallbackResult(article);
    }

    const data = await response.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) return fallbackResult(article);

    // Clean and parse
    text = text.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
    const result = JSON.parse(text);
    
    const catInfo = CATEGORY_MAP[result.category] || CATEGORY_MAP['general'];

    return {
      id: article.id || null, // Keep ID if re-processing
      guid: article.guid,
      title: article.title,
      category: catInfo.ko,
      catClass: catInfo.catClass,
      articleType: result.article_type || '리포트',
      titleKo: result.title_ko || article.title,
      summaryPoints: result.summary_points || [],
      insight: result.insight || '',
      contentKo: result.content_ko || '',
      url: article.link || article.url,
      source: article.source,
      author: article.author || '',
      pubDate: article.pubDate || new Date().toISOString(),
    };
  } catch (err) {
    console.error('[Gemini] Processing error:', err.message);
    return fallbackResult(article);
  }
}

/**
 * Process multiple articles with a delay to respect rate limits.
 */
export async function processArticles(articles, apiKey) {
  const results = [];
  for (let i = 0; i < articles.length; i++) {
    if (i > 0) {
      console.log(`[Gemini] Waiting 8s before next article (${i+1}/${articles.length})...`);
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
    const result = await processArticle(articles[i], apiKey);
    results.push(result);
  }
  return results;
}

/**
 * Build a high-precision prompt for MICE analysis.
 */
function buildPrompt(article) {
  return `You are a Senior MICE Industry Strategy Consultant. 
Analyze the following English article and provide a high-precision analysis in Korean.

[SOURCE]: ${article.source}
[ARTICLE TITLE]: ${article.title}
[CONTENT]:
${article.content}

[OUTPUT INSTRUCTIONS]:
1. Respond ONLY in valid JSON.
2. title_ko: Professional Korean translation. Use industry-standard headlines.
3. summary_points: EXACTLY 3 bullet points. 
   - Point 1: Core event/fact (Who, What, Where, When).
   - Point 2: Specific data, figures ($), numbers, or key quotes.
   - Point 3: Tactical/Strategic impact on the global or Korean MICE market.
   - **CRITICAL**: DO NOT use vague words like "다양한", "좋은", "노력", "발전". Use ONLY specific facts.
4. insight: Professional advice for Korean PCOs/CVBs/Venues. 2-3 sentences.
5. content_ko: High-quality full translation with <p> tags.

[JSON STRUCTURE]:
{
  "category": "exhibition" | "convention" | "incentive" | "tech" | "bio" | "policy",
  "article_type": "속보" | "분석" | "리포트",
  "title_ko": "...",
  "summary_points": ["...", "...", "..."],
  "insight": "...",
  "content_ko": "..."
}`;
}

/**
 * Fallback result when Gemini API fails.
 */
function fallbackResult(article) {
  return {
    category: '일반',
    catClass: 'tag-convention',
    articleType: '뉴스',
    titleKo: '', // Keep empty so repairArticles can pick it up
    summaryPoints: ['AI 분석이 지연되고 있습니다.', '원문을 확인해 주세요.'],
    insight: '현재 데이터 분석 중입니다. 잠시 후 다시 확인해 주세요.',
    contentKo: `<p>${article.content ? article.content.substring(0, 500) : ''}...</p>`,
  };
}
