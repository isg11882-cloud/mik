/**
 * MIK Worker — Main Entry Point v3
 * ──────────────────────────────────────────────────────────────────
 * 변경사항 (v3):
 *  - fetchAndStoreRawRSS: 개별 item 저장 실패가 다음 item 처리를 막지 않도록 개편
 *  - storeArticleRaw: INSERT OR IGNORE + ON CONFLICT(guid) DO NOTHING 이중 보호
 *  - rss-parser의 classifyByRules 결과를 카테고리로 사용 (AI 없이도 분류됨)
 *  - deduplicateItems: 개별 DB 쿼리 오류가 전체를 중단하지 않도록 개편
 *  - processAIQueue: AI 없이도 크롤링 자체는 계속 작동
 * ──────────────────────────────────────────────────────────────────
 */

import { fetchAllFeeds, fetchFullContent } from './rss-parser.js';
import { processArticles, translateTitle }  from './ollama.js';
import { handleApiRequest }                 from './api.js';
import { isMiceRelevant }                   from './mice-filter.js';

// ─────────────────────────────────────────────────────────────────
// Worker 진입점
// ─────────────────────────────────────────────────────────────────

export default {
  /** HTTP 요청 핸들러 — REST API 서빙 */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status:    'ok',
        service:   'MIK Worker',
        timestamp: new Date().toISOString(),
        version:   'v3',
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('MIK — MICE Insight Korea Worker v3', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },

  /** Cron 핸들러 — 매 시간 RSS 수집 + 제목 번역 보정 */
  async scheduled(event, env, ctx) {
    console.log(`[Cron] Triggered at ${new Date().toISOString()}`);
    ctx.waitUntil((async () => {
      try {
        await fetchAndStoreRawRSS(env);
      } catch (e) {
        console.error('[Cron] fetchAndStoreRawRSS fatal:', e?.message);
      }
      try {
        await repairTitles(env);
      } catch (e) {
        console.error('[Cron] repairTitles fatal:', e?.message);
      }
    })());
  },
};

// ─────────────────────────────────────────────────────────────────
// RSS 수집 → D1 저장
// ─────────────────────────────────────────────────────────────────

/**
 * RSS 피드를 전부 가져와 새 기사만 D1에 저장한다.
 * - 개별 기사 저장 실패 시 해당 기사만 건너뜀 (전체 중단 없음)
 * - 카테고리는 rss-parser의 classifyByRules 결과를 우선 사용
 */
