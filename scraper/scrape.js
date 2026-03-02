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
const MAX_SCROLLS = parseInt(process.env.MAX_SCROLLS || '50', 10); // safety cap
const HEADLESS = process.env.HEADLESS !== 'false'; // default true

// Email config (Resend)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'info@austintrailconditions.com';

// File to persist known post IDs between runs
const SEEN_FILE = path.join(__dirname, '.seen-posts.json');

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

// ── Seen posts tracking ──────────────────────────────────────────────
// We track both permalink-based IDs AND text fingerprints (first 100 chars)
// because Facebook doesn't always render permalink links, so many posts
// get synthetic "pup-" IDs that change every run.

function textFingerprint(text) {
  // Normalize: lowercase, collapse whitespace, take first 100 chars
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
}

function loadSeenPosts() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
      return {
        ids: new Set(data.postIds || []),
        fingerprints: new Set(data.fingerprints || []),
      };
    }
  } catch (e) {
    log('Could not load seen posts file, starting fresh.');
  }
  return { ids: new Set(), fingerprints: new Set() };
}

function saveSeenPosts(seenData) {
  // Keep last 500 of each to avoid unbounded growth
  const ids = Array.from(seenData.ids).slice(-500);
  const fingerprints = Array.from(seenData.fingerprints).slice(-500);
  fs.writeFileSync(SEEN_FILE, JSON.stringify({
    postIds: ids,
    fingerprints,
    updatedAt: new Date().toISOString(),
  }));
}

// ── Email notification ───────────────────────────────────────────────

async function sendEmail(subject, html) {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: ALERT_EMAIL,
        subject: `[Trail Scraper] ${subject}`,
        html,
      }),
    });
    if (!res.ok) log(`Email send failed: ${res.status}`);
  } catch (e) {
    log(`Email error: ${e.message}`);
  }
}

// ── Fetch trail statuses from API ────────────────────────────────────

