#!/usr/bin/env node
/**
 * MIK 로컬 AI 처리 스크립트 v3
 * ──────────────────────────────────────────────────────────────────
 * 변경사항 (v3):
 *  - qwen3.5-9b 전제 (--no-thinking 없이 실행)
 *  - Timeout: JSON 180초, 텍스트 120초 (9B 모델 생성 시간 여유 확보)
 *  - System Prompt에 JSON Schema 명시 + Few-shot 예시 삽입
 *  - JSON 추출: Regex 기반 다단계 폴백
 *    1순위: 응답에서 JSON 블록 추출
 *    2순위: 잘린 JSON 자동 복구
 *    3순위: key=value 텍스트 파싱 폴백
 *  - 한국어 품질 검증 강화 (형태소 + 토큰 수)
 *  - 배치 간 딜레이 1초 (모델 과부하 방지)
 *
 * 실행:
 *   rapid-mlx serve qwen3.5-9b --served-model-name default --no-thinking
 *   node run_local_ai.js                  # 1회 처리
 *   node run_local_ai.js --watch          # 30분 간격 반복
 *   node run_local_ai.js --diagnose       # 연결 진단
 *   node run_local_ai.js --fix-gibberish  # 깨진 번역 스캔+초기화+재번역
 *   node run_local_ai.js --reset          # 오류 기사 초기화
 *   node run_local_ai.js --nuclear        # 전체 재번역
 * ──────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────────
const WORKER_URL          = 'https://mik-worker.isg11882.workers.dev';
const MLX_URL             = process.env.MLX_URL    || 'http://localhost:8000/v1';
const MLX_MODEL           = process.env.MLX_MODEL  || 'default';
const ADMIN_SECRET        = process.env.MIK_SECRET || 'mik_secret_key_2026';
const BATCH_SIZE          = parseInt(process.env.BATCH_SIZE || '10');
const WATCH_INTERVAL_MIN  = 30;

// 타임아웃 (ms) — --no-thinking 모드 기준 (JSON만 생성, ~20-40초 예상)
const TIMEOUT_JSON  =  90_000; // 90초 (JSON 생성)
const TIMEOUT_TEXT  =  90_000; // 90초 (텍스트 번역/요약)
const TIMEOUT_SHORT =   5_000; // 5초 (헬스체크)

const WATCH_MODE         = process.argv.includes('--watch');
const DIAGNOSE_MODE      = process.argv.includes('--diagnose');
const RESET_MODE         = process.argv.includes('--reset');
const NUCLEAR_MODE       = process.argv.includes('--nuclear');
const FIX_GIBBERISH_MODE = process.argv.includes('--fix-gibberish');

// 반복 실패 추적
const failCount = {};
const MAX_FAIL  = 3;

// ─────────────────────────────────────────────────────────────────
// 카테고리 맵
// ─────────────────────────────────────────────────────────────────
const CATEGORY_MAP = {
  convention:     'tag-convention',
  exhibition:     'tag-exhibition',
  incentive:      'tag-incentive',
  tech:           'tag-tech',
  sustainability: 'tag-sustainability',
  market:         'tag-market',
  policy:         'tag-policy',
  general:        'tag-market',
  bio:            'tag-sustainability',
};

const VALID_CATEGORIES = new Set(Object.keys(CATEGORY_MAP));

// ─────────────────────────────────────────────────────────────────
// MICE 관련성 필터
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// 1차 룰베이스 카테고리 힌트
// ─────────────────────────────────────────────────────────────────
function guessCategoryHint(title, content) {
  const txt = ((title || '') + ' ' + (content || '')).toLowerCase();
  const scores = { convention:0, exhibition:0, incentive:0, tech:0, sustainability:0, market:0, policy:0 };

  const RULES = [
    ['convention',     5, ['pcma','icca','mpi ','cvb ','pco ','convention center','convention bureau','meeting planner','hosted buyer','association meeting','corporate meeting']],
    ['convention',     2, ['congress','conference','summit','convention','delegate','association event','business event','annual meeting','event planner']],
    ['convention',     1, ['meeting','forum','session','attendee']],
    ['exhibition',     5, ['trade show','tradeshow','trade fair','ufi ','iaee','show floor','exhibit hall','exhibitor','booth design','pavilion','expo center']],
    ['exhibition',     2, ['exhibition ','expo ','world expo','international expo','fair ']],
    ['exhibition',     1, ['display','showcase','stand ','booth']],
    ['incentive',      5, ['incentive travel','incentive trip','incentive program','dmc ','site global','fam trip','reward travel','group incentive']],
    ['incentive',      2, ['incentive','luxury travel','group travel','team travel']],
    ['tech',           5, ['cvent','bizzabo','stova','event app','event platform','event software','event tech','virtual event','hybrid event platform','event management software']],
    ['tech',           2, ['technology platform','digital event','livestream event','event automation','event analytics','artificial intelligence']],
    ['tech',           1, ['mobile app','digital','ai tool','tech solution']],
    ['sustainability', 5, ['esg','green meeting','carbon neutral','net zero','sustainable event','gmic','carbon offset','zero waste event','eco-friendly event']],
    ['sustainability', 2, ['sustainable','carbon footprint','renewable energy','waste reduction','environmental impact']],
    ['sustainability', 1, ['green ','carbon','environment','climate']],
    ['market',         5, ['market research','industry report','market forecast','revenue data','market size','benchmark study','industry statistics','market share','economic impact study']],
    ['market',         3, ['report shows','according to research','survey results','industry data','growth rate','market trend','record revenue']],
    ['market',         1, ['report','survey','data','forecast','outlook','statistics','revenue']],
    ['policy',         5, ['government policy','ministry of tourism','visa policy','legislation','certification standard','compliance','grant program','government subsidy']],
    ['policy',         3, ['regulation','ministry','government support','national tourism','government initiative','public sector']],
    ['policy',         1, ['policy','government','law ','official','authority']],
  ];

  for (const [cat, weight, keywords] of RULES)
    for (const kw of keywords)
      if (txt.includes(kw)) scores[cat] += weight;

  const PRIORITY = ['tech','exhibition','incentive','sustainability','convention','policy','market'];
  let best = 'convention', bestScore = 0;
  for (const cat of PRIORITY)
    if (scores[cat] > bestScore) { bestScore = scores[cat]; best = cat; }

  return best;
}

// ─────────────────────────────────────────────────────────────────
// JSON 추출 — 다단계 Regex 폴백
// ─────────────────────────────────────────────────────────────────

/**
 * 모델 응답 텍스트에서 JSON 객체를 추출한다.
 * 1) 코드 펜스(```json ... ```) 내부 추출
 * 2) 첫 '{' ~ 마지막 '}' 직접 추출
 * 3) 잘린 JSON 자동 복구 (괄호 균형 보정)
 * 4) key="value" 패턴 텍스트 파싱 (최후 폴백)
 */
