/**
 * MIK MICE Relevance Filter
 * ─────────────────────────────────────────────────────────────────────────
 * PhD-level 산업 특화 필터.
 * 기사 제목·본문을 스캔해 MICE 관련성 점수를 산출하고,
 * 임계값 미달 기사를 저장 전 차단한다.
 *
 * 점수 체계:
 *   핵심 키워드 (×3) — MICE 고유 용어
 *   산업 키워드 (×2) — 관련 협회·이벤트·인프라
 *   컨텍스트 키워드 (×1) — 주변 용어 (단독으론 부족)
 *   차단 키워드    (×-5) — 명백히 무관한 영역
 *
 * 최소 저장 임계값: MIN_SCORE = 3
 */

// ── 핵심 MICE 용어 (weight: 3) ────────────────────────────────────────────
const CORE_TERMS = [
  'mice', 'meeting', 'meetings', 'convention', 'conventions',
  'conference', 'conferences', 'exhibition', 'exhibitions',
  'trade show', 'tradeshow', 'trade fair', 'tradefair',
  'incentive travel', 'incentive trip', 'incentive program',
  'congress', 'expo ', 'exposition',
  'event planner', 'event planning', 'event management',
  'meeting planner', 'meeting planning', 'meeting management',
  'business event', 'business events',
  'corporate event', 'corporate meeting',
  'association meeting', 'annual meeting',
  'pcma', 'mpi ', 'icca ', 'ufi ', 'ibtm', 'imex', 'site global',
  'iaee', 'iacvb', 'dmai', 'destinations international',
  'pco ', 'cvb ', 'dmo ', 'convention bureau',
  'convention center', 'convention centre',
  'meeting room', 'ballroom', 'banquet hall',
  'hybrid event', 'virtual event', 'in-person event',
  'event technology', 'event tech', 'eventtech',
  'attendee', 'attendees', 'delegate', 'delegates',
  'registration', 'exhibitor', 'exhibitors',
  'keynote speaker', 'breakout session', 'networking event',
  'hosted buyer', 'appointment-based',
  'sustainability in events', 'green meetings',
  'meeting design', 'meeting experience',
  'incentive destination', 'site inspection',
];

// ── 산업 연관 키워드 (weight: 2) ──────────────────────────────────────────
const INDUSTRY_TERMS = [
  'hospitality industry', 'hospitality sector',
  'venue', 'venues', 'venue management', 'venue sourcing',
  'hotel meeting', 'hotel conference', 'resort meeting',
  'room block', 'room nights', 'group booking',
  'event organizer', 'event organiser', 'organizer',
  'pcma convene', 'smartmeetings', 'skift meetings',
  'meeting professional', 'event professional',
  'tradeshow news', 'exhibition world', 'exhibition industry',
  'event industry', 'events industry',
  'business travel', 'corporate travel',
  'incentive house', 'dmc ', 'destination management',
  'association management', 'association executive',
  'sponsorship', 'exhibit hall', 'exhibition hall', 'show floor',
  'pre-function', 'f&b ', 'food and beverage',
  'a/v ', 'audiovisual', 'audio visual',
  'cvent', 'eventbrite', 'aventri', 'stova', 'bizzabo',
  'rfp ', 'request for proposal',
  'site visit', 'fam trip', 'familiarization',
  'post-event', 'event roi', 'event data',
  'meeting architect', 'experience design',
  'aisles ', 'booths', 'booth design', 'exhibit design',
  'floor plan', 'show management',
  'buyer', 'supplier', 'industry professional',
];

// ── 컨텍스트 키워드 (weight: 1) ───────────────────────────────────────────
const CONTEXT_TERMS = [
  'hotel', 'resort', 'destination', 'tourism', 'travel',
  'speaker', 'panel', 'workshop', 'seminar', 'webinar',
  'innovation', 'technology', 'digital', 'ai ', 'artificial intelligence',
  'sustainability', 'net zero', 'carbon',
  'health safety', 'pandemic', 'post-pandemic',
  'global industry', 'industry news', 'industry trends',
  'research', 'study', 'report', 'survey', 'forecast',
  'growth', 'market', 'revenue', 'economic impact',
];

// ── 차단 키워드 (weight: -5) — 이 단어가 있으면 관련성 급락 ─────────────
const BLOCK_TERMS = [
  'stock market', 'stock price', 'stock exchange',
  'cryptocurrency', 'bitcoin', 'ethereum', 'nft',
  'court ruling', 'criminal arrest',
  'recipe', 'cooking', 'restaurant review',
  'sports team', 'nfl ', 'nba ', 'fifa ',
  'celebrity gossip', 'pop star',
  'video game', 'gaming console',
  'weather forecast', 'earthquake', 'hurricane',
  'political election', 'election result',
  'real estate listing', 'property market',
  'personal finance', 'mortgage rate', 'insurance policy',
  // 정치/외교 뉴스 (MICE 관련 없는 일반 뉴스) — 더 구체적으로 변경
  'senate vote', 'parliament debate',
  'presidential election', 'presidential campaign', 'election campaign',
  'military operation', 'military strike',
  'drug war', 'fugitive', 'prison sentence', 'murder suspect',
  'typhoon warning', 'flood damage', 'earthquake damage',
  'dinosaur', 'wildlife conservation', 'species discovery',
];

/**
 * 기사의 MICE 관련성 점수를 계산한다.
 * @param {string} title - 기사 제목 (영문)
 * @param {string} content - 기사 본문 일부 (영문)
 * @returns {number} 관련성 점수 (음수 가능)
 */
export function calcMiceScore(title, content) {
  const text = ((title || '') + ' ' + (content || '')).toLowerCase();

  let score = 0;

  for (const kw of CORE_TERMS)     if (text.includes(kw)) score += 3;
  for (const kw of INDUSTRY_TERMS) if (text.includes(kw)) score += 2;
  for (const kw of CONTEXT_TERMS)  if (text.includes(kw)) score += 1;
  for (const kw of BLOCK_TERMS)    if (text.includes(kw)) score -= 5;

  return score;
}

/**
 * 최소 점수 임계값 (이 값 미만이면 저장하지 않음)
 *
 * 조정 기준:
 *   2 = 관대 (title에 meeting 1개만 있어도 통과)
 *   3 = 균형 (권장값 — 핵심어 1개 또는 산업어 2개 이상)
 *   5 = 엄격 (핵심어 2개 또는 핵심+산업어 조합 필요)
 */
export const MIN_MICE_SCORE = 3;

/**
 * 기사가 MICE 기준을 통과하는지 여부.
 * @param {string} title
 * @param {string} content
 * @returns {{ pass: boolean, score: number }}
 */
export function isMiceRelevant(title, content) {
  const score = calcMiceScore(title, content);
  return { pass: score >= MIN_MICE_SCORE, score };
}