async function fetchTrailStatuses() {
  try {
    const res = await fetch(`${API_URL}/api/trails`);
    if (!res.ok) return {};
    const trails = await res.json();
    const map = {};
    for (const t of trails) map[t.name] = t.conditionStatus;
    return map;
  } catch {
    return {};
  }
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
      if (parentPostId) {
        // For comments, take any text at all
        if (text.length > 0 && text.length > postText.length) postText = text;
      } else {
        // For top-level posts, require 20+ chars to skip UI noise
        if (text.length > 20 && text.length > postText.length) postText = text;
      }
    }
    if (!postText) return null;

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
      // Facebook renders comments in various ways — try multiple selectors
      const commentArticles = article.querySelectorAll('div[role="article"]');
      for (const commentEl of commentArticles) {
        try {
          const comment = parseArticle(commentEl, post.postId);
          if (comment) results.push(comment);
        } catch (e) {
          // skip bad comment
        }
      }

      // Also look for comment-like elements that aren't role="article"
      // Facebook often uses list items or divs inside a comments section
      const commentContainers = article.querySelectorAll('ul[role="list"] > li, div[aria-label*="comment" i], div[data-testid*="comment"]');
      for (const commentEl of commentContainers) {
        try {
          // Skip if we already got this as a nested article
          if (commentEl.querySelector('div[role="article"]')) continue;
          const comment = parseArticle(commentEl, post.postId);
          if (comment) {
            // Avoid duplicates by checking text
            const isDupe = results.some(r => r.postText === comment.postText && r.isComment);
            if (!isDupe) results.push(comment);
          }
        } catch (e) {
          // skip
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

    // Sort by "Recent activity" to surface posts with new comments
    log('Switching to Recent activity sort order...');
    try {
      // The sort control shows as "New posts ▾" or "Most relevant ▾" — it's a clickable dropdown
      const sortClicked = await page.evaluate(() => {
        // Look for the sort dropdown — text like "New posts", "Most relevant", or "Recent activity"
        // followed by a dropdown arrow. It's typically a span or div that's clickable.
        const allEls = Array.from(document.querySelectorAll('span, div'));
        for (const el of allEls) {
          const text = (el.textContent || '').trim().toLowerCase();
          if ((text === 'new posts' || text === 'most relevant' || text === 'recent activity') &&
              el.offsetParent !== null) {
            // Check if this element or a close parent is clickable
            const clickTarget = el.closest('[role="button"]') || el;
            clickTarget.click();
            return text;
          }
        }
        return null;
      });

      if (sortClicked) {
        log(`Clicked sort dropdown (was: "${sortClicked}").`);
        await randomDelay(1500, 2500);

        // Now click "Recent activity" in the dropdown menu
        const picked = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('div[role="menuitem"], div[role="option"], div[role="menuitemradio"], div[role="radio"], span'));
          for (const item of items) {
            const text = (item.textContent || '').trim().toLowerCase();
            if (text === 'recent activity' || text.startsWith('recent activity')) {
              item.click();
              return true;
            }
          }
          return false;
        });
        if (picked) {
          log('Sorted by Recent activity.');
          await randomDelay(2000, 3000);
        } else {
          log('Could not find "Recent activity" in dropdown — using current sort.');
        }
      } else {
        log('Sort dropdown not found — using default sort.');
      }
    } catch (e) {
      log('Sort switch failed (non-fatal): ' + e.message);
    }

    log('Checking for known posts...');

    const seenData = loadSeenPosts();
    log(`Loaded ${seenData.ids.size} seen IDs + ${seenData.fingerprints.size} text fingerprints.`);
    const hasPriorData = seenData.ids.size > 0 || seenData.fingerprints.size > 0;
    let foundKnown = false;
    let scrollCount = 0;

    // Extract post text fingerprints from visible top-level posts
    // Uses the SAME normalization as textFingerprint() so matches work
    const getVisiblePostSignatures = () => page.evaluate(() => {
      const results = [];
      const articles = document.querySelectorAll('div[role="article"]');
      for (const article of articles) {
        if (article.parentElement && article.parentElement.closest('div[role="article"]')) continue;

        // Get permalink ID if available
        let postId = null;
        const links = article.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/\/permalink\/(\d+)|\/posts\/(\d+)|story_fbid=(\d+)/);
          if (match) {
            postId = match[1] || match[2] || match[3];
            break;
          }
        }

        // Get ALL text from div[dir="auto"] and pick the longest
        let text = '';
        const textEls = article.querySelectorAll('div[dir="auto"]');
        for (const el of textEls) {
          const t = (el.textContent || '').trim();
          if (t.length > text.length) text = t;
        }
        // Same normalization as textFingerprint()
        const fingerprint = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);

        if (postId || fingerprint.length > 0) {
          results.push({ postId, fingerprint });
        }
      }
      return results;
    });

    // Check BEFORE scrolling — if the initial page already has known posts, stop immediately
    if (hasPriorData) {
      await randomDelay(1000, 2000);
      const initialVisible = await getVisiblePostSignatures();
      let initialKnown = 0;
      for (const v of initialVisible) {
        if ((v.postId && seenData.ids.has(v.postId)) ||
            (v.fingerprint.length > 0 && seenData.fingerprints.has(v.fingerprint))) {
          initialKnown++;
        }
      }
      if (initialKnown >= 2) {
        log(`Found ${initialKnown} known posts on initial page load — already caught up.`);
        foundKnown = true;
      } else {
        log(`${initialKnown} known post(s) on initial load, scrolling for more...`);
      }
    }

    while (!foundKnown && scrollCount < MAX_SCROLLS) {
      const scrollAmount = 600 + Math.floor(Math.random() * 800);
      await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount);
      scrollCount++;

      const delay = 2000 + Math.random() * 3000;
      log(`Scroll ${scrollCount}/${MAX_SCROLLS}, waiting ${Math.round(delay)}ms...`);
      await randomDelay(delay, delay + 500);

      if (hasPriorData) {
        const visible = await getVisiblePostSignatures();
        let knownCount = 0;
        for (const v of visible) {
          if ((v.postId && seenData.ids.has(v.postId)) ||
              (v.fingerprint.length > 0 && seenData.fingerprints.has(v.fingerprint))) {
            knownCount++;
          }
        }
        if (knownCount >= 2) {
          log(`Found ${knownCount} known posts (by ID or text) — caught up, stopping scroll.`);
          foundKnown = true;
          break;
        }
      }
    }

    if (!foundKnown && hasPriorData) {
      log(`Hit max scrolls (${MAX_SCROLLS}) without finding a known post.`);
    }

    await randomDelay(2000, 3000);

    // Expand comments on visible posts before extracting
    log('Expanding comments...');
    const expandedCount = await page.evaluate(async () => {
      let clicked = 0;
      // Click "View more comments", "View all X comments", "X replies", etc.
      // Run multiple rounds since expanding one section may reveal more
      for (let round = 0; round < 5; round++) {
        let roundClicks = 0;
        const clickables = Array.from(document.querySelectorAll(
          'div[role="button"], span[role="button"], span[tabindex="0"], div[tabindex="0"]'
        ));
        for (const btn of clickables) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (
            text.includes('view more comment') ||
            text.includes('view all') ||
            text.includes('most relevant') ||
            text.includes('all comments') ||
            text.match(/view \d+ more comment/) ||
            text.match(/view \d+ previous/) ||
            text.match(/\d+ repl/) ||
            text.match(/see more/)
          ) {
            try { btn.click(); } catch(e) {}
            roundClicks++;
            clicked++;
            await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
          }
        }
        if (roundClicks === 0) break;
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
      await sendEmail('No posts found', '<p>Scraper ran but found 0 posts. Cookies may be stale or page structure changed.</p>');
      await browser.close();
      process.exit(0);
    }

    // Save all post IDs and text fingerprints for next run
    for (const p of posts) {
      if (!p.isComment) {
        seenData.ids.add(p.postId);
        const fp = textFingerprint(p.postText);
        if (fp.length > 0) seenData.fingerprints.add(fp);
      }
    }
    saveSeenPosts(seenData);
    log(`Saved ${seenData.ids.size} seen IDs + ${seenData.fingerprints.size} fingerprints.`);

    // Snapshot trail statuses BEFORE ingest
    const beforeStatuses = await fetchTrailStatuses();

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
      await sendEmail(`API error ${response.status}`, `<p>Scraper extracted ${posts.length} items but API returned ${response.status}:</p><pre>${errText.slice(0, 500)}</pre>`);
      process.exit(1);
    }

    const result = await response.json();
    log(`Done! stored=${result.stored}, classified=${result.classified}, verified=${result.verified || 0}`);

    // Snapshot trail statuses AFTER ingest
    const afterStatuses = await fetchTrailStatuses();

    // Build trail status table for email
    const trailNames = Object.keys(afterStatuses).sort();
    let changedCount = 0;
    const trailRows = trailNames.map(name => {
      const before = beforeStatuses[name] || 'Unknown';
      const after = afterStatuses[name] || 'Unknown';
      const changed = before !== after;
      if (changed) changedCount++;
      const style = changed ? 'background:#fff3cd;font-weight:bold' : '';
      const label = changed ? `${after} ⬅ was ${before}` : after;
      return `<tr style="${style}"><td style="padding:4px 8px">${name}</td><td style="padding:4px 8px">${label}</td></tr>`;
    }).join('');

    // Build unmatched posts section (trail-related but no trail identified)
    const unmatched = result.unmatchedPosts || [];
    const unmatchedHtml = unmatched.length > 0
      ? `<h3>⚠️ Unmatched Posts (${unmatched.length})</h3>
         <p style="font-size:12px;color:#666">These posts seem trail-related but couldn't be matched to a specific trail. You may need to add aliases.</p>
         <table style="border-collapse:collapse;font-size:13px;width:100%">
           <tr style="background:#f0f0f0"><th style="padding:4px 8px;text-align:left">Type</th><th style="padding:4px 8px;text-align:left">Post</th></tr>
           ${unmatched.map(p => `<tr><td style="padding:4px 8px;vertical-align:top;color:${p.classification === 'dry' ? 'green' : 'red'}">${p.classification}</td><td style="padding:4px 8px">${p.text}</td></tr>`).join('')}
         </table>`
      : '';

    const subject = changedCount > 0
      ? `${changedCount} trail status change${changedCount > 1 ? 's' : ''} — ${postCount} posts, ${commentCount} comments`
      : unmatched.length > 0
        ? `${unmatched.length} unmatched post${unmatched.length > 1 ? 's' : ''} — ${postCount} posts, ${commentCount} comments`
        : `${postCount} posts, ${commentCount} comments — no status changes`;

    await sendEmail(subject,
      `<h3>Scraper Run Complete</h3>
       <p>Posts: ${postCount} · Comments: ${commentCount} · Scrolls: ${scrollCount} · New stored: ${result.stored} · Classified: ${result.classified}</p>
       ${unmatchedHtml}
       <h3>Trail Statuses${changedCount > 0 ? ` (${changedCount} changed)` : ''}</h3>
       <table style="border-collapse:collapse;font-size:14px">
         <tr style="background:#f0f0f0"><th style="padding:4px 8px;text-align:left">Trail</th><th style="padding:4px 8px;text-align:left">Status</th></tr>
         ${trailRows}
       </table>`
    );

  } catch (err) {
    log(`ERROR: ${err.message}`);
    if (err.stack) log(err.stack);
    await sendEmail('Scraper error', `<p>Scraper failed:</p><pre>${err.message}\n${err.stack || ''}</pre>`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

// ── Run ──────────────────────────────────────────────────────────────
scrape();
