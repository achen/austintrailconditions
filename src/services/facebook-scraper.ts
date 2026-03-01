import { TrailReport } from '@/types';
import { notifyCookieExpired } from '@/services/notification-service';
import { sql } from '@/lib/db';

const APIFY_BASE = 'https://api.apify.com/v2';
const ACTOR_ID = 'apify~web-scraper'; // Free built-in Web Scraper
const FB_GROUP_URL = 'https://www.facebook.com/groups/325119181430845';

interface ScrapedPost {
  postId: string;
  authorName: string;
  postText: string;
  timestamp: string;
}

/**
 * Get cookies — prefer DB (updated via admin UI) over env var.
 */
async function getCookies(): Promise<string | null> {
  try {
    const result = await sql`
      SELECT value FROM app_config WHERE key = 'facebook_cookies'
    `;
    if (result.rows[0]?.value) return result.rows[0].value as string;
  } catch {
    // Table might not exist yet
  }
  return process.env.FACEBOOK_COOKIES || null;
}

/**
 * Parse a semicolon-separated cookie string into the JSON array format
 * that Apify's Web Scraper expects for initialCookies.
 */
function parseCookieString(
  cookieStr: string
): Array<{ name: string; value: string; domain: string }> {
  return cookieStr
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return null;
      return {
        name: pair.slice(0, eqIdx).trim(),
        value: pair.slice(eqIdx + 1).trim(),
        domain: '.facebook.com',
      };
    })
    .filter(
      (c): c is { name: string; value: string; domain: string } => c !== null
    );
}

/**
 * The page function that runs inside the Apify Web Scraper's Chromium browser.
 * It scrolls the Facebook group feed and extracts post data.
 * This is serialized as a string and sent to the Apify API.
 */
const PAGE_FUNCTION = `
async function pageFunction(context) {
  const { log, request } = context;
  log.info('Loading Facebook group page: ' + request.url);

  // Wait for the feed to load
  await context.waitFor(5000);

  // Scroll down a few times to load more posts
  for (let i = 0; i < 5; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await context.waitFor(2000 + Math.random() * 2000);
  }

  // Extract posts from the feed
  const posts = [];
  // Facebook wraps posts in divs with role="article" or data-pagelet containing "FeedUnit"
  const articles = document.querySelectorAll('div[role="article"]');

  for (const article of articles) {
    try {
      // Skip if it's a nested article (comment)
      if (article.closest('div[role="article"]') !== article) continue;

      // Get post text — look for the main text container
      const textEls = article.querySelectorAll('div[data-ad-preview="message"], div[dir="auto"]');
      let postText = '';
      for (const el of textEls) {
        const text = el.textContent?.trim();
        if (text && text.length > 10 && !postText) {
          postText = text;
          break;
        }
      }
      if (!postText) continue;

      // Get author name — usually in a strong tag or heading link
      let authorName = 'Unknown';
      const authorEl = article.querySelector('strong a, h3 a, h4 a, a[role="link"] strong');
      if (authorEl) {
        authorName = authorEl.textContent?.trim() || 'Unknown';
      }

      // Get post ID from permalink
      let postId = '';
      const links = article.querySelectorAll('a[href*="/permalink/"], a[href*="/posts/"], a[href*="story_fbid"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/permalink\\/(\\d+)|posts\\/(\\d+)|story_fbid=(\\d+)/);
        if (match) {
          postId = match[1] || match[2] || match[3];
          break;
        }
      }
      if (!postId) {
        postId = 'fb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      }

      // Get timestamp from abbr or time elements
      let timestamp = new Date().toISOString();
      const timeEl = article.querySelector('abbr[data-utime], time[datetime], a[href*="/permalink/"] span');
      if (timeEl) {
        const utime = timeEl.getAttribute('data-utime');
        const datetime = timeEl.getAttribute('datetime');
        if (utime) {
          timestamp = new Date(parseInt(utime) * 1000).toISOString();
        } else if (datetime) {
          timestamp = new Date(datetime).toISOString();
        }
      }

      posts.push({ postId, authorName, postText: postText.slice(0, 2000), timestamp });
    } catch (e) {
      log.warning('Failed to parse a post: ' + e.message);
    }
  }

  log.info('Extracted ' + posts.length + ' posts');
  return posts;
}
`;

/**
 * Fetch recent posts from the Austin Trail Conditions Facebook group
 * using Apify's free Web Scraper actor with cookie-based auth.
 */
export async function fetchGroupPosts(maxPosts: number = 25): Promise<TrailReport[]> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    console.error('APIFY_API_TOKEN not configured');
    return [];
  }

  const cookieStr = await getCookies();
  if (!cookieStr) {
    console.error('FACEBOOK_COOKIES not configured');
    return [];
  }

  const cookies = parseCookieString(cookieStr);
  if (cookies.length === 0) {
    console.error('Failed to parse FACEBOOK_COOKIES');
    return [];
  }

  // Build the Web Scraper input
  const input = {
    startUrls: [{ url: FB_GROUP_URL }],
    pageFunction: PAGE_FUNCTION,
    initialCookies: cookies,
    injectJQuery: false,
    proxyConfiguration: { useApifyProxy: true },
    maxPagesPerCrawl: 1,
    maxConcurrency: 1,
    pageLoadTimeoutSecs: 60,
    pageFunctionTimeoutSecs: 120,
  };

  const url = `${APIFY_BASE}/acts/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&format=json`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(240_000), // 4 min timeout
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (errText.includes('login') || errText.includes('cookie') || errText.includes('auth')) {
        await notifyCookieExpired();
      }
      console.error(`Apify Web Scraper error: ${response.status} - ${errText.slice(0, 500)}`);
      return [];
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      console.error('Unexpected Apify response: not an array');
      return [];
    }

    // The page function returns an array of posts per page, so flatten
    const allPosts: ScrapedPost[] = data.flat();

    if (allPosts.length === 0) {
      console.warn('Apify returned 0 posts — cookies may be expired');
      await notifyCookieExpired();
      return [];
    }

    return allPosts.slice(0, maxPosts).map((post) => ({
      postId: post.postId,
      authorName: post.authorName,
      postText: post.postText,
      timestamp: new Date(post.timestamp),
      trailReferences: [],
      classification: null,
      confidenceScore: null,
      flaggedForReview: false,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Apify fetch failed: ${message}`);
    return [];
  }
}
