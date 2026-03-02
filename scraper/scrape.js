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
const MAX_SCROLLS = parseInt(process.env.MAX_SCROLLS || '5', 10); // safety cap
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
  // Normalize: lowercase, collapse whitespace, take first 80 chars
  // Using 80 chars to avoid "See more" truncation differences
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
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

// (Post extraction is now done inline during the scroll loop)

// ── Main scrape function ─────────────────────────────────────────────

async function scrape() {
  log('Starting Facebook group scrape');

  const chromePath = findChrome();
  if (!chromePath) {
    log('ERROR: Could not find Chrome or Chromium. Install google-chrome or chromium.');
    process.exit(1);
  }
  log(`Using Chrome: ${chromePath}`);

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

    if (page.url().includes('/login')) {
      log('ERROR: Not logged into Facebook!');
      await browser.close();
      process.exit(2);
    }

    // Sort by "Recent activity"
    log('Switching to Recent activity sort...');
    try {
      const sortClicked = await page.evaluate(() => {
        const allEls = Array.from(document.querySelectorAll('span, div'));
        for (const el of allEls) {
          const text = (el.textContent || '').trim().toLowerCase();
          if ((text === 'new posts' || text === 'most relevant' || text === 'recent activity') &&
              el.offsetParent !== null) {
            (el.closest('[role="button"]') || el).click();
            return text;
          }
        }
        return null;
      });
      if (sortClicked) {
        log(`Clicked sort dropdown (was: "${sortClicked}").`);
        await randomDelay(1500, 2500);
        const picked = await page.evaluate(() => {
          for (const item of document.querySelectorAll('div[role="menuitem"], div[role="option"], div[role="menuitemradio"], span')) {
            const text = (item.textContent || '').trim().toLowerCase();
            if (text === 'recent activity' || text.startsWith('recent activity')) {
              item.click();
              return true;
            }
          }
          return false;
        });
        log(picked ? 'Sorted by Recent activity.' : 'Could not find "Recent activity" in dropdown.');
        await randomDelay(2000, 3000);
      } else {
        log('Sort dropdown not found.');
      }
    } catch (e) {
      log('Sort failed (non-fatal): ' + e.message);
    }

    // Wait for feed
    log('Waiting for feed...');
    try {
      await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
    } catch (e) {
      log('Feed container not found, trying div[role="article"]...');
      try { await page.waitForSelector('div[role="article"]', { timeout: 10000 }); } catch (e2) {}
    }
    await randomDelay(2000, 3000);

    const seenData = loadSeenPosts();
    log(`Loaded ${seenData.ids.size} seen IDs + ${seenData.fingerprints.size} fingerprints.`);
    const hasPriorData = seenData.ids.size > 0 || seenData.fingerprints.size > 0;

    function isKnownFingerprint(fp) {
      if (!fp || fp.length === 0) return false;
      const fpShort = fp.slice(0, 40);
      for (const saved of seenData.fingerprints) {
        if (saved.startsWith(fpShort) || fp.startsWith(saved.slice(0, 40))) return true;
      }
      return false;
    }

    // ── Scroll + extract loop ──────────────────────────────────────
    const allPosts = [];
    const processedFingerprints = new Set();
    let scrollCount = 0;
    let consecutiveKnown = 0;
    let foundKnown = false;

    for (let round = 0; round <= MAX_SCROLLS; round++) {
      // Extract all visible top-level posts and their comments
      const postData = await page.evaluate(() => {
        const articles = document.querySelectorAll('div[role="article"]');
        const results = [];
        for (const article of articles) {
          if (article.parentElement && article.parentElement.closest('div[role="article"]')) continue;

          // Post text — try multiple strategies
          let postText = '';
          
          // Strategy 1: div[dir="auto"] with > 20 chars (standard FB post text)
          for (const el of article.querySelectorAll('div[dir="auto"]')) {
            // Skip if this element is inside a nested article (comment)
            if (el.closest('div[role="article"]') !== article) continue;
            const t = (el.textContent || '').trim();
            if (t.length > 20 && t.length > postText.length) postText = t;
          }
          
          // Strategy 2: If nothing found, try concatenating all dir="auto" text
          if (!postText) {
            const parts = [];
            for (const el of article.querySelectorAll('div[dir="auto"]')) {
              if (el.closest('div[role="article"]') !== article) continue;
              const t = (el.textContent || '').trim();
              if (t.length > 0) parts.push(t);
            }
            postText = parts.join(' ').trim();
          }
          
          // Strategy 3: If still nothing, get all text from the article excluding comments
          if (!postText) {
            const clone = article.cloneNode(true);
            // Remove nested articles (comments)
            for (const nested of clone.querySelectorAll('div[role="article"]')) {
              nested.remove();
            }
            postText = (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
          }
          if (!postText) continue;

          // Post ID
          let postId = '';
          for (const link of article.querySelectorAll('a[href]')) {
            const m = (link.getAttribute('href') || '').match(/\/permalink\/(\d+)|\/posts\/(\d+)|story_fbid=(\d+)/);
            if (m) { postId = m[1] || m[2] || m[3]; break; }
          }
          if (!postId) postId = 'pup-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

          // Author
          let authorName = 'Unknown';
          const authorEl = article.querySelector('h3 a strong, h4 a strong, a[role="link"] strong');
          if (authorEl) { const n = authorEl.textContent.trim(); if (n.length > 0 && n.length < 100) authorName = n; }

          // Timestamp
          let timestamp = new Date().toISOString();
          const timeEl = article.querySelector('a[href*="/permalink/"] span, abbr[data-utime], time[datetime]');
          if (timeEl) {
            if (timeEl.getAttribute('data-utime')) timestamp = new Date(parseInt(timeEl.getAttribute('data-utime')) * 1000).toISOString();
            else if (timeEl.getAttribute('datetime')) timestamp = new Date(timeEl.getAttribute('datetime')).toISOString();
          }

          const fingerprint = postText.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);

          // Comments inside this post
          const comments = [];
          for (const cEl of article.querySelectorAll('div[role="article"]')) {
            let cText = '';
            for (const el of cEl.querySelectorAll('div[dir="auto"]')) {
              const t = (el.textContent || '').trim();
              if (t.length > 0 && t.length > cText.length) cText = t;
            }
            if (!cText) continue;
            let cId = '';
            for (const link of cEl.querySelectorAll('a[href]')) {
              const m = (link.getAttribute('href') || '').match(/comment_id=(\d+)/);
              if (m) { cId = m[1]; break; }
            }
            if (!cId) cId = 'pup-c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            comments.push({ postId: 'c-' + cId, authorName: 'Unknown', postText: cText.slice(0, 2000), timestamp: new Date().toISOString(), isComment: true, parentPostId: postId });
          }

          results.push({ post: { postId, authorName, postText: postText.slice(0, 2000), timestamp, isComment: false, parentPostId: null }, comments, fingerprint });
        }
        return results;
      });

      // Process new posts we haven't seen in this run
      for (const item of postData) {
        if (processedFingerprints.has(item.fingerprint)) continue;
        processedFingerprints.add(item.fingerprint);

        const isKnown = hasPriorData && (seenData.ids.has(item.post.postId) || isKnownFingerprint(item.fingerprint));

        log(`${isKnown ? 'KNOWN' : 'NEW  '} ${item.post.timestamp} | ${item.post.postText.slice(0, 80)}`);
        for (const c of item.comments) {
          log(`  💬 ${c.postText.slice(0, 80)}`);
        }

        allPosts.push(item.post);
        allPosts.push(...item.comments);

        if (isKnown) {
          consecutiveKnown++;
          if (consecutiveKnown >= 2) {
            log(`Hit ${consecutiveKnown} consecutive known posts — stopping.`);
            foundKnown = true;
            break;
          }
        } else {
          consecutiveKnown = 0;
        }
      }

      if (foundKnown || round >= MAX_SCROLLS) break;

      // Scroll
      await page.evaluate((amt) => window.scrollBy(0, amt), 600 + Math.floor(Math.random() * 800));
      scrollCount++;
      log(`Scroll ${scrollCount}/${MAX_SCROLLS}...`);
      await randomDelay(2000, 2000 + Math.random() * 2000);
    }

    if (!foundKnown && hasPriorData) {
      log(`Hit max scrolls (${MAX_SCROLLS}) without finding enough known posts.`);
    }

    const posts = allPosts;
    const postCount = posts.filter(p => !p.isComment).length;
    const commentCount = posts.filter(p => p.isComment).length;
    log(`Total: ${postCount} posts + ${commentCount} comments`);

    if (posts.length === 0) {
      log('No posts found. Try HEADLESS=false to debug.');
      await sendEmail('No posts found', '<p>Scraper ran but found 0 posts.</p>');
      await browser.close();
      process.exit(0);
    }

    // Save fingerprints for next run
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