export async function fetchAndStoreRawRSS(env) {
  const t0 = Date.now();
  console.log('[Crawl] Starting RSS fetch...');

  const feedItems = await fetchAllFeeds();
  console.log(`[Crawl] Fetched ${feedItems.length} raw items`);

  if (feedItems.length === 0) {
    return { status: 'no_items' };
  }

  // 이미 DB에 있는 항목 제거
  const newItems = await deduplicateItems(feedItems, env);
  console.log(`[Crawl] ${newItems.length} new items after dedup`);

  if (newItems.length === 0) {
    return { status: 'no_new' };
  }

  let storedCount   = 0;
  let filteredCount = 0;
  let errorCount    = 0;

  for (const item of newItems) {
    try {
      // MICE 관련성 필터
      const preCheck = isMiceRelevant(item.title, item.content || '');
      if (!preCheck.pass) {
        console.log(`[Filter] SKIP (score=${preCheck.score}): ${item.title.slice(0, 60)}`);
        filteredCount++;
        continue;
      }

      // 기사 전문 보강 (선택적 — 실패해도 계속)
      try {
        const full = await fetchFullContent(item.link);
        if (full && full.length > 100) item.content = full;
      } catch { /* 전문 수집 실패는 무시 */ }

      // 제목 즉시 번역 (실패해도 원문 유지)
      try {
        item.title_ko = await translateText(item.title, env);
      } catch {
        item.title_ko = item.title;
      }

      await storeArticleRaw(item, env);
      storedCount++;
    } catch (e) {
      errorCount++;
      console.error(`[Crawl] Store failed for "${item.title?.slice(0, 50)}": ${e?.message}`);
      // 이 기사만 건너뛰고 다음 기사로 계속
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Crawl] Done: stored=${storedCount} filtered=${filteredCount} errors=${errorCount} (${elapsed}s)`);
  return { status: 'success', fetched: feedItems.length, stored: storedCount, elapsed: `${elapsed}s` };
}

// ─────────────────────────────────────────────────────────────────
// 중복 제거
// ─────────────────────────────────────────────────────────────────

/**
 * guid 기준으로 이미 DB에 있는 항목을 제거한다.
 * 개별 쿼리 오류 시 해당 항목은 "신규"로 간주 (INSERT OR IGNORE가 최종 수호자)
 */
async function deduplicateItems(items, env) {
  const newItems = [];

  for (const item of items) {
    try {
      const existing = await env.DB.prepare(
        'SELECT id FROM articles WHERE guid = ? LIMIT 1'
      ).bind(item.guid || item.link).first();

      if (!existing) newItems.push(item);
    } catch (err) {
      // DB 오류(테이블 없음 등) → 신규로 처리 (INSERT OR IGNORE가 중복 방지)
      console.warn(`[Dedup] Query error for guid "${item.guid}": ${err?.message}`);
      newItems.push(item);
    }
  }

  return newItems;
}

// ─────────────────────────────────────────────────────────────────
// D1 저장 — INSERT OR IGNORE (스키마의 UNIQUE guid 활용)
// ─────────────────────────────────────────────────────────────────

/**
 * 기사를 D1에 저장한다.
 * - INSERT OR IGNORE: guid UNIQUE 제약으로 중복 자동 방지
 * - category/catClass: rss-parser classifyByRules 결과 사용 (AI 의존 없음)
 * - insight: 빈 문자열 → pending 상태 (로컬 AI가 추후 채움)
 */
async function storeArticleRaw(item, env) {
  const guid     = (item.guid || item.link || '').trim();
  const title    = (item.title || '').trim();
  const title_ko = (item.title_ko || title).trim();
  const link     = (item.link || '').trim();
  const pubDate  = item.pubDate || new Date().toISOString();
  const source   = (item.source || '').trim();

  // classifyByRules 결과 우선, 없으면 defaultCategory
  const category = item.defaultCategory || 'convention';
  const catClass  = item.catClass        || 'tag-convention';

  if (!guid || !title || !link) {
    console.warn(`[DB] Skipping invalid item: guid="${guid}" title="${title?.slice(0, 40)}"`);
    return;
  }

  await env.DB.prepare(`
    INSERT OR IGNORE INTO articles
      (guid, title, title_ko, link, pub_date, source,
       category, cat_class, article_type, author,
       summary_json, insight, content_en, content_ko)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    guid,
    title,
    title_ko,
    link,
    pubDate,
    source,
    category,
    catClass,
    '뉴스',
    source,
    JSON.stringify([title, `${source} 보도`, 'AI 분석 대기 중']),
    '',          // insight = '' → pending (로컬 AI가 채움)
    (item.content || '').slice(0, 50000),
    '',
  ).run();
}

// ─────────────────────────────────────────────────────────────────
// Cloudflare Workers AI 제목 번역 (폴백용)
// ─────────────────────────────────────────────────────────────────

async function translateText(text, env) {
  if (!text) return text;
  try {
    return await translateTitle(text, env);
  } catch (e) {
    console.warn(`[Translate] Failed for "${text?.slice(0, 40)}": ${e?.message}`);
    return text; // 번역 실패 시 원문 반환
  }
}

// ─────────────────────────────────────────────────────────────────
// AI 큐 처리 (Cron에서 호출 — 현재는 로컬 AI 전용이므로 최소화)
// ─────────────────────────────────────────────────────────────────

