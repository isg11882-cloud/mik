/**
 * MIK RSS Parser Module
 * Fetches and parses RSS/Atom feeds from MICE industry media sources.
 */

// Registered RSS feed sources
// Last audited: 2026-05 — ITII/BizBash 제거, 신규 매체 9개 추가
export const RSS_FEEDS = [
  // ── 핵심 전시/컨벤션 협회 ─────────────────────────────────────────
  {
    name: 'UFI Blog',
    url: 'https://blog.ufi.org/feed/',
    defaultCategory: 'exhibition',
    catClass: 'tag-exhibition',
  },
  {
    name: 'IAEE',
    url: 'https://www.iaee.com/feed/',
    defaultCategory: 'exhibition',
    catClass: 'tag-exhibition',
  },

  // ── 글로벌 MICE 전문지 ────────────────────────────────────────────
  {
    name: 'Skift Meetings',
    url: 'https://meetings.skift.com/feed/',
    defaultCategory: 'tech',
    catClass: 'tag-tech',
  },
  {
    name: 'Smart Meetings',
    url: 'https://smartmeetings.com/feed/',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },
  {
    name: 'Meetings Today',
    url: 'https://www.meetingstoday.com/feed/',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },
  {
    name: 'MeetingsNet',
    url: 'https://www.meetingsnet.com/rss',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },
  {
    name: 'Convene International',
    url: 'https://convene.com/catalyst/feed/',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },

  // ── 전시/이벤트 전문지 ────────────────────────────────────────────
  {
    name: 'Event Industry News',
    url: 'https://eventindustrynews.com/feed/',
    defaultCategory: 'exhibition',
    catClass: 'tag-exhibition',
  },
  {
    name: 'Exhibition World',
    url: 'https://www.exhibitionworld.co.uk/feed',
    defaultCategory: 'exhibition',
    catClass: 'tag-exhibition',
  },
  {
    name: 'TradeShow News Network',
    url: 'https://www.tsnn.com/rss.xml',
    defaultCategory: 'exhibition',
    catClass: 'tag-exhibition',
  },
  {
    name: 'Event Marketer',
    url: 'https://www.eventmarketer.com/?feed=rss2',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },
  {
    name: 'Eventex',
    url: 'https://eventex.co/feed/',
    defaultCategory: 'exhibition',
    catClass: 'tag-exhibition',
  },
  {
    name: 'Event Tech Live',
    url: 'https://eventtechlive.com/feed/',
    defaultCategory: 'tech',
    catClass: 'tag-tech',
  },

  // ── 협회 공식 채널 ────────────────────────────────────────────────
  {
    name: 'PCMA Convene',
    url: 'https://www.pcma.org/convene/feed/',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },
  {
    name: 'PCMA Blog',
    url: 'https://www.pcma.org/blog/feed/',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },
  {
    name: 'MPI Blog',
    url: 'https://www.mpi.org/blog/rss/',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },
  {
    name: 'Events Industry Council',
    url: 'https://news.eventscouncil.org/feed/',
    defaultCategory: 'policy',
    catClass: 'tag-policy',
  },

  // ── 아시아태평양 / 글로벌 ─────────────────────────────────────────
  {
    name: 'TTG MICE',
    url: 'https://www.ttgmice.com/feed/',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },
  {
    name: 'Micebook',
    url: 'https://micebook.com/news/feed/',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },
  {
    name: 'Conference News',
    url: 'https://www.conference-news.co.uk/feed/',
    defaultCategory: 'convention',
    catClass: 'tag-convention',
  },

  // ── 인센티브 트래블 전문 ──────────────────────────────────────────
  {
    name: 'SITE Global',
    url: 'https://siteglobal.com/news/feed/',
    defaultCategory: 'incentive',
    catClass: 'tag-incentive',
  },
  {
    name: 'MICE Travel Today',
    url: 'https://www.micetraveltoday.com/feed/',
    defaultCategory: 'incentive',
    catClass: 'tag-incentive',
  },
];

/**
 * Fetch and parse a single RSS feed.
 * Uses the built-in DOMParser-like approach via regex for Workers environment.
 */
