#!/usr/bin/env node
/**
 * Facebook Group Scraper for Austin Trail Conditions.
 *
 * Uses your system Chrome (not Puppeteer's bundled Chromium) with a
 * separate profile directory copied from your real one.
 *
 * All text extraction is done by AI (gpt-5.2) — no brittle DOM selectors.
 * The scraper just grabs raw HTML of each post article and sends it to
 * OpenAI, which returns structured JSON with post text, comments, and IDs.
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
const MAX_SCROLLS = parseInt(process.env.MAX_SCROLLS || '5', 10);
const HEADLESS = process.env.HEADLESS !== 'false';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Email config
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'info@austintrailconditions.com';

const SEEN_FILE = path.join(__dirname, '.seen-posts.json');
const SOURCE_PROFILE = process.env.CHROME_PROFILE || path.join(os.homedir(), '.config', 'google-chrome');
const SCRAPER_PROFILE = path.join(__dirname, '.chrome-profile');

if (!API_SECRET) { console.error('Missing API_SECRET in .env'); process.exit(1); }
if (!OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY in .env'); process.exit(1); }

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function randomDelay(minMs, maxMs) {
  return new Promise(resolve => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

// ── Find system Chrome ───────────────────────────────────────────────

function findChrome() {
  const candidates = [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium',
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try {
    return execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf-8' }).trim();
  } catch { return null; }
}

// ── Copy Chrome profile ──────────────────────────────────────────────

function syncProfile() {
  if (!fs.existsSync(SOURCE_PROFILE)) {
    log(`ERROR: Chrome profile not found at ${SOURCE_PROFILE}`);
    process.exit(1);
  }
  const src = path.join(SOURCE_PROFILE, 'Default');
  const dest = path.join(SCRAPER_PROFILE, 'Default');
  if (!fs.existsSync(src)) { log(`ERROR: No Default profile at ${src}`); process.exit(1); }

  log('Syncing Chrome profile...');
  try {
    execSync(`rsync -a --delete \
      --include="Cookies" --include="Cookies-journal" \
      --include="Login Data" --include="Login Data-journal" \
      --include="Local Storage/***" --include="Session Storage/***" \
      --include="Preferences" --include="Secure Preferences" \
      --include="Local Storage/" --include="Session Storage/" \
      --exclude="*" "${src}/" "${dest}/"`, { stdio: 'pipe' });
    log('Profile synced.');
  } catch {
    log('rsync failed, fallback copy...');
    execSync(`mkdir -p "${dest}" && cp -r "${src}/Cookies" "${src}/Cookies-journal" "${dest}/" 2>/dev/null || true`);
    execSync(`cp -r "${src}/Local Storage" "${dest}/" 2>/dev/null || true`);
    execSync(`cp -r "${src}/Preferences" "${dest}/" 2>/dev/null || true`);
  }
}

// ── Seen posts (uses AI-extracted post text for fingerprinting) ──────

function loadSeenPosts() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
      return {
        ids: new Set(data.postIds || []),
        fingerprints: new Set(data.fingerprints || []),
      };
    }
  } catch { log('Could not load seen posts, starting fresh.'); }
  return { ids: new Set(), fingerprints: new Set() };
}

function saveSeenPosts(seenData) {
  const ids = Array.from(seenData.ids).slice(-500);
  const fingerprints = Array.from(seenData.fingerprints).slice(-500);
  fs.writeFileSync(SEEN_FILE, JSON.stringify({ postIds: ids, fingerprints, updatedAt: new Date().toISOString() }));
}

function makeFingerprint(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

function isKnownPost(seenData, postId, fingerprint) {
  if (seenData.ids.has(postId)) return true;
  if (!fingerprint || fingerprint.length === 0) return false;
  const fpShort = fingerprint.slice(0, 40);
  for (const saved of seenData.fingerprints) {
    if (saved.startsWith(fpShort) || fingerprint.startsWith(saved.slice(0, 40))) return true;
  }
  return false;
}

// ── Email ────────────────────────────────────────────────────────────

async function sendEmail(subject, html) {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: ALERT_EMAIL, subject: `[Trail Scraper] ${subject}`, html }),
    });
    if (!res.ok) log(`Email send failed: ${res.status}`);
  } catch (e) { log(`Email error: ${e.message}`); }
}

// ── Fetch trail statuses ─────────────────────────────────────────────

async function fetchTrailStatuses() {
  try {
    const res = await fetch(`${API_URL}/api/trails`);
    if (!res.ok) return {};
    const trails = await res.json();
    const map = {};
    for (const t of trails) map[t.name] = t.conditionStatus;
    return map;
  } catch { return {}; }
}

// ── AI extraction ────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are parsing the HTML of a single Facebook group post. The HTML is the innerHTML of a top-level div[role="article"].

STRUCTURE:
- The MAIN POST text and author are at the top level of this article
- COMMENTS are inside NESTED div[role="article"] elements within this article
- The main post text is NOT inside any nested div[role="article"]

EXTRACT:
1. postId: Look for permalink URLs like /permalink/123456, /posts/123456, or story_fbid=123456. Extract the numeric ID.
2. postText: The main post content written by the original poster. This is NOT a comment. Look for div[dir="auto"] elements that are NOT inside nested div[role="article"] elements.
3. authorName: The name of the person who wrote the main post (usually in a strong or heading element near the top).
4. comments: Array of comments. Each comment is inside a nested div[role="article"]. Extract commentId (from comment_id= in URLs), authorName, and commentText.

IMPORTANT:
- Do NOT confuse comments with the main post. If you only find text inside nested articles, those are comments, not the post.
- Ignore UI text: "Like", "Reply", "Share", "Write a comment", reaction counts, timestamps, "See more", "Most relevant", etc.
- If the main post has no visible text (e.g. it's just a photo), set postText to null.

Return JSON:
{
  "postId": "numeric_id_or_null",
  "postText": "the main post text or null",
  "authorName": "Author Name",
  "comments": [
    {"commentId": "id_or_null", "authorName": "Name", "commentText": "text"}
  ]
}`;

async function extractPostFromHtml(html) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: html.slice(0, 100000) },
        ],
        temperature: 0,
        max_completion_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      log(`  OpenAI error ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    return JSON.parse(content);
  } catch (e) {
    log(`  AI extraction failed: ${e.message}`);
    return null;
  }
}

// ── Main scrape function ─────────────────────────────────────────────

async function scrape() {
  log('Starting Facebook group scrape');

  const chromePath = findChrome();
  if (!chromePath) { log('ERROR: Chrome not found.'); process.exit(1); }
  log(`Using Chrome: ${chromePath}`);

  syncProfile();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS ? 'new' : false,
      executablePath: chromePath,
      userDataDir: SCRAPER_PROFILE,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
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

    // Debug mode: dump first article HTML and exit (before sort)
    if (process.env.DEBUG_FIRST === 'true') {
      log('DEBUG_FIRST mode — waiting for feed...');
      try { await page.waitForSelector('div[role="feed"]', { timeout: 15000 }); } catch {}
      await randomDelay(3000, 5000);

      // Dump all article info
      const debugInfo = await page.evaluate(() => {
        const articles = document.querySelectorAll('div[role="article"]');
        const info = [];
        for (const article of articles) {
          const isNested = article.parentElement && article.parentElement.closest('div[role="article"]');
          const hasDirAuto = !!article.querySelector('div[dir="auto"]');
          const hasLoading = !!article.querySelector('[aria-label="Loading..."]');
          const textLen = (article.textContent || '').length;
          const htmlLen = article.innerHTML.length;
          info.push({ isNested: !!isNested, hasDirAuto, hasLoading, textLen, htmlLen });
        }
        return info;
      });
      log(`Found ${debugInfo.length} total article elements:`);
      debugInfo.forEach((a, i) => log(`  #${i}: nested=${a.isNested} hasDirAuto=${a.hasDirAuto} hasLoading=${a.hasLoading} text=${a.textLen}chars html=${a.htmlLen}chars`));

      // Print first non-nested article HTML regardless of content
      const firstHtml = await page.evaluate(() => {
        for (const article of document.querySelectorAll('div[role="article"]')) {
          if (article.parentElement && article.parentElement.closest('div[role="article"]')) continue;
          return article.outerHTML;
        }
        return null;
      });
      if (firstHtml) {
        console.log('\n--- FIRST ARTICLE HTML ---');
        console.log(firstHtml);
        console.log('--- END ---');
      } else {
        log('No top-level articles found!');
      }
      await browser.close();
      process.exit(0);
    }

    // Sort by "Recent activity"
    log('Switching to Recent activity sort...');
    try {
      const sortClicked = await page.evaluate(() => {
        for (const el of document.querySelectorAll('span, div')) {
          const text = (el.textContent || '').trim().toLowerCase();
          if ((text === 'new posts' || text === 'most relevant' || text === 'recent activity') && el.offsetParent !== null) {
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
            if ((item.textContent || '').trim().toLowerCase().startsWith('recent activity')) { item.click(); return true; }
          }
          return false;
        });
        log(picked ? 'Sorted by Recent activity.' : 'Could not find "Recent activity" option.');
        await randomDelay(2000, 3000);
      }
    } catch (e) { log('Sort failed (non-fatal): ' + e.message); }

    // Wait for feed
    try { await page.waitForSelector('div[role="feed"]', { timeout: 15000 }); }
    catch { try { await page.waitForSelector('div[role="article"]', { timeout: 10000 }); } catch {} }
    await randomDelay(2000, 3000);

    // Wait for posts to finish loading
    log('Waiting for posts to load...');
    await page.waitForFunction(() => {
      // Wait until at least one article has actual content (div[dir="auto"])
      for (const article of document.querySelectorAll('div[role="article"]')) {
        if (article.parentElement && article.parentElement.closest('div[role="article"]')) continue;
        if (article.querySelector('div[dir="auto"]')) return true;
      }
      return false;
    }, { timeout: 20000 }).catch(() => log('No loaded articles found after 20s, continuing anyway.'));
    await randomDelay(1000, 2000);

    // Switch comment sort to "Newest"
    async function sortCommentsNewest() {
      const switched = await page.evaluate(async () => {
        let count = 0;
        for (const btn of document.querySelectorAll('div[role="button"], span[role="button"]')) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'most relevant' || text === 'all comments') {
            btn.click(); count++;
            await new Promise(r => setTimeout(r, 800));
            for (const item of document.querySelectorAll('div[role="menuitem"], div[role="option"], span')) {
              if ((item.textContent || '').trim().toLowerCase().startsWith('newest')) {
                item.click(); await new Promise(r => setTimeout(r, 500)); break;
              }
            }
          }
        }
        return count;
      });
      if (switched > 0) log(`Switched ${switched} comment section(s) to Newest.`);
    }

    const seenData = loadSeenPosts();
    log(`Loaded ${seenData.ids.size} seen IDs + ${seenData.fingerprints.size} fingerprints.`);
    const hasPriorData = seenData.ids.size > 0 || seenData.fingerprints.size > 0;

    // ── Scroll + extract loop ──────────────────────────────────────
    const allExtracted = [];     // final extracted posts+comments for API
    const processedHtmlHashes = new Set(); // avoid re-processing same article
    let scrollCount = 0;
    let consecutiveKnown = 0;
    let foundKnown = false;

    for (let round = 0; round <= MAX_SCROLLS; round++) {
      await sortCommentsNewest();
      await randomDelay(500, 1000);

      // Click all "See more" links to expand truncated posts
      await page.evaluate(async () => {
        const links = document.querySelectorAll('div[role="button"], span[role="button"]');
        for (const link of links) {
          if ((link.textContent || '').trim().toLowerCase() === 'see more') {
            link.click();
            await new Promise(r => setTimeout(r, 300));
          }
        }
      });
      await randomDelay(500, 1000);

      // Grab raw HTML of each top-level article (skip loading skeletons)
      const articleHtmls = await page.evaluate(() => {
        const results = [];
        for (const article of document.querySelectorAll('div[role="article"]')) {
          if (article.parentElement && article.parentElement.closest('div[role="article"]')) continue;
          // Skip skeletons — real posts have div[dir="auto"] with text
          if (!article.querySelector('div[dir="auto"]')) continue;
          results.push(article.innerHTML);
        }
        return results;
      });

      log(`Round ${round}: ${articleHtmls.length} articles on page`);

      for (const html of articleHtmls) {
        // Dedup: use a chunk from the middle of the HTML (avoids header/footer sameness)
        const mid = Math.floor(html.length / 2);
        const hash = html.slice(mid, mid + 500);
        if (processedHtmlHashes.has(hash)) continue;
        processedHtmlHashes.add(hash);

        // Send to AI — raw HTML, no processing
        const result = await extractPostFromHtml(html);

        if (!result || !result.postText) {
          log(`  ⬚ (${Math.round(html.length / 1024)}KB) — no post text extracted`);
          continue;
        }

        const postId = result.postId || ('pup-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
        const fp = makeFingerprint(result.postText);
        const known = hasPriorData && isKnownPost(seenData, postId, fp);
        const commentCount = (result.comments || []).length;

        log(`  ${known ? 'KNOWN' : 'NEW  '} [${postId}] ${result.authorName}: ${result.postText.slice(0, 120)}`);
        log(`         ${commentCount} comment(s)`);
        for (const c of (result.comments || [])) {
          log(`         💬 ${c.authorName}: ${(c.commentText || '').slice(0, 100)}`);
        }

        // Save to seen data
        seenData.ids.add(postId);
        if (fp) seenData.fingerprints.add(fp);

        // Build posts for API
        allExtracted.push({
          postId,
          authorName: result.authorName || 'Unknown',
          postText: result.postText.slice(0, 2000),
          timestamp: new Date().toISOString(),
        });
        for (let i = 0; i < (result.comments || []).length; i++) {
          const c = result.comments[i];
          if (!c.commentText) continue;
          allExtracted.push({
            postId: c.commentId || `${postId}-c${i}`,
            authorName: c.authorName || 'Unknown',
            postText: c.commentText.slice(0, 2000),
            timestamp: new Date().toISOString(),
          });
        }

        if (known) {
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

      await page.evaluate((amt) => window.scrollBy(0, amt), 600 + Math.floor(Math.random() * 800));
      scrollCount++;
      log(`Scroll ${scrollCount}/${MAX_SCROLLS}...`);
      await randomDelay(2000, 4000);
      // Wait for new posts to finish loading
      await page.waitForFunction((prevCount) => {
        let count = 0;
        for (const article of document.querySelectorAll('div[role="article"]')) {
          if (article.parentElement && article.parentElement.closest('div[role="article"]')) continue;
          if (article.querySelector('div[dir="auto"]')) count++;
        }
        return count > prevCount;
      }, { timeout: 10000 }, processedHtmlHashes.size).catch(() => {});
    }

    if (!foundKnown && hasPriorData) {
      log(`Hit max scrolls (${MAX_SCROLLS}) without finding enough known posts.`);
    }

    saveSeenPosts(seenData);
    log(`Saved ${seenData.ids.size} seen IDs + ${seenData.fingerprints.size} fingerprints.`);

    const postCount = allExtracted.filter(p => !p.postId.includes('-c')).length;
    const commentCount = allExtracted.length - postCount;
    log(`Total: ${postCount} posts + ${commentCount} comments`);

    if (allExtracted.length === 0) {
      log('Nothing extracted. Try HEADLESS=false to debug.');
      await sendEmail('No posts found', '<p>Scraper ran but extracted 0 items.</p>');
      await browser.close();
      process.exit(0);
    }

    // Send to ingest API
    const beforeStatuses = await fetchTrailStatuses();

    log(`Sending ${allExtracted.length} items to ${API_URL}/api/scrape/ingest`);
    const response = await fetch(`${API_URL}/api/scrape/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_SECRET}` },
      body: JSON.stringify({ posts: allExtracted }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      log(`API error ${response.status}: ${errText.slice(0, 500)}`);
      await sendEmail(`API error ${response.status}`, `<pre>${errText.slice(0, 500)}</pre>`);
      process.exit(1);
    }

    const result = await response.json();
    log(`Done! stored=${result.stored}, classified=${result.classified}, verified=${result.verified || 0}`);

    const afterStatuses = await fetchTrailStatuses();
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

    const unmatched = result.unmatchedPosts || [];
    const unmatchedHtml = unmatched.length > 0
      ? `<h3>⚠️ Unmatched (${unmatched.length})</h3>
         <table style="border-collapse:collapse;font-size:13px;width:100%">
           ${unmatched.map(p => `<tr><td style="padding:4px 8px;color:${p.classification === 'dry' ? 'green' : 'red'}">${p.classification}</td><td style="padding:4px 8px">${p.text}</td></tr>`).join('')}
         </table>`
      : '';

    const subject = changedCount > 0
      ? `${changedCount} trail change${changedCount > 1 ? 's' : ''} — ${postCount} posts`
      : `${postCount} posts, ${commentCount} comments — no changes`;

    await sendEmail(subject,
      `<h3>Scraper Run</h3>
       <p>Posts: ${postCount} · Comments: ${commentCount} · Scrolls: ${scrollCount} · Stored: ${result.stored} · Classified: ${result.classified}</p>
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
    await sendEmail('Scraper error', `<pre>${err.message}\n${err.stack || ''}</pre>`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

scrape();
