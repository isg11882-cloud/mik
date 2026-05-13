/**
 * MIK REST API Handler
 */

export async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return corsResponse(new Response(null, { status: 204 }));
  }

  try {
    if (path === '/api/articles' && request.method === 'GET') return corsResponse(await getArticles(url, env));

    const articleMatch = path.match(/^\/api\/articles\/(\d+)$/);
    if (articleMatch && request.method === 'GET') return corsResponse(await getArticleById(parseInt(articleMatch[1]), env));

    if (path === '/api/sources' && request.method === 'GET') return corsResponse(await getSources(env));
    if (path === '/api/highlights' && request.method === 'GET') return corsResponse(await getHighlights(env));
    if (path === '/api/crawl' && request.method === 'POST') return corsResponse(await triggerCrawl(env));

    if (path === '/api/crawl/raw' && request.method === 'POST') {
      const { fetchAndStoreRawRSS } = await import('./index.js');
      return corsResponse(jsonResponse(await fetchAndStoreRawRSS(env)));
    }

    if (path === '/api/test-ollama' && request.method === 'GET') return corsResponse(await testOllama(env));

    if (path === '/api/repair/titles' && request.method === 'POST') {
      const { repairTitles } = await import('./index.js');
      return corsResponse(jsonResponse(await repairTitles(env)));
    }

    if (path === '/api/process-ai' && request.method === 'POST') {
      const limit = parseInt(new URL(request.url).searchParams.get('limit') || '5');
      const { processAIQueue } = await import('./index.js');
      return corsResponse(jsonResponse(await processAIQueue(env, limit)));
    }

    if (path === '/api/auth/signup' && request.method === 'POST') return corsResponse(await handleSignup(request, env));
    if (path === '/api/auth/login' && request.method === 'POST') return corsResponse(await handleLogin(request, env));
    if (path === '/api/user/profile' && request.method === 'GET') return corsResponse(await getUserProfile(request, env));
    if (path === '/api/user/settings' && request.method === 'POST') return corsResponse(await updateUserSettings(request, env));

    return corsResponse(jsonResponse({ error: 'Not Found' }, 404));
  } catch (err) {
    console.error('[API] Error:', err.message);
    return corsResponse(jsonResponse({ error: 'Internal Server Error', detail: err.message }, 500));
  }
}

async function getArticles(url, env) {
  const source = url.searchParams.get('source');
  const category = url.searchParams.get('category');
  const search = url.searchParams.get('search');
  const sort = url.searchParams.get('sort') || 'latest';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  let query = 'SELECT * FROM articles WHERE 1=1';
  const params = [];
  if (source && source !== 'all') { query += ' AND source = ?'; params.push(source); }
  if (category && category !== 'all') { query += ' AND category = ?'; params.push(category); }
  if (search) { query += ' AND (title LIKE ? OR title_ko LIKE ? OR insight LIKE ?)'; params.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
  query += sort === 'views' ? ' ORDER BY views DESC' : ' ORDER BY created_at DESC';
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.DB.prepare(query).bind(...params).all();

  let countQuery = 'SELECT COUNT(*) as total FROM articles WHERE 1=1';
  const countParams = [];
  if (source && source !== 'all') { countQuery += ' AND source = ?'; countParams.push(source); }
  if (category && category !== 'all') { countQuery += ' AND category = ?'; countParams.push(category); }
  if (search) { countQuery += ' AND (title LIKE ? OR title_ko LIKE ? OR insight LIKE ?)'; countParams.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
  const countResult = await env.DB.prepare(countQuery).bind(...countParams).first();

  return jsonResponse({ articles: (result.results || []).map(formatArticle), total: countResult?.total || 0, limit, offset });
}

async function getArticleById(id, env) {
  await env.DB.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').bind(id).run();
  const article = await env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
  if (!article) return jsonResponse({ error: 'Article not found' }, 404);
  return jsonResponse(formatArticle(article));
}

async function getSources(env) {
  const result = await env.DB.prepare('SELECT source, COUNT(*) as count FROM articles GROUP BY source ORDER BY count DESC').all();
  return jsonResponse(result.results || []);
}

async function getHighlights(env) {
  const result = await env.DB.prepare('SELECT * FROM articles ORDER BY views DESC, created_at DESC LIMIT 3').all();
  return jsonResponse((result.results || []).map(formatArticle));
}

async function handleSignup(request, env) {
  const { email, password, name } = await request.json();
  if (!email || !password) return jsonResponse({ error: 'Email and password required' }, 400);
  try {
    const result = await env.DB.prepare('INSERT INTO users (email, password, name) VALUES (?, ?, ?)').bind(email, password, name || email.split('@')[0]).run();
    await env.DB.prepare('INSERT INTO user_settings (user_id) VALUES (?)').bind(result.meta.last_row_id).run();
    return jsonResponse({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return jsonResponse({ error: 'Email already exists' }, 409);
    throw err;
  }
}

async function handleLogin(request, env) {
  const { email, password } = await request.json();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND password = ?').bind(email, password).first();
  if (!user) return jsonResponse({ error: 'Invalid credentials' }, 401);
  const token = await generateToken(user, env);
  return jsonResponse({ success: true, token, user: { id: user.id, email: user.email, name: user.name } });
}

async function getUserProfile(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
  const settings = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(user.id).first();
  return jsonResponse({ user: { id: user.id, email: user.email, name: user.name }, settings: settings || {} });
}

async function updateUserSettings(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
  const { dark_mode, notify_time_start, notify_time_end, save_news_alert, partnership_alert, report_alert } = await request.json();
  await env.DB.prepare('UPDATE user_settings SET dark_mode=?,notify_time_start=?,notify_time_end=?,save_news_alert=?,partnership_alert=?,report_alert=? WHERE user_id=?')
    .bind(dark_mode?1:0, notify_time_start||'09:00', notify_time_end||'21:00', save_news_alert||'all', partnership_alert?1:0, report_alert?1:0, user.id).run();
  return jsonResponse({ success: true });
}

async function generateToken(user, env) {
  const data = user.id+':'+user.email+':'+Date.now();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.JWT_SECRET||'mik_secret_key_2026'), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const sigHex = Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');
  return btoa(data+'.'+sigHex);
}

async function authenticate(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    const decoded = atob(auth.split(' ')[1]);
    const lastDot = decoded.lastIndexOf('.');
    const data = decoded.substring(0, lastDot);
    const sigHex = decoded.substring(lastDot + 1);
    const [id, email, timestamp] = data.split(':');
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.JWT_SECRET||'mik_secret_key_2026'), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
    const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g).map(b=>parseInt(b,16)));
    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(data));
    if (!isValid || Date.now() - parseInt(timestamp) > 86400000) return null;
    return { id: parseInt(id), email };
  } catch { return null; }
}

