/**
 * MIK Worker — Main Entry Point
 * Cloudflare Worker that handles:
 * 1. Cron-triggered RSS crawling + AI processing
 * 2. REST API for frontend
 */

import { fetchAllFeeds, fetchFullContent } from './rss-parser.js';
import { processArticles, translateTitle } from './ollama.js';
import { handleApiRequest } from './api.js';

/**
 * Translate a title.
 * Primary: Cloudflare Workers AI (always available).
 * Fallback: Local Ollama (when tunnel is active).
 * Last resort: original English text.
 */
async function translateText(text, env) {
  if (!text) return text;
  return translateTitle(text, env);
}

export default {
  /**
   * HTTP request handler — serves the REST API.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    console.log(`[Fetch Entrance] Path: ${url.pathname}, Method: ${request.method}`);

    // Serve API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'MIK Worker',
        timestamp: new Date().toISOString(),
        deploy_version: 'DEBUG_LOGS_ENABLED_V3'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Default response
    return new Response('MIK — MICE Insight Korea Worker', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },

  /**
   * Scheduled (Cron) handler — runs RSS crawl and AI queue processing.
   */
  async scheduled(event, env, ctx) {
    console.log(`[Cron] Triggered at ${new Date().toISOString()}`);
    ctx.waitUntil((async () => {
      await fetchAndStoreRawRSS(env);
      await repairTitles(env);        // Fix any untranslated English titles
      await processAIQueue(env, 20); // Process 20 articles per hourly run
    })());
  },
};

/**
 * Fetches RSS feeds, deduplicates, and stores them as RAW text.
 * No AI processing occurs here to minimize API usage and prevent failures.
 */
export async function fetchAndStoreRawRSS(env) {
  const startTime = Date.now();
  console.log('[Crawl] Starting raw RSS fetch job...');

  const feedItems = await fetchAllFeeds();
  console.log(`[Crawl] Fetched ${feedItems.length} items from RSS feeds`);

  if (feedItems.length === 0) {
    return { status: 'no_items', message: 'No items fetched' };
  }

  const newItems = await deduplicateItems(feedItems, env);
  console.log(`[Crawl] ${newItems.length} new items to store as RAW`);

  if (newItems.length === 0) {
    return { status: 'no_new', message: 'All items already in DB' };
  }

  let storedCount = 0;
  for (const item of newItems) {
    console.log(`[Crawl] Fetching & Translating: ${item.title}`);
    try {
      const fullContent = await fetchFullContent(item.link);
      if (fullContent) {
        item.content = fullContent;
      }
      
      // Free translation for Title right away!
      item.title_ko = await translateText(item.title, env);
      
      await storeArticleRaw(item, env);
      storedCount++;
    } catch (e) {
      console.error(`[Crawl] Failed to store raw article ${item.title}:`, e.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Crawl] Raw fetch complete: ${storedCount} articles stored in ${elapsed}s`);
  return { status: 'success', fetched: feedItems.length, stored: storedCount, elapsed: `${elapsed}s` };
}

/**
 * Processes a limited number of pending raw articles using Gemini AI.
 */
export async function processAIQueue(env, limit = 2) {
  const startTime = Date.now();
  console.log(`[AI Queue] Starting AI processing for up to ${limit} articles...`);

  if (!env.OLLAMA_URL && !env.AI) {
    console.error('[AI Queue] No AI service configured (OLLAMA_URL or AI binding required).');
    return { status: 'error', message: 'No AI service configured' };
  }

  const query = `SELECT * FROM articles WHERE (insight = '' OR insight IS NULL OR insight LIKE 'AI 분석%' OR insight LIKE 'pending%') ORDER BY created_at DESC LIMIT ?`;
  const debugLogs = [`Executing query: ${query} with limit ${limit}`];

  const pending = await env.DB.prepare(query).bind(limit).all();
  debugLogs.push(`DB results: ${pending.results ? pending.results.length : 0}`);

  if (!pending.results || pending.results.length === 0) {
    return { status: 'no_pending', debug: debugLogs };
  }
  debugLogs.push(`Found IDs: ${pending.results.map(r => r.id).join(', ')}`);

  console.log(`[AI Queue] Found ${pending.results.length} articles to process.`);

  // Map to format expected by processArticles
  const batch = pending.results.map(row => ({
    id: row.id,
    title: row.title,
    content: row.content_en || row.title,
    source: row.source,
  }));

  // Pass env (contains OLLAMA_URL, OLLAMA_MODEL) instead of apiKey
  const processedArticles = await processArticles(batch, env);
  console.log(`[AI Queue] Ollama processed ${processedArticles.length} articles.`);

  let updatedCount = 0;
  debugLogs.push(`Starting update loop for ${processedArticles.length} articles`);
  
  for (const article of processedArticles) {
    try {
      const result = await env.DB.prepare(`
        UPDATE articles
        SET title_ko = ?, summary_json = ?, insight = ?, content_ko = ?, category = ?, cat_class = ?, article_type = ?
        WHERE id = ?
      `).bind(
        article.title_ko || article.titleKo || article.title || '',
        JSON.stringify(article.summaryPoints || []),
        article.insight || '',
        article.content_ko || article.contentKo || '',
        article.category || 'general',
        article.catClass || 'tag-convention',
        article.articleType || '분석',
        article.id
      ).run();
      
      if (result.meta.changes > 0) {
        updatedCount++;
      } else {
        debugLogs.push(`Warning: Article ID ${article.id} found but 0 rows updated.`);
      }
    } catch (err) {
      debugLogs.push(`Error updating ID ${article.id}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  return { status: 'success', processed: updatedCount, elapsed: `${elapsed}s`, debug: debugLogs };
}

/**
 * Check which items are new (not already in D1).
 */
async function deduplicateItems(items, env) {
  const newItems = [];

  for (const item of items) {
    try {
      const existing = await env.DB.prepare(
        'SELECT id FROM articles WHERE guid = ?'
      ).bind(item.guid).first();

      if (!existing) {
        newItems.push(item);
      }
    } catch (err) {
      // If table doesn't exist yet, all items are new
      newItems.push(item);
    }
  }

  return newItems;
}

/**
 * Store a fully processed article in D1.
 */
async function storeArticle(article, env) {
  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO articles 
      (guid, title, title_ko, link, pub_date, source, category, cat_class, article_type, author, summary_json, insight, content_en, content_ko)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      article.guid || '',
      article.title || '',
      article.title_ko || article.titleKo || article.title || '',
      article.link || '',
      article.pub_date || article.pubDate || new Date().toISOString(),
      article.source || '',
      article.category || article.defaultCategory || 'general',
      article.catClass || 'tag-convention',
      article.articleType || '분석',
      article.author || article.source || '',
      JSON.stringify(article.summaryPoints || []),
      article.insight || '',
      article.content || article.content_en || '',
      article.content_ko || article.contentKo || '',
    ).run();
  } catch (err) {
    console.error(`[DB] Store failed for ${article.title}:`, err.message);
    throw err; // Re-throw to allow crawl job to detect failure
  }
}

