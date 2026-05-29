/**
 * MIK REST API Handler
 * Provides endpoints for the frontend to fetch articles data from D1.
 */

// ─────────────────────────────────────────────────────────────────
// 관리자 인증 미들웨어
// 사용법: const err = requireAdmin(request, env); if (err) return err;
// ─────────────────────────────────────────────────────────────────
function requireAdmin(request, env) {
  const authHeader = (request.headers.get('Authorization') || '').trim();
  const token      = authHeader.startsWith('Bearer ')
                       ? authHeader.slice(7).trim()
                       : authHeader;
  // 환경변수 필수 — 미설정 시 403 반환 (기본값 폴백 제거)
  // 설정: npx wrangler secret put ADMIN_SECRET
  const secret = (env.ADMIN_SECRET || env.JWT_SECRET || '').trim();
  if (!secret) {
    console.error('[MIK] ADMIN_SECRET not configured. Set via: wrangler secret put ADMIN_SECRET');
    return corsResponse(jsonResponse({ error: 'Server misconfiguration' }, 503));
  }
  if (!token || token !== secret) {
    return corsResponse(jsonResponse({ error: 'Unauthorized' }, 401));
  }
  return null; // 인증 통과
}

/**
 * Handle API routing.
 */
export async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return corsResponse(new Response(null, { status: 204 }));
  }

  try {
    // GET /api/articles — list articles with filtering
    if (path === '/api/articles' && request.method === 'GET') {
      return corsResponse(await getArticles(url, env));
    }

    // GET /api/articles/:id — single article detail
    const articleMatch = path.match(/^\/api\/articles\/(\d+)$/);
    if (articleMatch && request.method === 'GET') {
      return corsResponse(await getArticleById(parseInt(articleMatch[1]), env));
    }

    // GET /api/sources — get source statistics
    if (path === '/api/sources' && request.method === 'GET') {
      return corsResponse(await getSources(env));
    }

    // GET /api/highlights — get today's AI-selected highlights
    if (path === '/api/highlights' && request.method === 'GET') {
      return corsResponse(await getHighlights(env));
    }

    // POST /api/crawl — trigger manual crawl (Full cycle: Raw + AI)  [admin only]
    if (path === '/api/crawl' && request.method === 'POST') {
      const authError = requireAdmin(request, env);
      if (authError) return authError;
      return corsResponse(await triggerCrawl(env));
    }

    // POST /api/crawl/raw — trigger manual raw fetch only  [admin only]
    if (path === '/api/crawl/raw' && request.method === 'POST') {
      const authError = requireAdmin(request, env);
      if (authError) return authError;
      const { fetchAndStoreRawRSS } = await import('./index.js');
      const result = await fetchAndStoreRawRSS(env);
      return corsResponse(jsonResponse(result));
    }

    // GET /api/test-ollama — Ollama 연결 및 모델 상태 진단
    if (path === '/api/test-ollama' && request.method === 'GET') {
      return corsResponse(await testOllama(env));
    }

    // POST /api/repair/titles — repair English titles using free AI
    if (path === '/api/repair/titles' && request.method === 'POST') {
      const { repairTitles } = await import('./index.js');
      const result = await repairTitles(env);
      return corsResponse(jsonResponse(result));
    }

    // GET /api/pending — 미번역 기사 목록 반환 (로컬 AI 스크립트용)
    if (path === '/api/pending' && request.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const result = await env.DB.prepare(`
        SELECT id, title, content_en, source, link
        FROM articles
        WHERE (insight = '' OR insight IS NULL OR insight LIKE 'AI 분석%' OR insight = 'pending')
          AND (insight IS NULL OR insight != 'skip-non-mice')
        ORDER BY created_at DESC LIMIT ?
      `).bind(limit).all();
      return corsResponse(jsonResponse({ articles: result.results || [], count: (result.results||[]).length }));
    }

    // POST /api/admin/sync — 로컬 Ollama 처리 결과 업로드
    if (path === '/api/admin/sync' && request.method === 'POST') {
      const authError = requireAdmin(request, env);
      if (authError) return authError;
      let body;
      try { body = await request.json(); } catch(e) { return corsResponse(jsonResponse({ error: 'Invalid JSON' }, 400)); }
      const articles = body.articles || [];
      if (!Array.isArray(articles) || articles.length === 0) {
        return corsResponse(jsonResponse({ error: 'articles array required' }, 400));
      }
      let updated = 0;
      for (const a of articles) {
        if (!a.id) continue;
        try {
          await env.DB.prepare(`
            UPDATE articles SET
              title_ko = ?, summary_json = ?, insight = ?,
              content_ko = ?, category = ?, cat_class = ?, article_type = ?
            WHERE id = ?
          `).bind(
            a.title_ko || '', JSON.stringify(a.summary_points || []),
            a.insight || 'done', a.content_ko || '',
            a.category || 'general', a.cat_class || 'tag-convention',
            a.article_type || '분석', a.id
          ).run();
          updated++;
        } catch(err) { console.error('[Sync] Update failed for id', a.id, err.message); }
      }
      return corsResponse(jsonResponse({ status: 'ok', updated, total: articles.length }));
    }

    // POST /api/admin/scan-gibberish — 깨진 번역 기사 감지 및 선택적 초기화
    if (path === '/api/admin/scan-gibberish' && request.method === 'POST') {
      const authError = requireAdmin(request, env);
      if (authError) return authError;

      const body = await request.json().catch(() => ({}));
      const fix = body.fix === true;

      // 번역 완료 기사 전체 조회
      const allResult = await env.DB.prepare(`
        SELECT id, title, title_ko FROM articles
        WHERE insight NOT IN ('', 'skip-non-mice', 'pending')
          AND insight IS NOT NULL AND insight != ''
        ORDER BY id ASC
      `).all();

      const articles = allResult.results || [];
      const gibberishIds = [];
      const samples = [];

      for (const a of articles) {
        if (isGibberish(a.title_ko)) {
          gibberishIds.push(a.id);
          if (samples.length < 5) samples.push({ id: a.id, title: a.title?.slice(0,50), title_ko: a.title_ko?.slice(0,50) });
        }
      }

      if (!fix) {
        return corsResponse(jsonResponse({
          status: 'scanned', scanned: articles.length,
          gibberish_found: gibberishIds.length, samples,
        }));
      }

      // 배치 초기화
      let resetCount = 0;
      const BATCH = 50;
      for (let i = 0; i < gibberishIds.length; i += BATCH) {
        const batch = gibberishIds.slice(i, i + BATCH);
        const ph = batch.map(() => '?').join(',');
        const r = await env.DB.prepare(
          `UPDATE articles SET insight='', title_ko='', content_ko='', summary_json='[]' WHERE id IN (${ph})`
        ).bind(...batch).run();
        resetCount += r.meta?.changes || 0;
      }

      return corsResponse(jsonResponse({
        status: 'ok', scanned: articles.length,
        gibberish_found: gibberishIds.length, reset: resetCount, samples,
      }));
    }

    // POST /api/admin/reset-bad — 번역 오류 기사 pending으로 초기화
    if (path === '/api/admin/reset-bad' && request.method === 'POST') {
      const authError = requireAdmin(request, env);
      if (authError) return authError;
      const body = await request.json().catch(() => ({}));
      const nuclear = body.nuclear === true;

      let result;
      if (nuclear) {
        // 전체 초기화: skip-non-mice 제외한 모든 처리된 기사
        result = await env.DB.prepare(`
          UPDATE articles
          SET insight = '', content_ko = '', title_ko = '', summary_json = '[]'
          WHERE insight NOT IN ('', 'skip-non-mice', 'pending')
            AND insight IS NOT NULL
        `).run();
      } else {
        // 일반 초기화: content_ko가 짧은 기사만
        result = await env.DB.prepare(`
          UPDATE articles
          SET insight = '', content_ko = '', title_ko = '', summary_json = '[]'
          WHERE insight NOT IN ('', 'skip-non-mice', 'pending')
            AND insight IS NOT NULL
            AND (content_ko IS NULL OR LENGTH(content_ko) < 50)
        `).run();
      }
      const changes = result.meta?.changes || 0;
      return corsResponse(jsonResponse({ status: 'ok', reset: changes, nuclear }));
    }

    // GET /api/stats — 카테고리별/날짜별 기사 통계 (리포트 패널용)
    if (path === '/api/stats' && request.method === 'GET') {
      const [catStats, dateStats, sourceStats, totalResult] = await Promise.all([
        env.DB.prepare(`
          SELECT category, COUNT(*) as count
          FROM articles
          WHERE insight != '' AND insight != 'skip-non-mice' AND insight IS NOT NULL
          GROUP BY category ORDER BY count DESC
        `).all(),
        env.DB.prepare(`
          SELECT DATE(created_at) as date, COUNT(*) as count
          FROM articles
          WHERE created_at >= datetime('now', '-14 days')
          GROUP BY DATE(created_at) ORDER BY date ASC
        `).all(),
        env.DB.prepare(`
          SELECT source, COUNT(*) as count
          FROM articles
          WHERE insight != '' AND insight != 'skip-non-mice'
          GROUP BY source ORDER BY count DESC LIMIT 10
        `).all(),
        env.DB.prepare(`SELECT COUNT(*) as total FROM articles WHERE insight != 'skip-non-mice'`).first(),
      ]);
      return corsResponse(jsonResponse({
        byCategory: catStats.results || [],
        byDate: dateStats.results || [],
        bySource: sourceStats.results || [],
        total: totalResult?.total || 0,
      }));
    }

    // GET /api/sources/status — RSS 소스별 최근 수집 현황
    if (path === '/api/sources/status' && request.method === 'GET') {
      const result = await env.DB.prepare(`
        SELECT source,
               COUNT(*) as total,
               MAX(created_at) as last_seen,
               SUM(CASE WHEN insight != '' AND insight IS NOT NULL AND insight != 'skip-non-mice' THEN 1 ELSE 0 END) as analyzed
        FROM articles
        GROUP BY source
        ORDER BY total DESC
      `).all();
      return corsResponse(jsonResponse({ sources: result.results || [] }));
    }

    // POST /api/recategorize — keyword 기반으로 기존 기사 카테고리 일괄 재분류  [admin only]
    if (path === '/api/recategorize' && request.method === 'POST') {
      const authError = requireAdmin(request, env);
      if (authError) return authError;
      return corsResponse(await recategorizeArticles(url, env));
    }

    // GET /api/process-ai — manually trigger AI queue from browser  [admin only]
    if (path === '/api/process-ai' && request.method === 'GET') {
      const authError = requireAdmin(request, env);
      if (authError) return authError;
      console.log('[API] Processing AI Queue manually (GET)...');
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const { processAIQueue } = await import('./index.js');
      const result = await processAIQueue(env, limit);
      return corsResponse(jsonResponse(result));
    }

    // POST /api/process-ai — manually process pending AI queue  [admin only]
    if (path === '/api/process-ai' && request.method === 'POST') {
      const authError = requireAdmin(request, env);
      if (authError) return authError;
      console.log('[API] Processing AI Queue manually...');
      const urlParams = new URL(request.url);
      const limit = parseInt(urlParams.searchParams.get('limit') || '5');
      console.log(`[API] Limit set to: ${limit}`);
      const { processAIQueue } = await import('./index.js');
      const result = await processAIQueue(env, limit);
      console.log('[API] AI Queue process result:', JSON.stringify(result));
      return corsResponse(jsonResponse(result));
    }

    // --- Authentication & User Endpoints ---
    
    // POST /api/auth/signup
    if (path === '/api/auth/signup' && request.method === 'POST') {
      return corsResponse(await handleSignup(request, env));
    }

    // POST /api/auth/login
    if (path === '/api/auth/login' && request.method === 'POST') {
      return corsResponse(await handleLogin(request, env));
    }

    // GET /api/user/profile
    if (path === '/api/user/profile' && request.method === 'GET') {
      return corsResponse(await getUserProfile(request, env));
    }

    // POST /api/user/settings
    if (path === '/api/user/settings' && request.method === 'POST') {
      return corsResponse(await updateUserSettings(request, env));
    }

    return corsResponse(jsonResponse({ error: 'Not Found' }, 404));
  } catch (err) {
    console.error('[API] Error:', err.message);
    return corsResponse(jsonResponse({ error: 'Internal Server Error', detail: err.message }, 500));
  }
}