function formatArticle(row) {
  let summaryPoints = [];
  try { summaryPoints = JSON.parse(row.summary_json || '[]'); } catch {}
  return {
    id: row.id, source: row.source, cat: row.category,
    catClass: row.cat_class || 'tag-convention', type: row.article_type || '분석',
    time: getTimeAgo(row.created_at || row.pub_date), views: row.views || 0,
    title: row.title, titleKo: row.title_ko || row.title,
    url: row.link, author: row.author || row.source,
    date: (row.pub_date || '').substring(0, 10),
    summaryPoints, insight: row.insight || '',
    enText: row.content_en || '', koText: row.content_ko || '',
  };
}

function getTimeAgo(dateStr) {
  if (!dateStr) return '방금 전';
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff/60000), h = Math.floor(diff/3600000), d = Math.floor(diff/86400000);
  if (m < 1) return '방금 전';
  if (m < 60) return m+'분 전';
  if (h < 24) return h+'시간 전';
  if (d < 7) return d+'일 전';
  return (dateStr||'').substring(0,10);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function corsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, headers });
}

async function triggerCrawl(env) {
  const { fetchAndStoreRawRSS, processAIQueue } = await import('./index.js');
  const rawResult = await fetchAndStoreRawRSS(env);
  const aiResult = await processAIQueue(env, 2);
  return jsonResponse({ status: 'success', raw: rawResult, ai: aiResult });
}

async function testOllama(env) {
  const ollamaUrl = (env.OLLAMA_URL || '').replace(/\/$/, '');
  const model = env.OLLAMA_MODEL || 'qwen2.5:7b';
  if (!ollamaUrl) return jsonResponse({ status: 'error', message: 'OLLAMA_URL not set' });

  const result = { ollamaUrl, model, steps: [] };

  try {
    const tagsRes = await fetch(ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(8000) });
    if (!tagsRes.ok) throw new Error('HTTP ' + tagsRes.status);
    const tagsData = await tagsRes.json();
    const available = (tagsData.models || []).map(m => m.name);
    result.steps.push({ step: 'connection', status: 'ok', available });

    const modelOk = available.some(m => m.startsWith(model.split(':')[0]));
    result.steps.push({ step: 'model_check', status: modelOk ? 'ok' : 'missing', model });

    if (!modelOk) {
      return jsonResponse({ ...result, status: 'error', message: 'Model not found. Run: ollama pull ' + model + ' | Available: ' + available.join(', ') });
    }
  } catch (err) {
    result.steps.push({ step: 'connection', status: 'error', error: err.message });
    return jsonResponse({ ...result, status: 'error', message: 'Cannot reach Ollama. Is it running? Is tunnel active? Error: ' + err.message });
  }

  try {
    const res = await fetch(ollamaUrl + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model, prompt: 'Return ONLY JSON {"title_ko":"MICE 산업"} no other text', stream: false, format: 'json', options: { num_predict: 50 } }),
    });
    const d = await res.json();
    const parsed = JSON.parse(d.response || '{}');
    result.steps.push({ step: 'translate_test', status: 'ok', result: parsed });
    return jsonResponse({ ...result, status: 'ok', message: 'Ollama working correctly!' });
  } catch (err) {
    result.steps.push({ step: 'translate_test', status: 'error', error: err.message });
    return jsonResponse({ ...result, status: 'error', message: 'Translation test failed: ' + err.message });
  }
}
