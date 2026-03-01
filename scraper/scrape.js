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

// ── Post extraction (runs in browser context) ────────────────────────

function extractPostsFromPage() {
  const articles = document.querySelectorAll('div[role="article"]');
  const posts = [];

  for (const article of articles) {
    try {
      if (article.parentElement && article.parentElement.closest('div[role="article"]')) continue;

      let postText = '';
      const textEls = article.querySelectorAll('div[dir="auto"]');
      for (const el of textEls) {
        const text = (el.textContent || '').trim();
        if (text.length > 20 && text.length > postText.length) {
          postText = text;
        }
      }
      if (!postText || postText.length < 10) continue;

      let authorName = 'Unknown';
      const authorEl = article.querySelector('h3 a strong, h4 a strong, a[role="link"] strong');
      if (authorEl) {
        const name = (authorEl.textContent || '').trim();
        if (name.length > 0 && name.length < 100) authorName = name;
      }

      let postId = '';
      const links = article.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/permalink\/(\d+)|\/posts\/(\d+)|story_fbid=(\d+)/);
        if (match) {
          postId = match[1] || match[2] || match[3];
          break;
        }
      }
      if (!postId) {
        postId = 'pup-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      }

      let timestamp = new Date().toISOString();
      const timeEl = article.querySelector('a[href*="/permalink/"] span, abbr[data-utime], time[datetime]');
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
      // skip malformed post
    }
  }

  return posts;
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

    log('Page loaded, starting scroll...');

    for (let i = 0; i < SCROLL_COUNT; i++) {
      const scrollAmount = 600 + Math.floor(Math.random() * 800);
      await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount);

      const delay = 2000 + Math.random() * 3000;
      log(`Scroll ${i + 1}/${SCROLL_COUNT}, waiting ${Math.round(delay)}ms...`);
      await randomDelay(delay, delay + 500);
    }

    await randomDelay(2000, 3000);

    const posts = await page.evaluate(extractPostsFromPage);
    log(`Extracted ${posts.length} posts from page`);

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