function extractJson(raw) {
  if (!raw) throw new Error('Empty response');

  // 0) thinking 출력 전처리 — JSON 블록 이전의 모든 서술 텍스트 제거
  //    패턴: <think>...</think> 잔여물, "Thinking Process:", "Let me" 등
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')          // think 태그 잔여물
    .replace(/^[\s\S]*?(?=\{|\[|```)/m, (m) => {        // 첫 JSON 전 텍스트 제거
      // '{', '[', '```' 전까지 비JSON 텍스트가 있으면 제거
      if (/^(?:Thinking|Let me|I need|First|Step|To |Here|Based|Now|The |This |For |In |An |A )/i.test(m)) return '';
      return m;
    })
    .trim();

  // 1) 코드 펜스 내부 추출
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate  = fenceMatch ? fenceMatch[1].trim() : cleaned.trim();

  // 2) { ... } 범위 추출
  const fb = candidate.indexOf('{');
  if (fb !== -1) {
    const lb = candidate.lastIndexOf('}');
    if (lb > fb) {
      try {
        return JSON.parse(candidate.slice(fb, lb + 1));
      } catch { /* 3)으로 이동 */ }
    }

    // 3) 잘린 JSON 복구
    let fragment = candidate.slice(fb);
    // 마지막 불완전한 key-value 제거
    fragment = fragment
      .replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/, '')  // 잘린 문자열 값
      .replace(/,\s*"[^"]*"\s*:\s*$/, '')          // 값 없는 key
      .replace(/,\s*$/, '');                        // 마지막 쉼표

    const openBraces   = (fragment.match(/\{/g) || []).length - (fragment.match(/\}/g) || []).length;
    const openBrackets = (fragment.match(/\[/g) || []).length - (fragment.match(/\]/g) || []).length;
    fragment += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));

    try {
      return JSON.parse(fragment);
    } catch { /* 4)으로 이동 */ }
  }

  // 4) key="value" 패턴 텍스트 파싱 (최후 폴백)
  const result = {};
  const kvRegex = /["']?(title_ko|category|insight|summary)["']?\s*[=:]\s*["']([^"'\n]+)["']/gi;
  let m;
  while ((m = kvRegex.exec(raw)) !== null) {
    result[m[1]] = m[2].trim();
  }
  if (Object.keys(result).length > 0) return result;

  throw new Error(`JSON extraction failed. Raw (first 200): ${raw.slice(0, 200)}`);
}

// ─────────────────────────────────────────────────────────────────
// 한국어 품질 검증
// ─────────────────────────────────────────────────────────────────

const MORPHEME_RE = /니다|습니다|됩니다|합니다|세요|이다|하다|되다|있다|없다|위한|에서|으로|부터|까지|때문|통해|관련|따르|지속|강화|개최|참가|개선|시장|산업|행사|컨벤션|전시|인센티브|회의|기술|정책|플랫폼|이벤트|발표|계획|성장|증가|글로벌|국제|운영|제공|통한|활용|통하여|으로써|에의한|이후|이전|최대|최소|향상|확대|기반|중심|대상|활성화|디지털|친환경|지속가능/;

function validateKorean(text, fieldName = 'text') {
  if (!text || typeof text !== 'string') {
    throw new Error(`${fieldName}: empty or non-string`);
  }
  if (!/[가-힣]/.test(text)) {
    throw new Error(`${fieldName}: no Korean characters. Got: "${text.slice(0, 80)}"`);
  }
  // title_ko는 짧을 수 있어서 형태소 검증 완화 — 한국어 글자 2개 이상이면 통과
  const koreanChars = (text.match(/[가-힣]/g) || []).length;
  if (koreanChars < 2) {
    throw new Error(`${fieldName}: too few Korean characters (${koreanChars}). Got: "${text.slice(0, 80)}"`);
  }
  // insight/summary 등 긴 필드만 형태소 검증 적용
  if (fieldName !== 'title_ko' && !MORPHEME_RE.test(text)) {
    throw new Error(`${fieldName}: Korean looks like gibberish (no valid morphemes). Got: "${text.slice(0, 80)}"`);
  }
}

// ─────────────────────────────────────────────────────────────────
// rapid-mlx API 호출
// ─────────────────────────────────────────────────────────────────

/**
 * JSON 구조화 응답 요청.
 * System prompt에 JSON Schema를 명시하고 Few-shot 예시를 포함한다.
 * /no_think 를 user 메시지 앞에 붙여 Qwen3의 추론 출력을 억제한다.
 */
async function callMLXJson(systemPrompt, userPrompt) {
  const res = await fetch(`${MLX_URL}/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       MLX_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.1,
      max_tokens:  1200,   // --no-thinking 모드: JSON만 생성하므로 충분
      stream:      false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_JSON),
  });

  if (!res.ok) throw new Error(`MLX HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const raw  = (data.choices?.[0]?.message?.content || '').trim();
  if (!raw) throw new Error('MLX returned empty content');
  return raw;
}

/**
 * 평문 텍스트 응답 요청 (번역, 요약).
 * /no_think 로 추론 출력 억제.
 */
async function callMLXText(systemPrompt, userPrompt) {
  const res = await fetch(`${MLX_URL}/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       MLX_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.2,
      max_tokens:  1500,
      stream:      false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_TEXT),
  });

  if (!res.ok) throw new Error(`MLX HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// ─────────────────────────────────────────────────────────────────
// 기사 분석 — 3단계 분리 (9B 모델 최적화)
// ─────────────────────────────────────────────────────────────────

async function analyzeArticle(article) {
  const content   = (article.content_en || article.title || '').slice(0, 1500);
  const excerpt   = content.slice(0, 500);
  const hint      = guessCategoryHint(article.title, content);

  // ── Step 1: 제목 번역 + 카테고리 + 한줄 시사점 ───────────────────
  // System Prompt: JSON Schema + Few-shot 예시로 출력 형식 고정
  const step1System = `You are a JSON generator for Korean MICE industry news analysis.
Output ONLY valid JSON matching this schema — no explanation, no markdown, no extra text:

Schema:
{
  "title_ko": string,   // Korean translation of the article title (natural, fluent Korean)
  "category": string,   // MUST be exactly one of: convention | exhibition | incentive | tech | sustainability | market | policy
  "insight":  string    // One Korean sentence (15–60 chars) summarizing key takeaway for Korean MICE professionals
}

Example input:
Title: "PCMA Announces Record Attendance at Convening Leaders 2025"
Category hint: convention

Example output:
{"title_ko":"PCMA, 컨비닝 리더스 2025 역대 최고 참가자 수 발표","category":"convention","insight":"PCMA 연례회의 참가자가 역대 최고를 기록하며 글로벌 MICE 산업 회복세를 확인했다."}`;

  const step1User  = `Title: "${article.title}"
Category hint: ${hint}
Excerpt: ${excerpt}`;

  let meta;
  try {
    const raw = await callMLXJson(step1System, step1User);
    meta      = extractJson(raw);
  } catch (e) {
    throw new Error(`[Step1] ${e.message}`);
  }

  // 카테고리 유효성 보정
  const catRaw  = (meta.category || hint).toLowerCase().trim();
  const catKey  = VALID_CATEGORIES.has(catRaw) ? catRaw : hint;
  meta.category = catKey;

  // title_ko 한국어 검증 (실패 시 Step 1 전체를 오류로 처리)
  try {
    validateKorean(meta.title_ko, 'title_ko');
  } catch (e) {
    throw new Error(`[Step1 Validation] ${e.message}`);
  }

  // insight 검증 (실패해도 step1 자체는 성공으로 처리 — 기본값 사용)
  try {
    validateKorean(meta.insight, 'insight');
  } catch {
    meta.insight = `${article.title.slice(0, 30)} 관련 MICE 산업 동향이 주목받고 있다.`;
  }

  // ── Step 2: 3줄 요약 ─────────────────────────────────────────────
  const step2System = `You are a Korean summarizer for MICE industry news.
Write exactly 3 bullet points in Korean. Each point must:
- Be a complete Korean sentence
- Be 20–50 characters long
- Contain valid Korean morphemes
Output ONLY 3 lines, one per line, no numbering, no dashes, no extra text.`;

  const step2User = `Article title: ${article.title}
Excerpt: ${excerpt}`;

  let summary_points = [];
  try {
    const raw   = await callMLXText(step2System, step2User);
    const lines = raw.split('\n')
      .map(l => l.replace(/^[\-\*\d\.\s]+/, '').trim())
      .filter(l => l.length >= 10 && /[가-힣]/.test(l) && MORPHEME_RE.test(l));
    summary_points = lines.slice(0, 3);

    // 라인이 부족하면 기본값으로 보완
    if (summary_points.length < 3) {
      const fallbacks = [
        `${meta.title_ko}에 관한 새로운 소식이 보도됐다.`,
        `MICE 산업 전문가들의 관심을 끌고 있는 주제다.`,
        `관련 업계의 동향을 파악하는 데 중요한 기사다.`,
      ];
      while (summary_points.length < 3) {
        summary_points.push(fallbacks[summary_points.length]);
      }
    }
  } catch {
    summary_points = [
      `${meta.title_ko} 관련 소식이 보도됐다.`,
      `MICE 산업에 영향을 미칠 수 있는 사안이다.`,
      `업계 전문가들의 주목을 받고 있다.`,
    ];
  }

  // ── Step 3: 본문 전체 한국어 번역 (청크 분할) ─────────────────
  // 원문을 1500자 단위 청크로 분할하여 순차 번역 후 결합
  // — 긴 기사도 뒷부분 유실 없이 완전 번역
  const step3System = `You are a professional Korean translator specializing in MICE industry content.
Translate the ENTIRE English text to natural, fluent Korean — do NOT summarize, translate everything.
Output ONLY the Korean translation, no explanation, no original English.`;

  /**
   * 텍스트를 문단(\n\n) 기준으로 maxSize자 이하 청크로 분할한다.
   * 단일 문단이 maxSize를 초과하면 문장 단위로 추가 분할한다.
   */
  function splitIntoChunks(text, maxSize = 1500) {
    const chunks  = [];
    const paras   = text.split(/\n\n+/);
    let   current = '';

    for (const para of paras) {
      const candidate = current ? current + '\n\n' + para : para;
      if (candidate.length <= maxSize) {
        current = candidate;
      } else {
        if (current) chunks.push(current.trim());
        // 단일 문단이 maxSize 초과이면 문장 단위로 재분할
        if (para.length > maxSize) {
          const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
          let buf = '';
          for (const sent of sentences) {
            if ((buf + ' ' + sent).length > maxSize && buf) {
              chunks.push(buf.trim());
              buf = sent;
            } else {
              buf = buf ? buf + ' ' + sent : sent;
            }
          }
          current = buf;
        } else {
          current = para;
        }
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(c => c.length > 0);
  }

  const fullText  = (article.content_en || content);
  const chunks    = splitIntoChunks(fullText, 1500);
  const translated = [];
  let   content_ko = '';

  try {
    for (let ci = 0; ci < chunks.length; ci++) {
      const raw = await callMLXText(step3System, chunks[ci]);
      if (raw && raw.length >= 20 && /[가-힣]/.test(raw)) {
        translated.push(raw.trim());
      }
      // 청크 간 짧은 딜레이 (서버 과부하 방지)
      if (ci < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
    }
    if (translated.length > 0) {
      const merged = translated.join('\n\n');
      content_ko = '<p>' + merged.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    }
  } catch { /* 본문 번역 실패는 무시 */ }

  const catClass = CATEGORY_MAP[catKey] || 'tag-convention';

  return {
    id:             article.id,
    title_ko:       meta.title_ko,
    summary_points,
    insight:        meta.insight,
    content_ko,
    category:       catKey,
    cat_class:      catClass,
    article_type:   '분석',
  };
}

// ─────────────────────────────────────────────────────────────────
// Worker API 통신
// ─────────────────────────────────────────────────────────────────

async function fetchPending() {
  const res = await fetch(`${WORKER_URL}/api/pending?limit=${BATCH_SIZE}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Worker /api/pending HTTP ${res.status}`);
  const data = await res.json();
  return data.articles || [];
}

async function syncToWorker(articles) {
  const res = await fetch(`${WORKER_URL}/api/admin/sync`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${ADMIN_SECRET}`,
    },
    body:   JSON.stringify({ articles }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Sync failed HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

async function skipArticle(id) {
  try {
    await fetch(`${WORKER_URL}/api/admin/sync`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ articles: [{
        id,
        title_ko: '', summary_points: [],
        insight: 'skip-non-mice',
        content_ko: '', category: 'market',
        cat_class: 'tag-convention', article_type: '뉴스',
      }] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* 스킵 실패는 무시 */ }
}

// ─────────────────────────────────────────────────────────────────
// 메인 처리 루프
// ─────────────────────────────────────────────────────────────────

async function runOnce() {
  const stamp = new Date().toLocaleTimeString('ko-KR');
  console.log(`\n[${stamp}] ═══ MIK 로컬 AI 처리 시작 ═══`);

  // 1. rapid-mlx 연결 확인
  try {
    const r = await fetch(`${MLX_URL}/models`, { signal: AbortSignal.timeout(TIMEOUT_SHORT) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d      = await r.json();
    const models = (d.data || []).map(m => m.id);
    console.log(`✅ rapid-mlx OK | 모델: ${models.join(', ') || MLX_MODEL}`);
  } catch (e) {
    console.error(`❌ rapid-mlx 연결 실패: ${e.message}`);
    console.error(`   서버 주소: ${MLX_URL}`);
    console.error(`   실행 명령: rapid-mlx serve qwen3.5-9b --served-model-name default`);
    return;
  }

  // 2. 미번역 기사 가져오기
  let pending;
  try {
    pending = await fetchPending();
    console.log(`📥 미번역 기사: ${pending.length}건`);
    if (pending.length === 0) { console.log('✅ 처리할 기사 없음'); return; }
  } catch (e) {
    console.error(`❌ Worker API 오류: ${e.message}`);
    return;
  }

  const results       = [];
  let skippedNonMice  = 0;
  let skippedFail     = 0;
  let errorCount      = 0;

  for (let i = 0; i < pending.length; i++) {
    const a      = pending[i];
    const prefix = `[${i+1}/${pending.length}]`;
    const short  = (a.title || '').slice(0, 50);

    // MICE 관련성 사전 체크
    if (!isMiceRelevant(a.title, a.content_en)) {
      console.log(`${prefix} ⛔ 비MICE 스킵: ${short}`);
      await skipArticle(a.id);
      skippedNonMice++;
      continue;
    }

    // 반복 실패 기사 스킵
    if ((failCount[a.id] || 0) >= MAX_FAIL) {
      console.log(`${prefix} ⚠️  반복실패 스킵 (${failCount[a.id]}회): ${short}`);
      await skipArticle(a.id);
      skippedFail++;
      continue;
    }

    process.stdout.write(`${prefix} ${short}... `);
    const t0 = Date.now();
    try {
      const result = await analyzeArticle(a);
      results.push(result);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`✅ ${result.category} | ${result.title_ko.slice(0, 40)} (${elapsed}s)`);
      delete failCount[a.id];
    } catch (e) {
      errorCount++;
      failCount[a.id] = (failCount[a.id] || 0) + 1;
      const elapsed   = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`❌ [실패 ${failCount[a.id]}/${MAX_FAIL}] ${e.message.slice(0, 100)} (${elapsed}s)`);
    }

    // 기사 간 1초 딜레이 (모델 과부하 방지)
    if (i < pending.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 3. 결과 업로드
  if (skippedNonMice > 0) console.log(`⛔ 비MICE ${skippedNonMice}건 제외`);
  if (skippedFail    > 0) console.log(`⚠️  반복실패 ${skippedFail}건 스킵`);
  if (errorCount     > 0) console.log(`❌ 처리 실패: ${errorCount}건`);

  if (results.length === 0) {
    console.log('⚠️  성공한 처리 결과 없음');
  } else {
    try {
      const sync = await syncToWorker(results);
      console.log(`\n🚀 Worker 업데이트 완료: ${sync.updated ?? sync.total ?? results.length}건`);
    } catch (e) {
      console.error(`❌ 업로드 실패: ${e.message}`);
    }
  }

  console.log(`[${new Date().toLocaleTimeString('ko-KR')}] ═══ 처리 완료 ═══\n`);
}

// ─────────────────────────────────────────────────────────────────
// Gibberish 수정 모드 — 깨진 번역 스캔 → 초기화 → 재번역
// ─────────────────────────────────────────────────────────────────

async function runFixGibberish() {
  console.log('\n🔎 깨진 번역(Gibberish) 스캔 + 수정 모드\n');

  // ① rapid-mlx 연결 확인
  try {
    const r = await fetch(`${MLX_URL}/models`, { signal: AbortSignal.timeout(TIMEOUT_SHORT) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    console.log('✅ rapid-mlx 연결 확인');
  } catch (e) {
    console.error(`❌ rapid-mlx 연결 실패: ${e.message}`);
    console.error(`   서버 실행: rapid-mlx serve qwen3.5-9b --served-model-name default --no-thinking`);
    return;
  }

  // ② 기사 전체 fetch → 로컬에서 gibberish 감지
  console.log('① 기사 목록 조회 중...');
  const MORPHEME_LOCAL = /니다|습니다|됩니다|합니다|이다|하다|되다|있다|없다|위한|에서|으로|때문|통해|관련|따라|지속|강화|개최|참가|시장|산업|행사|컨벤션|전시|인센티브|회의|기술|정책|이벤트|발표|성장|글로벌|국제|운영|제공|활용|디지털|혁신|전략|포럼|협력|분석|조사|추진|한국|미국|유럽|아시아|관광|호텔|마케팅|협회|기업|프로그램|서비스|플랫폼|데이터/;

  function isGibberishLocal(text) {
    if (!text || text.trim().length < 2) return true;
    if (/^[a-zA-Z0-9\s,.\-'"!?:;()&%$#@+=[\]{}|\/\\~`^*]+$/.test(text.trim())) return true;
    if (!/[가-힣]/.test(text)) return true;
    return !MORPHEME_LOCAL.test(text);
  }

  const gibberishIds = [];
  let totalScanned = 0;
  let offset = 0;
  const PAGE = 100;

  while (true) {
    try {
      const r = await fetch(`${WORKER_URL}/api/articles?limit=${PAGE}&offset=${offset}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const arts = d.articles || [];
      if (arts.length === 0) break;

      for (const a of arts) {
        if (!a.insight || a.insight === 'skip-non-mice') continue; // 미번역/스킵 제외
        totalScanned++;
        if (isGibberishLocal(a.titleKo)) {
          gibberishIds.push(a.id);
          if (gibberishIds.length <= 3)
            console.log(`   예시 ID ${a.id}: "${a.title?.slice(0,40)}" → "${a.titleKo?.slice(0,40)}"`);
        }
      }
      offset += PAGE;
      if (arts.length < PAGE) break;
    } catch (e) {
      console.error(`❌ 기사 조회 실패: ${e.message}`); break;
    }
  }

  console.log(`   스캔 완료: ${totalScanned}건 중 깨진 번역 ${gibberishIds.length}건`);

  if (gibberishIds.length === 0) {
    console.log('\n✅ 깨진 번역 없음 — 모든 기사 정상\n');
    return;
  }

  // ③ 깨진 기사들을 pending으로 초기화 (reset-bad 엔드포인트 활용)
  // scan-gibberish 엔드포인트가 없으면 nuclear reset으로 폴백
  console.log(`\n② ${gibberishIds.length}건 초기화 중...`);

  // scan-gibberish 시도
  let resetCount = 0;
  try {
    const r = await fetch(`${WORKER_URL}/api/admin/scan-gibberish`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_SECRET}` },
      body:    JSON.stringify({ fix: true }),
      signal:  AbortSignal.timeout(60_000),
    });
    if (r.ok) {
      const d = await r.json();
      resetCount = d.reset || 0;
      console.log(`✅ scan-gibberish로 ${resetCount}건 초기화 완료`);
    } else {
      throw new Error(`HTTP ${r.status}`);
    }
  } catch {
    // 폴백: nuclear reset (번역된 모든 기사 초기화)
    console.log('   scan-gibberish 미배포 — reset-bad(nuclear)로 전체 초기화...');
    try {
      const r = await fetch(`${WORKER_URL}/api/admin/reset-bad`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_SECRET}` },
        body:    JSON.stringify({ nuclear: true }),
        signal:  AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
      const d = await r.json();
      resetCount = d.reset || 0;
      console.log(`✅ 전체 초기화 완료: ${resetCount}건 → pending`);
    } catch (e2) {
      console.error(`❌ 초기화 실패: ${e2.message}`);
      return;
    }
  }

  // ④ 재번역 시작
  console.log('\n③ 초기화된 기사 재번역 시작...\n');
  await runOnce();
}

// ─────────────────────────────────────────────────────────────────
// 진단 모드
// ─────────────────────────────────────────────────────────────────

async function runDiagnose() {
  console.log('\n🔍 MIK 진단 모드\n');

  // ① rapid-mlx 연결
  console.log('① rapid-mlx 연결 확인...');
  try {
    const r      = await fetch(`${MLX_URL}/models`, { signal: AbortSignal.timeout(TIMEOUT_SHORT) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d      = await r.json();
    const models = (d.data || []).map(m => m.id);
    console.log(`  ✅ 정상 | 모델: ${models.join(', ') || MLX_MODEL}`);
  } catch (e) {
    console.log(`  ❌ 실패: ${e.message}`);
    console.log(`  → 실행: rapid-mlx serve qwen3.5-9b --served-model-name default`);
  }

  // ② Worker /api/pending
  console.log('② Worker /api/pending 확인...');
  try {
    const r = await fetch(`${WORKER_URL}/api/pending?limit=3`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
    const d = await r.json();
    console.log(`  ✅ pending 기사: ${d.count}건`);
    if (d.articles?.length > 0)
      console.log(`  예시: [${d.articles[0].id}] ${d.articles[0].title?.slice(0, 60)}`);
  } catch (e) {
    console.log(`  ❌ 실패: ${e.message}`);
  }

  // ③ Worker /api/articles
  console.log('③ Worker /api/articles 확인...');
  try {
    const r = await fetch(`${WORKER_URL}/api/articles?limit=3`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d    = await r.json();
    const arts = d.articles || d;
    console.log(`  ✅ 총 ${d.total}건, 반환: ${arts.length}건`);
    if (arts.length > 0)
      console.log(`  예시: [${arts[0].id}] ${arts[0].title?.slice(0, 60)}`);
  } catch (e) {
    console.log(`  ❌ 실패: ${e.message}`);
  }

  // ④ JSON 생성 테스트 (Few-shot 프롬프트)
  console.log('④ rapid-mlx JSON 생성 테스트...');
  try {
    const systemP = `You are a JSON generator. Output ONLY valid JSON, no other text.
Schema: {"title_ko": string, "category": string, "insight": string}`;
    const userP   = `Title: "Global MICE Market Expected to Grow 15% in 2026"
Category hint: market
Excerpt: Industry analysts predict strong recovery.`;

    const raw    = await callMLXJson(systemP, userP);
    const parsed = extractJson(raw);
    console.log(`  ✅ JSON 정상 생성:`);
    console.log(`     title_ko: ${parsed.title_ko}`);
    console.log(`     category: ${parsed.category}`);
    console.log(`     insight:  ${parsed.insight}`);
    try { validateKorean(parsed.title_ko, 'title_ko'); console.log('  ✅ 한국어 품질 검증 통과'); }
    catch (ve) { console.log(`  ⚠️  한국어 검증 경고: ${ve.message}`); }
  } catch (e) {
    console.log(`  ❌ JSON 생성 실패: ${e.message}`);
    console.log('  → --no-thinking 없이 서버를 재시작하세요:');
    console.log('     rapid-mlx serve qwen3.5-9b --served-model-name default --no-thinking');
  }

  console.log('\n✅ 진단 완료\n');
}

// ─────────────────────────────────────────────────────────────────
// 리셋 모드
// ─────────────────────────────────────────────────────────────────

async function runReset(nuclear = false) {
  const label = nuclear ? '☢️  전체 재번역 초기화 (nuclear)' : '🔄 번역 오류 기사 초기화';
  console.log(`\n${label}...\n`);
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/reset-bad`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${ADMIN_SECRET}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ nuclear }),
      signal:  AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    console.log(`✅ ${data.reset}건 초기화 완료 — 번역을 시작합니다...\n`);
    await runOnce();
  } catch (e) {
    console.error(`❌ 초기화 실패: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────────────────────────

async function main() {
  if (DIAGNOSE_MODE)      { await runDiagnose(); return; }
  if (NUCLEAR_MODE)       { await runReset(true); return; }
  if (RESET_MODE)         { await runReset(false); return; }
  if (FIX_GIBBERISH_MODE) { await runFixGibberish(); return; }

  if (WATCH_MODE) {
    console.log(`🔄 Watch 모드 — 이전 배치 완료 후 ${WATCH_INTERVAL_MIN}분 대기 (중지: Ctrl+C)\n`);
    const loop = async () => {
      await runOnce(); // 완전히 끝날 때까지 기다림
      console.log(`⏳ ${WATCH_INTERVAL_MIN}분 후 재실행...`);
      setTimeout(loop, WATCH_INTERVAL_MIN * 60 * 1000); // 끝난 후 대기
    };
    await loop();
  } else {
    await runOnce();
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