export async function fetchFeed(feed) {
  try {
    const response = await fetch(feed.url, {
      headers: {
        'User-Agent': 'MIK-MICE-Insight-Korea/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
      cf: { cacheTtl: 1800 }, // Cache for 30 minutes at Cloudflare edge
    });

    if (!response.ok) {
      console.error(`[RSS] Failed to fetch ${feed.name}: HTTP ${response.status}`);
      return [];
    }

    const xml = await response.text();
    return parseRssXml(xml, feed);
  } catch (err) {
    console.error(`[RSS] Error fetching ${feed.name}:`, err.message);
    return [];
  }
}

/**
 * Parse RSS XML string into article objects.
 * Works in Cloudflare Workers without DOM parser.
 */
function parseRssXml(xml, feed) {
  const items = [];
  
  // Normalize XML (remove namespaces for easier regex matching)
  const cleanXml = xml.replace(/<(?:[a-zA-Z0-9]+:)?(item|entry|title|link|guid|id|pubDate|published|updated|description|content|encoded|summary)/gi, '<$1')
                      .replace(/<\/(?:[a-zA-Z0-9]+:)?(item|entry|title|link|guid|id|pubDate|published|updated|description|content|encoded|summary)/gi, '</$1');

  // Try <item> blocks (RSS 2.0)
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(cleanXml)) !== null) {
    const itemXml = match[1];

    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const guid = extractTag(itemXml, 'guid') || link;
    const pubDate = extractTag(itemXml, 'pubDate');
    const description = extractTag(itemXml, 'description');
    const content = extractTag(itemXml, 'encoded') || description;

    if (!title || !link) continue;

    items.push({
      guid: guid.trim(),
      title: stripHtml(title).trim(),
      link: link.trim(),
      pubDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      source: feed.name,
      defaultCategory: feed.defaultCategory,
      catClass: feed.catClass,
      content: stripHtml(content || '').substring(0, 5000),
    });
  }

  // If no items, try <entry> blocks (Atom)
  if (items.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(cleanXml)) !== null) {
      const entryXml = match[1];

      const title = extractTag(entryXml, 'title');
      const linkMatch = entryXml.match(/<link[^>]*href=["']([^"']+)["']/);
      const link = linkMatch ? linkMatch[1] : extractTag(entryXml, 'link');
      const guid = extractTag(entryXml, 'id') || link;
      const published = extractTag(entryXml, 'published') || extractTag(entryXml, 'updated');
      const content = extractTag(entryXml, 'content') || extractTag(entryXml, 'summary');

      if (!title || !link) continue;

      items.push({
        guid: guid.trim(),
        title: stripHtml(title).trim(),
        link: link.trim(),
        pubDate: published ? new Date(published).toISOString() : new Date().toISOString(),
        source: feed.name,
        defaultCategory: feed.defaultCategory,
        catClass: feed.catClass,
        content: stripHtml(content || '').substring(0, 5000),
      });
    }
  }

  if (items.length === 0) {
    console.warn(`[RSS] No items found in ${feed.name}. XML length: ${xml.length}`);
  }

  return items;
}

/**
 * Fetch the full HTML content of an article and extract main text.
 */
export async function fetchFullContent(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'MIK-MICE-Insight-Korea/1.0' },
      cf: { cacheTtl: 3600 }
    });
    if (!response.ok) return null;

    const html = await response.text();
    
    // Extract content within <article>, <main>, or class/id containing 'content'
    let mainContent = '';
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                        html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                        html.match(/<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    
    if (articleMatch) {
      mainContent = articleMatch[1];
    } else {
      // Fallback: take the body and remove common noise
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      mainContent = bodyMatch ? bodyMatch[1] : html;
    }

    // Strip scripts, styles, and other tags
    const clean = mainContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');

    return stripHtml(clean);
  } catch (err) {
    console.warn(`[ContentFetch] Failed for ${url}:`, err.message);
    return null;
  }
}

/**
 * Extract text content from an XML tag.
 */
function extractTag(xml, tagName) {
  // Try CDATA first
  const cdataRegex = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1];

  // Standard tag
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
}

/**
 * Extract CDATA content.
 */
function extractCData(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : null;
}

/**
 * Strip HTML tags from a string.
 */
function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch all registered feeds and return combined items.
 */
export async function fetchAllFeeds() {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(feed => fetchFeed(feed))
  );

  const allItems = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    }
  }

  console.log(`[RSS] Total items fetched across all feeds: ${allItems.length}`);
  return allItems;
}