/**
 * Store a raw article without AI processing.
 */
async function storeArticleRaw(item, env) {
  const defaultInsight = '';
  await env.DB.prepare(`
    INSERT OR IGNORE INTO articles 
    (guid, title, title_ko, link, pub_date, source, category, cat_class, article_type, author, summary_json, insight, content_en, content_ko)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    item.guid || '',
    item.title || '',
    item.title_ko || item.title || '',
    item.link || '',
    item.pubDate || new Date().toISOString(),
    item.source || '',
    item.defaultCategory || 'general',
    item.catClass || 'tag-convention',
    '뉴스',
    item.source || '',
    JSON.stringify([item.title, `${item.source} 보도`, 'AI 분석 대기 중']),
    defaultInsight,
    item.content || '',
    item.content_ko || ''
  ).run();
}

/**
 * Update an existing article with AI results.
 */
async function updateArticle(article, env) {
  await env.DB.prepare(`
    UPDATE articles 
    SET title_ko = ?, category = ?, cat_class = ?, article_type = ?, 
        summary_json = ?, insight = ?, content_ko = ?
    WHERE guid = ?
  `).bind(
    article.titleKo || '',
    article.category || '일반',
    article.catClass || 'tag-convention',
    article.articleType || '리포트',
    JSON.stringify(article.summaryPoints || []),
    article.insight || '',
    article.contentKo || '',
    article.guid || ''
  ).run();
}

/**
 * Identify and repair articles with poor/missing AI data.
 */
export async function repairArticles(env) {
  console.log('[Repair] Starting data repair job...');
  
  // Find articles where title_ko = title (fallback) or is empty or has pending text
  const result = await env.DB.prepare(`
    SELECT * FROM articles 
    WHERE (title_ko = title OR title_ko = '' OR summary_json LIKE '%AI 분석 대기%')
    AND title NOT LIKE 'AI 번역 대기%' 
    ORDER BY created_at DESC
    LIMIT 5
  `).all();

  const articlesToRepair = result.results;
  console.log(`[Repair] Found ${articlesToRepair.length} articles needing repair`);

  if (articlesToRepair.length === 0) {
    return { status: 'ok', message: 'No articles need repair' };
  }

  // Convert DB rows back to the format Gemini expects
  const batch = articlesToRepair.map(row => ({
    id: row.id,
    guid: row.guid,
    title: row.title,
    source: row.source,
    link: row.link,
    content: row.content_en // Use the stored English content
  }));

  const processed = await processArticles(batch, env);
  
  for (const article of processed) {
    // Only update if AI actually returned a different title
    if (article.titleKo && article.titleKo !== article.title) {
      await updateArticle(article, env);
      console.log(`[Repair] Updated: ${article.titleKo}`);
    }
  }

  return { status: 'success', count: processed.length };
}

/**
 * Rapid repair for articles with English titles using free Cloudflare AI.
 */
export async function repairTitles(env) {
  console.log('[Repair] Starting title translation job...');
  
  // Find articles where title_ko is still English
  const result = await env.DB.prepare(`
    SELECT id, title FROM articles 
    WHERE title_ko = title OR title_ko = '' OR title_ko IS NULL
    LIMIT 20
  `).all();

  const articles = result.results;
  if (!articles || articles.length === 0) return { status: 'ok', message: 'No titles need repair' };

  let updatedCount = 0;
  for (const article of articles) {
    if (!article.title) continue;
    const translated = await translateText(article.title, env);
    if (translated && translated !== article.title) {
      await env.DB.prepare('UPDATE articles SET title_ko = ? WHERE id = ?')
        .bind(translated, article.id)
        .run();
      updatedCount++;
    }
  }

  return { status: 'success', updated: updatedCount };
}

/**
 * Utility for JSON responses
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
