/**
 * MIK REST API Handler
 * Provides endpoints for the frontend to fetch articles data from D1.
 */

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

    // POST /api/crawl — trigger manual crawl (Full cycle: Raw + AI)
    if (path === '/api/crawl' && request.method === 'POST') {
      return corsResponse(await triggerCrawl(env));
    }
    
    // POST /api/crawl/raw — trigger manual raw fetch only
    if (path === '/api/crawl/raw' && request.method === 'POST') {
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
        ORDER BY created_at DESC LIMIT ?
      `).bind(limit).all();
      return corsResponse(jsonResponse({ articles: result.results || [], count: (result.results||[]).length }));
    }

    // POST /api/admin/sync — 로컬 Ollama 처리 결과 업로드
    if (path === '/api/admin/sync' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '').trim();
      const secret = env.JWT_SECRET || 'mik_secret_key_2026';
      if (token !== secret) {
        return corsResponse(jsonResponse({ error: 'Unauthorized' }, 401));
      }
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

    // GET /api/process-ai — manually trigger AI queue from browser
    if (path === '/api/process-ai' && request.method === 'GET') {
      console.log('[API] Processing AI Queue manually (GET)...');
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const { processAIQueue } = await import('./index.js');
      const result = await processAIQueue(env, limit);
      return corsResponse(jsonResponse(result));
    }

    // POST /api/process-ai — manually process pending AI queue
    if (path === '/api/process-ai' && request.method === 'POST') {
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
    encoder.encode(env.JWT_SECRET || 'mik_secret_key_2026'), 
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
      encoder.encode(env.JWT_SECRET || 'mik_secret_key_2026'), 
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
