#!/usr/bin/env node
/**
 * Facebook Group Scraper for Austin Trail Conditions.
 *
 * Uses your system Chrome (not Puppeteer's bundled Chromium) with a
 * separate profile directory copied from your real one. This means:
 *   - No cookie export needed — it copies your logged-in session
 *   - Chrome can stay open while this runs (separate profile dir)
 *   - Uses your real Chrome binary so profile format matches
 *
 * Setup:
 *   1. cd scraper && npm install
 *   2. cp .env.example .env — fill in API_URL and API_SECRET
 *   3. Log into Facebook in Chrome on this machine
 *   4. node scrape.js  (first run copies your Chrome profile)
 *
 * Crontab example (every 2h from 6am–8pm CT):
 *   0 6,8,10,12,14,16,18,20 * * * cd /path/to/scraper && node scrape.js >> scrape.log 2>&1
 */

const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Load .env ────────────────────────────────────────────────────────
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
}

// ── Config ───────────────────────────────────────────────────────────
const API_URL = (process.env.API_URL || 'https://austintrailconditions.com').replace(/\/$/, '');
const API_SECRET = process.env.API_SECRET || '';
const FB_GROUP = 'https://www.facebook.com/groups/325119181430845';
const SCROLL_COUNT = parseInt(process.env.SCROLL_COUNT || '8', 10);
const HEADLESS = process.env.HEADLESS !== 'false'; // default true

// Source Chrome profile (your real logged-in session)
const SOURCE_PROFILE = process.env.CHROME_PROFILE || path.join(os.homedir(), '.config', 'google-chrome');
// Separate profile dir for the scraper (won't conflict with running Chrome)
const SCRAPER_PROFILE = path.join(__dirname, '.chrome-profile');

if (!API_SECRET) { console.error('Missing API_SECRET in .env'); process.exit(1); }

// ── Find system Chrome ───────────────────────────────────────────────

