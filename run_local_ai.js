#!/usr/bin/env node
/**
 * MIK 로컬 AI 처리 스크립트 v2
 * ─────────────────────────────────────────────────────────────────
 * 변경사항:
 *   - 2단계 분리: ① 메타 JSON (title_ko·summary·insight·category)
 *                 ② 번역 텍스트 (별도 plain-text 호출)
 *   - JSON 잘림 방지: content_ko를 메인 JSON에서 제거
 *   - MICE 관련성 사전 체크 (비MICE 기사 즉시 건너뜀)
 *   - 반복 실패 기사 자동 스킵 (세션 내 3회 이상 실패 시 DB 무효화)
 *
 * 실행: node run_local_ai.js
 * 자동: node run_local_ai.js --watch  (30분마다 반복)
 */

const WORKER_URL     = 'https://mik-worker.isg11882.workers.dev';
const OLLAMA_URL     = 'http://localhost:11434';
let   OLLAMA_MODEL   = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const ADMIN_SECRET   = process.env.MIK_SECRET   || 'mik_secret_key_2026';
const BATCH_SIZE     = parseInt(process.env.BATCH_SIZE || '10');
const WATCH_MODE     = process.argv.includes('--watch');
const WATCH_INTERVAL_MIN = 30;

// ── 반복 실패 추적: 기사 ID → 실패 횟수 ──────────────────────────
const failCount = {};
const MAX_FAIL  = 3; // 3번 실패하면 'skip'으로 마킹

// ── MICE 관련성 키워드 필터 (run_local_ai 전용 경량판) ──────────
const MICE_CORE = [
  'mice','meeting','meetings','convention','conferences','exhibition',
  'trade show','tradeshow','incentive','congress','event planner',
  'event planning','event management','business event','corporate event',
  'pcma','mpi ','icca','ufi ','ibtm','imex','iaee','dmi ',
  'pco ','cvb ','dmo ','convention center','convention bureau',
  'hybrid event','virtual event','attendee','delegate','exhibitor',
  'keynote','breakout session','networking','hosted buyer',
  'event tech','eventtech','venue ','venues','show floor',
  'exhibit hall','booth','fam trip','rfp ','dmc ',
  'sustainability in events','green meeting',
];
const MICE_INDUSTRY = [
  'hospitality','hotel meeting','hotel conference','room block',
  'event organizer','event professional','meeting professional',
  'business travel','corporate travel','association meeting',
  'sponsorship','audiovisual','cvent','bizzabo','stova',
  'destination management','site visit','post-event','event roi',
];
const BLOCK_HARD = [
  'stock market','stock exchange','cryptocurrency','bitcoin',
  'criminal arrest','criminal court','recipe','cooking','nfl ','nba ',
  'celebrity gossip','pop star','video game','gaming console','weather forecast',
  'earthquake','hurricane','political election','election result','real estate listing',
  'personal finance','mortgage rate','insurance policy',
  // 완전히 무관한 정치 뉴스 — 구체적으로 변경
  'senate vote','parliament vote','presidential election','presidential campaign',
  'supreme court ruling','myanmar coup','prison sentence','drug possession',
  'military strike','fugitive arrest',
];

function isMiceRelevant(title, content) {
  const txt = ((title || '') + ' ' + (content || '')).toLowerCase();
  let score = 0;
  for (const kw of MICE_CORE)     if (txt.includes(kw)) score += 3;
  for (const kw of MICE_INDUSTRY) if (txt.includes(kw)) score += 2;
  for (const kw of BLOCK_HARD)    if (txt.includes(kw)) score -= 8;
  return score >= 3;
}

const CATEGORY_MAP = {
  convention:     'tag-convention',
  exhibition:     'tag-exhibition',
  incentive:      'tag-incentive',
  tech:           'tag-tech',
  sustainability: 'tag-sustainability',
  market:         'tag-market',
  policy:         'tag-policy',
  // 하위 호환
  bio:            'tag-sustainability',
  general:        'tag-market',
};