/**
 * GET /api/articles
 * Query params: source, category, search, sort, limit, offset
 */
async function getArticles(url, env) {
  const source = url.searchParams.get('source');
  const category = url.searchParams.get('category');
  const search = url.searchParams.get('search');
  const sort = url.searchParams.get('sort') || 'latest';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  let query = 'SELECT * FROM articles WHERE 1=1';
  const params = [];

  if (source && source !== 'all') {
    query += ' AND source = ?';
    params.push(source);
  }

  if (category && category !== 'all') {
    query += ' AND category = ?';
    params.push(category);
  }

  if (search) {
    query += ' AND (title LIKE ? OR insight LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  // Sorting
  if (sort === 'views') {
    query += ' ORDER BY views DESC';
  } else {
    query += ' ORDER BY created_at DESC';
  }

  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.DB.prepare(query).bind(...params).all();

  // Get total count for pagination
  let countQuery = 'SELECT COUNT(*) as total FROM articles WHERE 1=1';
  const countParams = [];
  if (source && source !== 'all') {
    countQuery += ' AND source = ?';
    countParams.push(source);
  }
  if (category && category !== 'all') {
    countQuery += ' AND category = ?';
    countParams.push(category);
  }
  if (search) {
    countQuery += ' AND (title LIKE ? OR insight LIKE ?)';
    countParams.push(`%${search}%`, `%${search}%`);
  }

  const countResult = await env.DB.prepare(countQuery).bind(...countParams).first();

  // Parse summary_json for each article
  const articles = (result.results || []).map(formatArticle);

  return jsonResponse({
    articles,
    total: countResult?.total || 0,
    limit,
    offset,
  });
}

/**
 * GET /api/articles/:id
 */
async function getArticleById(id, env) {
  // Increment view count
  await env.DB.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').bind(id).run();

  const article = await env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();

  if (!article) {
    return jsonResponse({ error: 'Article not found' }, 404);
  }

  return jsonResponse(formatArticle(article));
}

/**
 * GET /api/sources — source statistics
 */
async function getSources(env) {
  const result = await env.DB.prepare(`
    SELECT source, COUNT(*) as count
    FROM articles
    GROUP BY source
    ORDER BY count DESC
  `).all();

  return jsonResponse(result.results || []);
}

/**
 * GET /api/highlights — top articles for today
 */
async function getHighlights(env) {
  const result = await env.DB.prepare(`
    SELECT * FROM articles
    ORDER BY views DESC, created_at DESC
    LIMIT 3
  `).all();

  const articles = (result.results || []).map(formatArticle);
  return jsonResponse(articles);
}

/**
 * POST /api/auth/signup
 */
async function handleSignup(request, env) {
  const { email, password, name } = await request.json();
  if (!email || !password) return jsonResponse({ error: 'Email and password required' }, 400);

  try {
    const result = await env.DB.prepare(
      'INSERT INTO users (email, password, name) VALUES (?, ?, ?)'
    ).bind(email, password, name || email.split('@')[0]).run();

    const userId = result.meta.last_row_id;
    
    // Create default settings
    await env.DB.prepare('INSERT INTO user_settings (user_id) VALUES (?)').bind(userId).run();

    return jsonResponse({ success: true, message: 'User created' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return jsonResponse({ error: 'Email already exists' }, 409);
    throw err;
  }
}

/**
 * POST /api/auth/login
 */
async function handleLogin(request, env) {
  const { email, password } = await request.json();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND password = ?')
    .bind(email, password).first();

  if (!user) return jsonResponse({ error: 'Invalid credentials' }, 401);

  const token = await generateToken(user, env);
  return jsonResponse({ 
    success: true, 
    token,
    user: { id: user.id, email: user.email, name: user.name } 
  });
}

/**
 * GET /api/user/profile
 */
async function getUserProfile(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const settings = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?')
    .bind(user.id).first();

  return jsonResponse({
    user: { id: user.id, email: user.email, name: user.name },
    settings: settings || {}
  });
}

/**
 * POST /api/user/settings
 */
async function updateUserSettings(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  const { dark_mode, notify_time_start, notify_time_end, save_news_alert, partnership_alert, report_alert } = body;

  await env.DB.prepare(`
    UPDATE user_settings SET
      dark_mode = ?,
      notify_time_start = ?,
      notify_time_end = ?,
      save_news_alert = ?,
      partnership_alert = ?,
      report_alert = ?
    WHERE user_id = ?
  `).bind(
    dark_mode ? 1 : 0,
    notify_time_start || '09:00',
    notify_time_end || '21:00',
    save_news_alert || 'all',
    partnership_alert ? 1 : 0,
    report_alert ? 1 : 0,
    user.id
  ).run();

  return jsonResponse({ success: true });
}

/**
 * Simple Token Auth Helper
 */
async function generateToken(user, env) {
  // In a real app, use JWT. For now, a simple signed string.
  const data = `${user.id}:${user.email}:${Date.now()}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', 
    encoder.encode(env.JWT_SECRET || env.ADMIN_SECRET || ''), 
    { name: 'HMAC', hash: 'SHA-256' }, 
    false, 
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const sigHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  return btoa(`${data}.${sigHex}`);
}

async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  
  const token = authHeader.split(' ')[1];
  try {
    const decoded = atob(token);
    const [data, sigHex] = decoded.split('.');
    const [id, email, timestamp] = data.split(':');

    // Verify signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', 
      encoder.encode(env.JWT_SECRET || env.ADMIN_SECRET || ''), 
      { name: 'HMAC', hash: 'SHA-256' }, 
      false, 
      ['verify']
    );
    
    const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(data));

    if (!isValid) return null;

    // Check expiration (24h)
    if (Date.now() - parseInt(timestamp) > 86400000) return null;

    return { id: parseInt(id), email };
  } catch {
    return null;
  }
}

/**
 * Format a raw DB article row for API response.
 */
function formatArticle(row) {
  let summaryPoints = [];
  try {
    summaryPoints = JSON.parse(row.summary_json || '[]');
  } catch {
    summaryPoints = [];
  }

  // Calculate relative time
  const timeAgo = getTimeAgo(row.created_at || row.pub_date);

  return {
    id: row.id,
    source: row.source,
    cat: row.category,
    catClass: row.cat_class || 'tag-convention',
    type: row.article_type || '분석',
    time: timeAgo,
    views: row.views || 0,
    title: row.title,
    titleKo: row.title_ko || row.title,
    url: row.link,
    author: row.author || row.source,
    date: row.pub_date ? row.pub_date.substring(0, 10) : '',
    summaryPoints,
    insight: row.insight || '',
    enText: row.content_en || '',
    koText: row.content_ko || '',
  };
}

/**
 * Calculate relative time string in Korean.
 */
function getTimeAgo(dateStr) {
  if (!dateStr) return '방금 전';
  
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '방금 전';
  if (minutes < 60) return `${minutes}분 전`;
  if (hours < 24) return `${hours}시간 전`;
  if (days < 7) return `${days}일 전`;
  return dateStr.substring(0, 10);
}

/**
 * 한국어 번역 품질 검증 — gibberish 감지
 * title_ko가 의미 없는 한국어(깨진 번역)인지 판단한다.
 */
function isGibberish(text) {
  if (!text || typeof text !== 'string' || text.trim().length < 2) return true;
  // 영어 그대로 (미번역)
  if (/^[a-zA-Z0-9\s,.\-'"!?:;()&%$#@+=[\]{}|/\\~`^*]+$/.test(text.trim())) return true;
  // 한국어 문자 없음
  if (!/[가-힣]/.test(text)) return true;
  // 유효한 한국어 형태소/단어 존재 여부 확인
  const VALID = /니다|습니다|됩니다|합니다|이다|하다|되다|있다|없다|위한|에서|으로|부터|까지|때문|통해|관련|따라|지속|강화|개최|참가|개선|시장|산업|행사|컨벤션|전시|인센티브|회의|기술|정책|이벤트|발표|계획|성장|증가|글로벌|국제|운영|제공|활용|디지털|리더십|혁신|파트너십|전략|포럼|컨퍼런스|선정|취임|설립|강조|협력|도입|분석|조사|확인|추진|진행|완료|세계|최고|최대|새로운|중요|주요|공식|올해|이번|지난|미래|현재|한국|미국|유럽|아시아|서울|부산|제주|관광|숙박|호텔|리조트|수상|임명|방문|목적지|마케팅|협회|단체|기업|프로그램|서비스|플랫폼|솔루션|데이터|보고서|연구|조직|위원회|리더/;
  return !VALID.test(text);
}

/**
 * Create a JSON response.
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Add CORS headers to a response.
 */
function corsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

/**
 * POST /api/recategorize — keyword 기반으로 기존 기사 카테고리 일괄 재분류
 */
async function recategorizeArticles(url, env) {
  const batchSize = Math.min(parseInt(url.searchParams.get('limit') || '500'), 1000);

  const { guessCategoryHint } = await import('./ollama.js');

  const CAT_CLASS = {
    convention:     'tag-convention',
    exhibition:     'tag-exhibition',
    incentive:      'tag-incentive',
    tech:           'tag-tech',
    sustainability: 'tag-sustainability',
    market:         'tag-market',
    policy:         'tag-policy',
  };

  const rows = await env.DB.prepare(
    'SELECT id, title, content_en FROM articles ORDER BY created_at DESC LIMIT ?'
  ).bind(batchSize).all();

  const articles = rows.results || [];
  let updated = 0;

  for (const row of articles) {
    const catKey = guessCategoryHint(row.title || '', row.content_en || '');
    const catClass = CAT_CLASS[catKey] || 'tag-convention';
    await env.DB.prepare(
      'UPDATE articles SET category = ?, cat_class = ? WHERE id = ?'
    ).bind(catKey, catClass, row.id).run();
    updated++;
  }

  // 카테고리별 분포 집계
  const dist = await env.DB.prepare(
    'SELECT category, COUNT(*) as cnt FROM articles GROUP BY category ORDER BY cnt DESC'
  ).all();

  return jsonResponse({ status: 'ok', updated, distribution: dist.results || [] });
}

/**
 * POST /api/crawl — trigger manual full sync (Raw + AI)
 */
async function triggerCrawl(env) {
  const { fetchAndStoreRawRSS, processAIQueue } = await import('./index.js');
  const rawResult = await fetchAndStoreRawRSS(env);
  const aiResult = await processAIQueue(env, 2);
  return jsonResponse({
    status: 'success',
    raw: rawResult,
    ai: aiResult
  });
}

/**
 * GET /api/test-ollama — Ollama 연결 상태 및 모델 진단
 */
async function testOllama(env) {
  const ollamaUrl = (env.OLLAMA_URL || '').replace(/\/$/, '');
  const model = env.OLLAMA_MODEL || 'qwen2.5:7b';

  if (!ollamaUrl) {
    return jsonResponse({ status: 'error', message: 'OLLAMA_URL not set in environment' });
  }

  const result = { ollamaUrl, model, steps: [] };

  // 1. 연결 확인 (/api/tags)
  try {
    const tagsRes = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!tagsRes.ok) throw new Error(`HTTP ${tagsRes.status}`);
    const tagsData = await tagsRes.json();
    const availableModels = (tagsData.models || []).map(m => m.name);
    result.steps.push({ step: 'connection', status: 'ok', availableModels });

    // 2. 모델 존재 여부 확인
    const modelExists = availableModels.some(m => m.startsWith(model.split(':')[0]));
    result.steps.push({ step: 'model_check', status: modelExists ? 'ok' : 'missing', model, availableModels });

    if (!modelExists) {
      return jsonResponse({
        ...result,
        status: 'error',
        message: `Model "${model}" not found. Available: ${availableModels.join(', ')}. Run: ollama pull ${model}`,
      });
    }
  } catch (err) {
    result.steps.push({ step: 'connection', status: 'error', error: err.message });
    return jsonResponse({
      ...result,
      status: 'error',
      message: `Cannot reach Ollama at ${ollamaUrl}. Is Ollama running? Is the tunnel active?`,
    });
  }

  // 3. 번역 기능 테스트
  try {
    const testRes = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model,
        prompt: 'Translate to Korean. Return ONLY JSON {"title_ko":"..."} Input: "MICE industry growth accelerates in Asia"',
        stream: false,
        format: 'json',
        options: { temperature: 0.1, num_predict: 100 },
      }),
    });
    const testData = await testRes.json();
    const parsed = JSON.parse(testData.response || '{}');
    result.steps.push({ step: 'translation_test', status: 'ok', result: parsed });
    return jsonResponse({ ...result, status: 'ok', message: 'Ollama is working correctly' });
  } catch (err) {
    result.steps.push({ step: 'translation_test', status: 'error', error: err.message });
    return jsonResponse({ ...result, status: 'error', message: 'Translation test failed: ' + err.message });
  }
}