function findChrome() {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try which
  try {
    return execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

// ── Copy Chrome profile (cookies + session) ──────────────────────────

function syncProfile() {
  if (!fs.existsSync(SOURCE_PROFILE)) {
    log(`ERROR: Chrome profile not found at ${SOURCE_PROFILE}`);
    log('Log into Facebook in Chrome first, then try again.');
    process.exit(1);
  }

  // Copy just the Default profile (cookies, local storage, etc.)
  // This is ~50-200MB, not the full multi-GB cache
  const src = path.join(SOURCE_PROFILE, 'Default');
  const dest = path.join(SCRAPER_PROFILE, 'Default');

  if (!fs.existsSync(src)) {
    log(`ERROR: No Default profile found at ${src}`);
    process.exit(1);
  }

  log('Syncing Chrome profile (cookies & session)...');
  // Use rsync for speed — only copies changed files
  try {
    execSync(`rsync -a --delete \
      --include="Cookies" \
      --include="Cookies-journal" \
      --include="Login Data" \
      --include="Login Data-journal" \
      --include="Local Storage/***" \
      --include="Session Storage/***" \
      --include="Preferences" \
      --include="Secure Preferences" \
      --include="Local Storage/" \
      --include="Session Storage/" \
      --exclude="*" \
      "${src}/" "${dest}/"`, { stdio: 'pipe' });
    log('Profile synced.');
  } catch (err) {
    // Fallback: just copy the whole Default folder
    log('rsync selective copy failed, doing full copy...');
    execSync(`mkdir -p "${dest}" && cp -r "${src}/Cookies" "${src}/Cookies-journal" "${dest}/" 2>/dev/null || true`);
    execSync(`cp -r "${src}/Local Storage" "${dest}/" 2>/dev/null || true`);
    execSync(`cp -r "${src}/Preferences" "${dest}/" 2>/dev/null || true`);
    log('Profile copied (fallback).');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Post + comment extraction (runs in browser context) ──────────────

function extractPostsFromPage() {
  const results = [];

  // Helper: extract text, author, id, timestamp from an article element
  function parseArticle(article, parentPostId) {
    let postText = '';
    const textEls = article.querySelectorAll('div[dir="auto"]');
    for (const el of textEls) {
      const text = (el.textContent || '').trim();
      if (text.length > 20 && text.length > postText.length) {
        postText = text;
      }
    }
    if (!postText || postText.length < 10) return null;

    let authorName = 'Unknown';
    const authorEl = article.querySelector('h3 a strong, h4 a strong, a[role="link"] strong, span.x3nfvp2 a strong');
    if (authorEl) {
      const name = (authorEl.textContent || '').trim();
      if (name.length > 0 && name.length < 100) authorName = name;
    }

    let postId = '';
    const links = article.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/permalink\/(\d+)|\/posts\/(\d+)|story_fbid=(\d+)|comment_id=(\d+)/);
      if (match) {
        postId = match[1] || match[2] || match[3] || match[4];
        break;
      }
    }
    if (!postId) {
      postId = 'pup-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    }

    // If this is a comment, prefix the ID so we can tell them apart
    if (parentPostId) {
      postId = 'c-' + postId;
    }

    let timestamp = new Date().toISOString();
    const timeEl = article.querySelector('a[href*="/permalink/"] span, a[href*="comment_id"] span, abbr[data-utime], time[datetime]');
    if (timeEl) {
      const utime = timeEl.getAttribute('data-utime');
      const datetime = timeEl.getAttribute('datetime');
      if (utime) {
        timestamp = new Date(parseInt(utime) * 1000).toISOString();
      } else if (datetime) {
        timestamp = new Date(datetime).toISOString();
      }
    }

    return {
      postId,
      authorName,
      postText: postText.slice(0, 2000),
      timestamp,
      isComment: !!parentPostId,
      parentPostId: parentPostId || null,
    };
  }

  // Get top-level posts
  const topLevelArticles = document.querySelectorAll('div[role="article"]');

  for (const article of topLevelArticles) {
    try {
      // Skip if this is a nested article (comment) — we'll get those from the parent
      if (article.parentElement && article.parentElement.closest('div[role="article"]')) continue;

      const post = parseArticle(article, null);
      if (!post) continue;
      results.push(post);

      // Now get comments inside this post
      const commentArticles = article.querySelectorAll('div[role="article"]');
      for (const commentEl of commentArticles) {
        try {
          const comment = parseArticle(commentEl, post.postId);
          if (comment) results.push(comment);
        } catch (e) {
          // skip bad comment
        }
      }
    } catch (e) {
      // skip malformed post
    }
  }

  return results;
}

// ── Main scrape function ─────────────────────────────────────────────

async function scrape() {
  log('Starting Facebook group scrape');

  const chromePath = findChrome();
  if (!chromePath) {
    log('ERROR: Could not find Chrome or Chromium. Install google-chrome or chromium.');
    process.exit(1);
  }
  log(`Using Chrome: ${chromePath}`);

  // Sync cookies/session from your real Chrome profile
  syncProfile();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS ? 'new' : false,
      executablePath: chromePath,
      userDataDir: SCRAPER_PROFILE,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1440,900',
      ],
      defaultViewport: { width: 1440, height: 900 },
    });

    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    log('Navigating to group...');
    await page.goto(FB_GROUP, { waitUntil: 'networkidle2', timeout: 60000 });
    await randomDelay(3000, 5000);

    const url = page.url();
    if (url.includes('/login')) {
      log('ERROR: Not logged into Facebook! Open Chrome, log in manually, then try again.');
      await browser.close();
      process.exit(2);
    }

    // Sort by "New" instead of Facebook's default algorithm
    log('Switching to New posts sort order...');
    try {
      // Look for the sort button — it usually says "Relevant", "Top Posts", or has a sort icon
      const sortClicked = await page.evaluate(() => {
        // Facebook group sort is typically a button/link near the top with text like
        // "Relevant" or "New" or inside a menu
        const buttons = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], a[role="button"]'));
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'relevant' || text === 'top posts' || text === 'recent activity') {
            btn.click();
            return 'clicked-sort-button';
          }
        }
        return null;
      });

      if (sortClicked) {
        await randomDelay(1500, 2500);
        // Now click "New" in the dropdown menu
        const newClicked = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('div[role="menuitem"], div[role="option"], div[role="menuitemradio"], span'));
          for (const item of items) {
            const text = (item.textContent || '').trim().toLowerCase();
            if (text === 'new' || text === 'newest' || text === 'new posts') {
              item.click();
              return true;
            }
          }
          return false;
        });
        if (newClicked) {
          log('Sorted by New posts.');
          await randomDelay(2000, 3000);
        } else {
          log('Could not find "New" option in dropdown — using default sort.');
        }
      } else {
        log('Sort button not found — using default sort.');
      }
    } catch (e) {
      log('Sort switch failed (non-fatal): ' + e.message);
    }

    log('Starting scroll...');

    for (let i = 0; i < SCROLL_COUNT; i++) {
      const scrollAmount = 600 + Math.floor(Math.random() * 800);
      await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount);

      const delay = 2000 + Math.random() * 3000;
      log(`Scroll ${i + 1}/${SCROLL_COUNT}, waiting ${Math.round(delay)}ms...`);
      await randomDelay(delay, delay + 500);
    }

    await randomDelay(2000, 3000);

    // Expand comments on visible posts before extracting
    log('Expanding comments...');
    const expandedCount = await page.evaluate(async () => {
      let clicked = 0;
      // Click "View more comments", "View all X comments", etc.
      for (let round = 0; round < 3; round++) {
        const expanders = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'));
        for (const btn of expanders) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (
            text.includes('view more comment') ||
            text.includes('view all') ||
            text.match(/view \d+ more comment/) ||
            text.match(/\d+ repl/)
          ) {
            btn.click();
            clicked++;
            await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
          }
        }
        if (clicked === 0) break;
        await new Promise(r => setTimeout(r, 1500));
      }
      return clicked;
    });
    log(`Expanded ${expandedCount} comment sections.`);
    await randomDelay(1500, 2500);

    const posts = await page.evaluate(extractPostsFromPage);
    const postCount = posts.filter(p => !p.isComment).length;
    const commentCount = posts.filter(p => p.isComment).length;
    log(`Extracted ${postCount} posts + ${commentCount} comments = ${posts.length} total`);

    if (posts.length === 0) {
      log('No posts found. Try running with HEADLESS=false to see what the page looks like.');
      await browser.close();
      process.exit(0);
    }

    log(`Sending ${posts.length} posts to ${API_URL}/api/scrape/ingest`);
    const response = await fetch(`${API_URL}/api/scrape/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_SECRET}`,
      },
      body: JSON.stringify({ posts }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      log(`API error ${response.status}: ${errText.slice(0, 500)}`);
      process.exit(1);
    }

    const result = await response.json();
    log(`Done! stored=${result.stored}, classified=${result.classified}, verified=${result.verified || 0}`);

  } catch (err) {
    log(`ERROR: ${err.message}`);
    if (err.stack) log(err.stack);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

// ── Run ──────────────────────────────────────────────────────────────
scrape();
