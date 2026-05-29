/**
 * MIK RSS Parser Module v3
 * ──────────────────────────────────────────────────────────────────
 * 변경사항 (v3):
 *  - fetchAllFeeds: Promise.allSettled 유지 + 각 feed 내부 try-catch 강화
 *  - parseRssXml: 개별 item 파싱 실패 시 해당 item만 건너뜀 (전체 중단 없음)
 *  - [NEW] classifyByRules(): 제목+본문 기반 1차 룰베이스 카테고리 매퍼
 *    → AI가 멈춰도 최소한의 카테고리가 저장됨
 *  - storeArticleRaw에서 classifyByRules 결과 사용 (index.js와 협력)
 * ──────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────
// 1차 룰베이스 카테고리 매퍼
// AI가 없어도 RSS 수집 시점에 카테고리가 결정됨
// ─────────────────────────────────────────────────────────────────

/**
 * 제목 + 본문 텍스트 기반으로 카테고리와 CSS 클래스를 결정한다.
 * 반환값: { category: string, catClass: string, score: number }
 *
 * 사용처: index.js의 storeArticleRaw() 호출 직전
 * 폴백:   소스의 defaultCategory (RSS_FEEDS 배열에 정의된 값)
 */
export function classifyByRules(title, content, defaultCategory = 'convention') {
  const txt = ((title || '') + ' ' + (content || '')).toLowerCase();
  const scores = {
    convention:     0,
    exhibition:     0,
    incentive:      0,
    tech:           0,
    sustainability: 0,
    market:         0,
    policy:         0,
  };

  // ── 룰 정의 [카테고리, 가중치, 키워드 목록] ──────────────────────
  const RULES = [
    // convention
    ['convention', 5, ['pcma','icca','mpi ','cvb ','pco ','convention center','convention bureau',
                       'meeting planner','hosted buyer','association meeting','congress planner',
                       'hybrid meeting','in-person meeting','corporate meeting','meeting professional']],
    ['convention', 2, ['congress','conference','summit','convention','delegate','association event',
                       'business event','annual meeting','event planner','forum ']],
    ['convention', 1, ['meeting','session','attendee','symposium']],

    // exhibition
    ['exhibition', 5, ['trade show','tradeshow','trade fair','trade exhibition','ufi ','iaee',
                       'show floor','exhibit hall','exhibitor','booth design','pavilion','expo center']],
    ['exhibition', 2, ['exhibition ','expo ','world expo','international expo','fair ']],
    ['exhibition', 1, ['display','showcase','gallery','stand ','booth']],

    // incentive
    ['incentive', 5, ['incentive travel','incentive trip','incentive program','incentive group',
                      'dmc ','site global','fam trip','reward travel','group incentive',
                      'travel reward','incentive winner','top performer travel']],
    ['incentive', 2, ['incentive','luxury travel','group travel','team travel','rewards program']],
    ['incentive', 1, ['travel reward','trip reward']],

    // tech
    ['tech', 5, ['cvent','bizzabo','stova','eventbrite','whova','hopin','event app',
                 'event platform','event software','event tech','registration tech',
                 'ai-powered event','virtual event','hybrid event platform',
                 'event management software','attendee app','event registration']],
    ['tech', 2, ['technology platform','digital event','livestream event','event automation',
                 'event analytics','nfc event','rfid event','artificial intelligence event',
                 'machine learning','chatgpt','generative ai']],
    ['tech', 1, ['mobile app','digital event','ai tool','tech solution','saas','api']],

    // sustainability
    ['sustainability', 5, ['esg','green meeting','carbon neutral','net zero','sustainable event',
                            'gmic','carbon offset','zero waste event','eco-friendly event',
                            'sustainable venue','scope 3','climate pledge','green certification']],
    ['sustainability', 2, ['sustainable','carbon footprint','renewable energy','waste reduction',
                            'environmental impact','green initiative','responsible tourism']],
    ['sustainability', 1, ['green ','carbon','environment','climate','recycl']],

    // market
    ['market', 5, ['market research','industry report','market forecast','revenue data',
                   'market size','benchmark study','industry statistics','market share',
                   'economic impact study','market analysis','industry outlook',
                   'spending report','demand forecast','global market']],
    ['market', 3, ['report shows','according to research','survey results','new data',
                   'industry data','growth rate','market trend','record revenue','record high']],
    ['market', 1, ['report','survey','data','forecast','outlook','statistics','revenue']],

    // policy
    ['policy', 5, ['government policy','ministry of tourism','visa policy','legislation',
                   'certification standard','compliance','grant program','government subsidy',
                   'official regulation','tourism act','meeting ordinance']],
    ['policy', 3, ['regulation','ministry','government support','national tourism',
                   'government initiative','public sector','official announcement']],
    ['policy', 1, ['policy','government','law ','official','authority']],
  ];

  for (const [cat, weight, keywords] of RULES) {
    for (const kw of keywords) {
      if (txt.includes(kw)) scores[cat] += weight;
    }
  }

  // 점수가 동점일 때 우선순위 (더 구체적인 카테고리를 우선)
  const PRIORITY = ['tech', 'exhibition', 'incentive', 'sustainability', 'convention', 'policy', 'market'];
  let best = null;
  let bestScore = 0;
  for (const cat of PRIORITY) {
    if (scores[cat] > bestScore) {
      bestScore = scores[cat];
      best = cat;
    }
  }

  // 점수가 전혀 없으면 defaultCategory 사용
  const category = (best && bestScore > 0) ? best : defaultCategory;

  const CLASS_MAP = {
    convention:     'tag-convention',
    exhibition:     'tag-exhibition',
    incentive:      'tag-incentive',
    tech:           'tag-tech',
    sustainability: 'tag-sustainability',
    market:         'tag-market',
    policy:         'tag-policy',
  };
  const catClass = CLASS_MAP[category] || 'tag-convention';

  return { category, catClass, score: bestScore };
}