// ─────────────────────────────────────────────
// Ollama 호출 — JSON 모드 (메타 전용)
// ─────────────────────────────────────────────
async function callOllamaJSON(prompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
      // 메타만 출력하므로 800토큰이면 충분 (JSON 잘림 방지)
      options: { temperature: 0.1, top_p: 0.9, num_predict: 900 },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const fb = cleaned.indexOf('{');
  const lb = cleaned.lastIndexOf('}');
  if (fb === -1 || lb <= fb) throw new Error(`No JSON in response. Got: ${text.slice(0, 100)}`);
  return JSON.parse(cleaned.slice(fb, lb + 1));
}

// ─────────────────────────────────────────────
// Ollama 호출 — 텍스트 모드 (번역 전용)
// ─────────────────────────────────────────────
async function callOllamaText(prompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.15, top_p: 0.9, num_predict: 2000 },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return (data.response || '').trim();
}

// ─────────────────────────────────────────────
// 카테고리 힌트 산출 (키워드 스코어링)
// ─────────────────────────────────────────────
function guessCategoryHint(title, content) {
  const txt = ((title || '') + ' ' + (content || '')).toLowerCase();
  const scores = { convention:0, exhibition:0, incentive:0, tech:0, sustainability:0, market:0, policy:0 };

  const rules = [
    ['convention',     4, ['congress','pcma','icca ','mpi ','cvb ','pco ','convention center','meeting planner','hosted buyer','association meeting','business event']],
    ['convention',     1, ['conference','meeting','summit','forum','symposium','delegate','convention']],
    ['exhibition',     4, ['trade show','tradeshow','trade fair','ufi ','iaee','show floor','exhibit hall','exhibitor','booth ','pavilion','trade exhibition']],
    ['exhibition',     1, ['exhibition ','expo ','fair ','show ','exhibit ']],
    ['incentive',      4, ['incentive travel','incentive trip','incentive program','dmc ','site global','fam trip','reward travel','incentive group']],
    ['incentive',      2, ['incentive','luxury travel','group travel']],
    ['tech',           4, ['cvent','bizzabo','stova','event app','event platform','virtual event','hybrid event','event software','event tech','ai-powered','registration tech']],
    ['tech',           2, ['technology platform','digital event','livestream','mobile app','qr code']],
    ['sustainability', 4, ['esg','green meeting','carbon neutral','net zero','sustainable event','gmic','carbon offset','zero waste','eco-friendly event']],
    ['sustainability', 1, ['sustainable','green ','carbon','environment']],
    ['market',         4, ['market research','industry report','survey results','forecast','revenue data','statistics','economic impact','market size','benchmark study','report shows','according to research']],
    ['market',         1, ['report','survey','research','data','trend','growth','revenue','forecast','outlook']],
    ['policy',         4, ['government policy','regulation','ministry','legislation','visa policy','certification standard','compliance','grant','subsidy','government support']],
    ['policy',         1, ['policy','regulation','government','law ','official']],
  ];

  for (const [cat, weight, keywords] of rules)
    for (const kw of keywords)
      if (txt.includes(kw)) scores[cat] += weight;

  const priority = ['convention','exhibition','incentive','tech','sustainability','market','policy'];
  let best = 'convention', bestScore = -1;
  for (const cat of priority)
    if (scores[cat] > bestScore) { bestScore = scores[cat]; best = cat; }
  return best;
}