export async function processAIQueue(env, limit = 2) {
  const t0 = Date.now();
  console.log(`[AI Queue] Processing up to ${limit} articles...`);

  if (!env.OLLAMA_URL && !env.AI) {
    console.warn('[AI Queue] No AI service configured — skipping');
    return { status: 'skipped', message: 'No AI service configured' };
  }

  const pending = await env.DB.prepare(`
    SELECT * FROM articles
    WHERE (insight = '' OR insight IS NULL)
      AND insight != 'skip-non-mice'
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all();

  if (!pending.results?.length) {
    return { status: 'no_pending' };
  }

  const batch = pending.results.map(row => ({
    id:      row.id,
    title:   row.title,
    content: row.content_en || row.title,
    source:  row.source,
  }));

  const processed = await processArticles(batch, env);
  let updatedCount = 0;

  for (const article of processed) {
    try {
      const r = await env.DB.prepare(`
        UPDATE articles
        SET title_ko = ?, summary_json = ?, insight = ?,
            content_ko = ?, category = ?, cat_class = ?, article_type = ?
        WHERE id = ?
      `).bind(
        article.title_ko  || article.titleKo   || article.title || '',
        JSON.stringify(article.summaryPoints || []),
        article.insight   || '',
        article.content_ko || article.contentKo || '',
        article.category  || 'general',
        article.catClass  || 'tag-convention',
        article.articleType || '분석',
        article.id,
      ).run();
      if (r.meta.changes > 0) updatedCount++;
    } catch (err) {
      console.error(`[AI Queue] Update failed for ID ${article.id}: ${err?.message}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  return { status: 'success', processed: updatedCount, elapsed: `${elapsed}s` };
}

// ─────────────────────────────────────────────────────────────────
// 제목 번역 보정 (Cloudflare AI 무료 티어 활용)
// ─────────────────────────────────────────────────────────────────

export async function repairTitles(env) {
  const result = await env.DB.prepare(`
    SELECT id, title FROM articles
    WHERE (title_ko = title OR title_ko = '' OR title_ko IS NULL)
    LIMIT 20
  `).all();

  const articles = result.results || [];
  if (articles.length === 0) return { status: 'ok' };

  let updatedCount = 0;
  for (const article of articles) {
    if (!article.title) continue;
    try {
      const translated = await translateText(article.title, env);
      if (translated && translated !== article.title) {
        await env.DB.prepare('UPDATE articles SET title_ko = ? WHERE id = ?')
          .bind(translated, article.id)
          .run();
        updatedCount++;
      }
    } catch (e) {
      console.warn(`[RepairTitles] Failed for ID ${article.id}: ${e?.message}`);
    }
  }

  console.log(`[RepairTitles] Updated ${updatedCount} titles`);
  return { status: 'success', updated: updatedCount };
}

// ─────────────────────────────────────────────────────────────────
// 유틸리티
// ─────────────────────────────────────────────────────────────────

export async function repairArticles(env) {
  const result = await env.DB.prepare(`
    SELECT * FROM articles
    WHERE (title_ko = title OR title_ko = '' OR summary_json LIKE '%AI 분석 대기%')
      AND title NOT LIKE 'AI 번역 대기%'
    ORDER BY created_at DESC
    LIMIT 5
  `).all();

  const articlesToRepair = result.results || [];
  if (articlesToRepair.length === 0) return { status: 'ok' };

  const batch     = articlesToRepair.map(row => ({
    id: row.id, guid: row.guid, title: row.title, source: row.source, link: row.link,
    content: row.content_en,
  }));
  const processed = await processArticles(batch, env);

  for (const article of processed) {
    if (article.titleKo && article.titleKo !== article.title) {
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
        article.guid || '',
      ).run();
    }
  }

  return { status: 'success', count: processed.length };
}