// ─────────────────────────────────────────────────────────────────
// RSS Feed 목록
// ─────────────────────────────────────────────────────────────────

export const RSS_FEEDS = [
  // ── 핵심 전시/컨벤션 협회 ────────────────────────────────────────
  { name: 'UFI Blog',              url: 'https://blog.ufi.org/feed/',                          defaultCategory: 'exhibition', catClass: 'tag-exhibition' },
  { name: 'IAEE',                  url: 'https://www.iaee.com/feed/',                          defaultCategory: 'exhibition', catClass: 'tag-exhibition' },

  // ── 글로벌 MICE 전문지 ──────────────────────────────────────────
  { name: 'Skift Meetings',        url: 'https://meetings.skift.com/feed/',                    defaultCategory: 'tech',       catClass: 'tag-tech'       },
  { name: 'Smart Meetings',        url: 'https://smartmeetings.com/feed/',                     defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'Meetings Today',        url: 'https://www.meetingstoday.com/feed/',                 defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'MeetingsNet',           url: 'https://www.meetingsnet.com/rss',                     defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'Convene International', url: 'https://convene.com/catalyst/feed/',                  defaultCategory: 'convention', catClass: 'tag-convention' },

  // ── 전시/이벤트 전문지 ──────────────────────────────────────────
  { name: 'Event Industry News',   url: 'https://eventindustrynews.com/feed/',                 defaultCategory: 'exhibition', catClass: 'tag-exhibition' },
  { name: 'Exhibition World',      url: 'https://www.exhibitionworld.co.uk/feed',              defaultCategory: 'exhibition', catClass: 'tag-exhibition' },
  { name: 'TradeShow News Network',url: 'https://www.tsnn.com/rss.xml',                        defaultCategory: 'exhibition', catClass: 'tag-exhibition' },
  { name: 'Event Marketer',        url: 'https://www.eventmarketer.com/?feed=rss2',            defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'Eventex',               url: 'https://eventex.co/feed/',                            defaultCategory: 'exhibition', catClass: 'tag-exhibition' },
  { name: 'Event Tech Live',       url: 'https://eventtechlive.com/feed/',                     defaultCategory: 'tech',       catClass: 'tag-tech'       },

  // ── 협회 공식 채널 ──────────────────────────────────────────────
  { name: 'PCMA Convene',          url: 'https://www.pcma.org/convene/feed/',                  defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'PCMA Blog',             url: 'https://www.pcma.org/blog/feed/',                     defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'MPI Blog',              url: 'https://www.mpi.org/blog/rss/',                       defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'Events Industry Council',url:'https://news.eventscouncil.org/feed/',                defaultCategory: 'policy',     catClass: 'tag-policy'     },

  // ── 아시아태평양 / 글로벌 ────────────────────────────────────────
  { name: 'TTG MICE',              url: 'https://www.ttgmice.com/feed/',                       defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'Micebook',              url: 'https://micebook.com/news/feed/',                     defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'Conference News',       url: 'https://www.conference-news.co.uk/feed/',             defaultCategory: 'convention', catClass: 'tag-convention' },

  // ── 인센티브 트래블 전문 ─────────────────────────────────────────
  { name: 'SITE Global',           url: 'https://siteglobal.com/news/feed/',                   defaultCategory: 'incentive',  catClass: 'tag-incentive'  },
  { name: 'MICE Travel Today',     url: 'https://www.micetraveltoday.com/feed/',               defaultCategory: 'incentive',  catClass: 'tag-incentive'  },

  // ── 글로벌 최대 협회 / 전시회 ───────────────────────────────────
  { name: 'ICCA News',             url: 'https://www.iccaworld.org/newsarchive/rss.cfm',       defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'IMEX Group',            url: 'https://www.imexexhibitions.com/feed/',               defaultCategory: 'exhibition', catClass: 'tag-exhibition' },
  { name: 'IBTM Events',           url: 'https://www.ibtmworld.com/en/news/press-releases.rss',defaultCategory: 'convention', catClass: 'tag-convention' },

  // ── 비즈니스 이벤트 / 기업 회의 ─────────────────────────────────
  { name: 'GBTA Blog',             url: 'https://www.gbta.org/blog/feed/',                     defaultCategory: 'convention', catClass: 'tag-convention' },
  { name: 'Business Events Australia',url:'https://businessevents.australia.com/feed/',        defaultCategory: 'incentive',  catClass: 'tag-incentive'  },

  // ── 지속가능성 ──────────────────────────────────────────────────
  { name: 'Sustainable Events Alliance',url:'https://sustainable-event-alliance.org/feed/',   defaultCategory: 'policy',     catClass: 'tag-policy'     },
  { name: 'Green Meetings Industry Council',url:'https://gmicglobal.org/feed/',               defaultCategory: 'policy',     catClass: 'tag-policy'     },

  // ── 학술 저널 ───────────────────────────────────────────────────
  { name: 'J. Convention & Event Tourism',url:'https://www.tandfonline.com/feed/rss/wcet20',  defaultCategory: 'policy',     catClass: 'tag-policy'     },
  { name: 'Tourism Management Journal',url:'https://rss.sciencedirect.com/publication/science/02615177', defaultCategory: 'policy', catClass: 'tag-policy' },
  { name: "Int'l Journal of Event Management",url:'https://www.emerald.com/insight/rss/1758-2954', defaultCategory: 'policy', catClass: 'tag-policy' },
];