// ─────────────────────────────────────────────
// 기사 분석 — 2단계 분리
// ─────────────────────────────────────────────
async function analyzeArticle(article) {
  const content = (article.content_en || article.title || '').slice(0, 1500);

  // ── Step 1: 메타 JSON (title_ko, category, summary, insight) ──
  const hint = guessCategoryHint(article.title, content);

  const metaPrompt = `You are a MICE industry analyst. Output ONLY this JSON object, nothing else:
{"category":"convention","article_type":"분석","title_ko":"한국어제목","summary_points":["핵심사실1","핵심사실2","핵심사실3"],"insight":"한국PCO/CVB담당자를위한2문장인사이트"}

CATEGORY HINT (keyword analysis says: "${hint}") — follow this unless content clearly contradicts it.
CATEGORY RULES:
- convention    = PCO/PCMA/ICCA, congress/conference, convention center, meeting planner, CVB, hosted buyer
- exhibition    = trade show/expo, booth/exhibitor, UFI/IAEE, show floor, exhibit hall
- incentive     = incentive travel/trip/program, DMC, SITE, fam trip, reward travel
- tech          = Cvent/Bizzabo, event app/platform, virtual/hybrid event tech, AI tools for events
- sustainability= ESG, green meeting, carbon neutral, net zero, sustainable events
- market        = market research, industry report, statistics, forecast, revenue data, economic impact
- policy        = government policy, regulation, ministry, legislation, visa, certification, grant
- Each summary_point: max 40 Korean characters
- insight: max 100 Korean characters
- Output ONLY the JSON object. Start with { and end with }

Article title: ${article.title}
Source: ${article.source || ''}
Content: ${content.slice(0, 700)}`;

  const meta = await callOllamaJSON(metaPrompt);

  // ── Step 2: 한국어 번역 (plain text, JSON 아님) ────────────────
  let content_ko = '';
  try {
    const transPrompt = `MICE 산업 전문 번역가입니다. 아래 영어 기사를 자연스러운 한국어로 번역하세요.
번역문만 출력하고 다른 설명은 하지 마세요.

제목: ${article.title}

${content.slice(0, 1000)}`;

    const raw = await callOllamaText(transPrompt);
    if (raw.length > 30) {
      content_ko = '<p>' + raw.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    }
  } catch (e) {
    // 번역 실패는 무시 (메타는 성공)
  }

  const catKey   = (meta.category || 'market').toLowerCase();
  const catClass = CATEGORY_MAP[catKey] || 'tag-convention';

  return {
    id:             article.id,
    title_ko:       meta.title_ko  || article.title,
    summary_points: Array.isArray(meta.summary_points) ? meta.summary_points : [],
    insight:        meta.insight   || 'done',
    content_ko,
    category:       catKey,
    cat_class:      catClass,
    article_type:   meta.article_type || '분석',
  };
}

// ─────────────────────────────────────────────
// Worker에서 미번역 기사 가져오기
// ─────────────────────────────────────────────
async function fetchPending() {
  const res = await fetch(`${WORKER_URL}/api/pending?limit=${BATCH_SIZE}`);
  if (!res.ok) throw new Error(`Worker /api/pending HTTP ${res.status}`);
  const data = await res.json();
  return data.articles || [];
}

// ─────────────────────────────────────────────
// Worker에 결과 업로드
// ─────────────────────────────────────────────
async function syncToWorker(articles) {
  const res = await fetch(`${WORKER_URL}/api/admin/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_SECRET}`,
    },
    body: JSON.stringify({ articles }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Sync failed HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────
// 비MICE 기사를 DB에서 'skip'으로 마킹
// (다음 pending 쿼리에서 제외됨)
// ─────────────────────────────────────────────
async function skipArticle(id) {
  try {
    await fetch(`${WORKER_URL}/api/admin/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_SECRET}`,
      },
      body: JSON.stringify({
        articles: [{
          id,
          title_ko: '',
          summary_points: [],
          insight: 'skip-non-mice',  // pending 쿼리에서 제외됨
          content_ko: '',
          category: 'market',
          cat_class: 'tag-convention',
          article_type: '뉴스',
        }],
      }),
    });
  } catch {}
}