// ─────────────────────────────────────────────────────────────────
// 단일 RSS 피드 fetch + parse
// ─────────────────────────────────────────────────────────────────

/**
 * 단일 피드를 가져와 파싱된 item 배열을 반환한다.
 * 에러(네트워크 오류, HTTP 오류, 파싱 오류) 발생 시 [] 반환 — 절대 throw 하지 않는다.
 */
export async function fetchFeed(feed) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000); // 12s timeout

    let response;
    try {
      response = await fetch(feed.url, {
        headers: {
          'User-Agent': 'MIK-MICE-Insight-Korea/1.0',
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
        cf: { cacheTtl: 1800 },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      console.warn(`[RSS] Skip ${feed.name}: HTTP ${response.status}`);
      return [];
    }

    // HTML 에러 페이지 감지
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('text/html') && !ct.includes('xml')) {
      console.warn(`[RSS] Skip ${feed.name}: got HTML instead of XML`);
      return [];
    }

    const xml = await response.text();
    if (!xml || xml.length < 50) {
      console.warn(`[RSS] Skip ${feed.name}: empty or too-short response`);
      return [];
    }

    const items = parseRssXml(xml, feed);
    if (items.length > 0) {
      console.log(`[RSS] ${feed.name}: ${items.length} items`);
    } else {
      console.warn(`[RSS] ${feed.name}: 0 items parsed (XML length: ${xml.length})`);
    }
    return items;

  } catch (err) {
    // AbortError(타임아웃), 네트워크 에러 등 모두 안전하게 건너뜀
    const msg = err?.message || String(err);
    console.warn(`[RSS] Skip ${feed.name}: ${msg.slice(0, 120)}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// RSS/Atom XML 파싱
// ─────────────────────────────────────────────────────────────────

/**
 * XML 문자열을 파싱해 정규화된 article 객체 배열을 반환한다.
 * 개별 item 파싱 실패 시 해당 item만 건너뛰고 나머지는 계속 처리한다.
 */
function parseRssXml(xml, feed) {
  const items = [];

  // 네임스페이스 정규화 (content:encoded → encoded 등)
  const cleanXml = xml
    .replace(/<(?:[a-zA-Z0-9_]+:)?(item|entry|title|link|guid|id|pubDate|published|updated|description|content|encoded|summary)/gi, '<$1')
    .replace(/<\/(?:[a-zA-Z0-9_]+:)?(item|entry|title|link|guid|id|pubDate|published|updated|description|content|encoded|summary)/gi, '</$1');

  // ── RSS 2.0: <item> 블록 ──────────────────────────────────────
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(cleanXml)) !== null) {
    try {
      const itemXml = match[1];
      const title   = extractTag(itemXml, 'title');
      const link    = extractTag(itemXml, 'link');
      const guid    = extractTag(itemXml, 'guid') || link;
      const pubDate = extractTag(itemXml, 'pubDate');
      const desc    = extractTag(itemXml, 'description');
      const content = extractTag(itemXml, 'encoded') || desc;

      if (!title || !link) continue;

      const rawText = stripHtml(content || desc || '').substring(0, 5000);

      // 1차 룰베이스 카테고리 매핑
      const { category, catClass } = classifyByRules(title, rawText, feed.defaultCategory);

      items.push({
        guid:            guid.trim(),
        title:           stripHtml(title).trim(),
        link:            link.trim(),
        pubDate:         parsePubDate(pubDate),
        source:          feed.name,
        defaultCategory: category,   // 룰베이스 결과 사용
        catClass,
        content:         rawText,
      });
    } catch (itemErr) {
      console.warn(`[RSS] Item parse error in ${feed.name}: ${itemErr?.message}`);
    }
  }

  // ── Atom: <entry> 블록 ────────────────────────────────────────
  if (items.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(cleanXml)) !== null) {
      try {
        const entryXml  = match[1];
        const title     = extractTag(entryXml, 'title');
        const linkMatch = entryXml.match(/<link[^>]*href=["']([^"']+)["']/);
        const link      = linkMatch ? linkMatch[1] : extractTag(entryXml, 'link');
        const guid      = extractTag(entryXml, 'id') || link;
        const published = extractTag(entryXml, 'published') || extractTag(entryXml, 'updated');
        const content   = extractTag(entryXml, 'content') || extractTag(entryXml, 'summary');

        if (!title || !link) continue;

        const rawText = stripHtml(content || '').substring(0, 5000);
        const { category, catClass } = classifyByRules(title, rawText, feed.defaultCategory);

        items.push({
          guid:            guid.trim(),
          title:           stripHtml(title).trim(),
          link:            link.trim(),
          pubDate:         parsePubDate(published),
          source:          feed.name,
          defaultCategory: category,
          catClass,
          content:         rawText,
        });
      } catch (entryErr) {
        console.warn(`[RSS] Entry parse error in ${feed.name}: ${entryErr?.message}`);
      }
    }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
// 전체 피드 fetch (항상 Promise.allSettled — 하나가 실패해도 나머지 계속)
// ─────────────────────────────────────────────────────────────────

export async function fetchAllFeeds() {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(feed => fetchFeed(feed))
  );

  const allItems = [];
  let failedFeeds = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    } else {
      // fetchFeed 내부에서 이미 catch하므로 여기까지 오는 경우는 드물지만 방어
      console.warn(`[RSS] Feed ${RSS_FEEDS[i].name} rejected: ${result.reason?.message}`);
      failedFeeds++;
    }
  }

  console.log(`[RSS] Total: ${allItems.length} items (${failedFeeds} feeds failed completely)`);
  return allItems;
}

// ─────────────────────────────────────────────────────────────────
// 기사 전문 가져오기 (선택적 — 실패해도 조용히 null 반환)
// ─────────────────────────────────────────────────────────────────

export async function fetchFullContent(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': 'MIK-MICE-Insight-Korea/1.0' },
        cf: { cacheTtl: 3600 },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) return null;

    const html = await response.text();
    const articleMatch =
      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
      html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
      html.match(/<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

    let mainContent = articleMatch ? articleMatch[1] : (() => {
      const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      return body ? body[1] : html;
    })();

    const clean = mainContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');

    const text = stripHtml(clean).trim();
    return text.length > 100 ? text : null;
  } catch (err) {
    console.warn(`[ContentFetch] Failed for ${url}: ${err?.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// 내부 유틸리티
// ─────────────────────────────────────────────────────────────────

function extractTag(xml, tagName) {
  // CDATA 우선
  const cdataRe = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, 'i');
  const cdataM  = xml.match(cdataRe);
  if (cdataM) return cdataM[1];

  // 일반 태그
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1] : '';
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePubDate(raw) {
  if (!raw) return new Date().toISOString();
  try {
    const d = new Date(raw.trim());
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}