// ─────────────────────────────────────────────
// 메인 처리 루프
// ─────────────────────────────────────────────
async function runOnce() {
  console.log(`\n[${new Date().toLocaleTimeString('ko-KR')}] ═══ MIK 로컬 AI 처리 시작 ═══`);

  // 1. Ollama 연결 확인 + 모델 자동 선택
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const models = (d.models || []).map(m => m.name);
    if (models.length === 0) { console.error('❌ 설치된 Ollama 모델 없음'); return; }

    const hasModel = models.some(m => m.startsWith(OLLAMA_MODEL.split(':')[0]));
    if (!hasModel) {
      OLLAMA_MODEL = models[0];
      console.log(`⚠️  모델 자동 선택: ${OLLAMA_MODEL}`);
    }
    console.log(`✅ Ollama OK | 모델: ${OLLAMA_MODEL}`);
  } catch (e) {
    console.error(`❌ Ollama 연결 실패: ${e.message}`);
    return;
  }

  // 2. 미번역 기사 가져오기
  let pending;
  try {
    pending = await fetchPending();
    console.log(`📥 미번역 기사: ${pending.length}건`);
    if (pending.length === 0) { console.log('✅ 처리할 기사 없음'); return; }
  } catch (e) {
    console.error(`❌ Worker API 오류: ${e.message}`); return;
  }

  const results = [];
  let skippedNonMice = 0;
  let skippedFail    = 0;

  for (let i = 0; i < pending.length; i++) {
    const a      = pending[i];
    const prefix = `[${i+1}/${pending.length}]`;
    const short  = (a.title || '').slice(0, 50);

    // ── MICE 관련성 사전 체크 ────────────────────────────────────
    if (!isMiceRelevant(a.title, a.content_en)) {
      console.log(`${prefix} ⛔ 비MICE 스킵: ${short}`);
      await skipArticle(a.id);
      skippedNonMice++;
      continue;
    }

    // ── 반복 실패 기사 스킵 ──────────────────────────────────────
    if ((failCount[a.id] || 0) >= MAX_FAIL) {
      console.log(`${prefix} ⚠️  반복실패 스킵(${failCount[a.id]}회): ${short}`);
      await skipArticle(a.id);
      skippedFail++;
      continue;
    }

    process.stdout.write(`${prefix} ${short}... `);
    try {
      const result = await analyzeArticle(a);
      results.push(result);
      console.log(`✅ ${result.category} | ${result.title_ko.slice(0, 35)}`);
      // 성공 시 실패 카운터 리셋
      delete failCount[a.id];
    } catch (e) {
      failCount[a.id] = (failCount[a.id] || 0) + 1;
      console.log(`❌ [${failCount[a.id]}/${MAX_FAIL}] ${e.message.slice(0, 80)}`);
    }

    if (i < pending.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  // 3. 결과 업로드
  if (skippedNonMice > 0) console.log(`⛔ 비MICE 기사 ${skippedNonMice}건 제외`);
  if (skippedFail    > 0) console.log(`⚠️  반복실패 ${skippedFail}건 스킵`);

  if (results.length === 0) {
    console.log('⚠️  성공한 처리 결과 없음');
  } else {
    try {
      const sync = await syncToWorker(results);
      console.log(`\n🚀 Worker 업데이트 완료: ${sync.updated}/${sync.total}건`);
    } catch (e) {
      console.error(`❌ 업로드 실패: ${e.message}`);
    }
  }

  console.log(`[${new Date().toLocaleTimeString('ko-KR')}] ═══ 처리 완료 ═══\n`);
}

// ─────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────
async function main() {
  if (WATCH_MODE) {
    console.log(`🔄 Watch 모드 — ${WATCH_INTERVAL_MIN}분마다 자동 실행 (중지: Ctrl+C)\n`);
    await runOnce();
    setInterval(runOnce, WATCH_INTERVAL_MIN * 60 * 1000);
  } else {
    await runOnce();
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
