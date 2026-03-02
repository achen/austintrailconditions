#!/usr/bin/env node
/**
 * Facebook Group Scraper for Austin Trail Conditions.
 *
 * Intercepts Facebook's GraphQL responses to extract post data directly
 * from the API layer — no DOM parsing or AI needed for extraction.
 *
 * Uses your system Chrome with a separate profile directory.
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

// Email config
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'info@austintrailconditions.com';

const SEEN_FILE = path.join(__dirname, '.seen-posts.json');
const SOURCE_PROFILE = process.env.CHROME_PROFILE || path.join(os.homedir(), '.config', 'google-chrome');
const SCRAPER_PROFILE = path.join(__dirname, '.chrome-profile');

if (!API_SECRET) { console.error('Missing API_SECRET in .env'); process.exit(1); }

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

// ── Seen posts ───────────────────────────────────────────────────────

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

// ── GraphQL response parser ──────────────────────────────────────────

/**
 * Extract post text from a story node.
 * FB puts it in different places depending on the message rendering strategy.
 */
function extractText(story) {
  // 1) Direct message.text on the story
  if (story?.message?.text) return story.message.text;

  // 2) Nested in comet_sections → content → story → comet_sections → message → story → message.text
  const msgStory = story?.comet_sections?.content?.story?.comet_sections?.message?.story;
  if (msgStory?.message?.text) return msgStory.message.text;

  // 3) Rich message (multiple blocks joined)
  const richMsg = msgStory?.rich_message;
  if (Array.isArray(richMsg)) {
    const text = richMsg.map(b => b.text || '').join('\n').trim();
    if (text) return text;
  }

  // 4) message_container fallback
  const container = story?.comet_sections?.content?.story?.comet_sections?.message_container?.story;
  if (container?.message?.text) return container.message.text;

  return null;
}

/**
 * Extract posts from a single GraphQL response.
 * Handles two formats:
 *   1) data.node.group_feed.edges[].node (batch)
 *   2) data.node (streamed individual story, with label containing "group_feed")
 */
function extractPostsFromGraphQL(responseObj) {
  const stories = [];

  // Format 1: batch edges
  const edges = responseObj?.data?.node?.group_feed?.edges;
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      if (edge?.node?.__typename === 'Story') stories.push(edge.node);
    }
  }

  // Format 2: streamed individual story
  if (responseObj?.label && responseObj.label.includes('group_feed') && responseObj?.data?.node?.__typename === 'Story') {
    stories.push(responseObj.data.node);
  }

  // Extract post data from each story
  const posts = [];
  for (const story of stories) {
    const postText = extractText(story);
    if (!postText || postText.length < 3) continue;

    const postId = story.post_id || pickBestId(story);
    const authorName = story.feedback?.owning_profile?.name || pickAuthor(story) || 'Unknown';
    const comments = extractCommentsFromStory(story);

    posts.push({ postId: String(postId), authorName, postText, comments });
  }

  return posts;
}

/**
 * Pick the best stable ID for a story node.
 */
function pickBestId(story) {
  if (story?.post_id && /^\d+$/.test(String(story.post_id))) return String(story.post_id);
  if (story?.id) {
    try {
      const decoded = Buffer.from(story.id, 'base64').toString('utf-8');
      const match = decoded.match(/(\d{10,})/);
      if (match) return match[1];
    } catch {}
    if (/^\d+$/.test(String(story.id))) return String(story.id);
  }
  return String(story?.id || 'gql-' + Date.now());
}

/** Pick author from various locations in the story */
function pickAuthor(story) {
  return (
    story?.feedback?.owning_profile?.name ||
    story?.actors?.[0]?.name ||
    story?.comet_sections?.context_layout?.story?.comet_sections?.actor_photo?.story?.actors?.[0]?.name ||
    null
  );
}

/** Extract comments from a story's feedback structure */
function extractCommentsFromStory(story) {
  const comments = [];
  const feedback = story?.feedback || story?.comet_sections?.feedback;
  if (!feedback) return comments;
  findCommentNodes(feedback, comments, new Set());
  return comments;
}

function findCommentNodes(obj, results, seenTexts, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 15) return;

  if ((obj.__typename === 'Comment' || obj.body?.text) && !obj.group_feed) {
    const text = obj.body?.text || obj.message?.text;
    if (text && text.length >= 1) {
      const fp = text.slice(0, 60).toLowerCase();
      if (!seenTexts.has(fp)) {
        seenTexts.add(fp);
        const author = obj.author?.name || obj.actors?.[0]?.name || 'Unknown';
        const commentId = obj.id || null;
        results.push({ commentId, authorName: author, commentText: text });
      }
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) findCommentNodes(item, results, seenTexts, depth + 1);
  } else {
    for (const key of Object.keys(obj)) {
      if (key === 'message' || key === 'body') continue;
      findCommentNodes(obj[key], results, seenTexts, depth + 1);
    }
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

    // ── Intercept GraphQL requests + responses ────────────────────
    const graphqlResponses = [];
    const gqlHits = []; // post-like responses for debugging

    // Log outgoing GraphQL requests (doc_id, friendly name, variables)
    page.on('request', (req) => {
      const url = req.url();
      if (!url.includes('graphql')) return;
      if (req.method() !== 'POST') return;
      const body = req.postData() || '';
      const docId = (body.match(/doc_id=(\d+)/) || [])[1];
      let variables = null;
      const m = body.match(/variables=([^&]+)/);
      if (m) {
        try { variables = JSON.parse(decodeURIComponent(m[1])); } catch {}
      }
      const friendly = (body.match(/fb_api_req_friendly_name=([^&]+)/) || [])[1];
      const varsStr = variables ? JSON.stringify(variables) : '';
      const seemsGroup = varsStr.includes('325119181430845') || varsStr.includes('"group"');
      if (docId || friendly) {
        log(`[GQL REQ] docId=${docId} friendly=${friendly ? decodeURIComponent(friendly) : '-'} group=${seemsGroup}`);
        if (variables) log(`  vars: ${JSON.stringify(Object.keys(variables).slice(0, 15))}`);
        if (seemsGroup) log(`  FULL VARS: ${varsStr.slice(0, 500)}`);
      }
    });

    function looksLikePostsPayload(text) {
      return (
        text.includes('"story"') ||
        text.includes('"stories"') ||
        text.includes('"feed"') ||
        text.includes('"edges"') ||
        (text.includes('"group"') && text.includes('"node"'))
      );
    }

    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('graphql')) return;
      const status = response.status();
      if (status < 200 || status >= 300) return;

      let text;
      try { text = await response.text(); } catch { return; }

      // Track post-like payloads for debugging
      if (looksLikePostsPayload(text)) {
        gqlHits.push({ url, status, len: text.length, sample: text.slice(0, 300) });
        if (gqlHits.length <= 5) {
          log(`POST-LIKE GraphQL #${gqlHits.length - 1} len=${text.length}`);
        }
      }

      // Parse all GraphQL responses (FB sometimes returns multiple JSON per line)
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          graphqlResponses.push(json);
        } catch {}
      }
    });

    log('Navigating to group (discussion tab)...');
    await page.goto(FB_GROUP + '?sorting_setting=CHRONOLOGICAL', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Scroll to trigger the feed GraphQL query
    await randomDelay(2000, 3000);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await randomDelay(1000, 1500);
    }
    // Wait for network to settle
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => {});
    log(`Page loaded. ${graphqlResponses.length} GraphQL responses captured.`);
    await randomDelay(3000, 5000);

    if (page.url().includes('/login')) {
      log('ERROR: Not logged into Facebook!');
      await browser.close();
      process.exit(2);
    }

    // ── DEBUG_FIRST: extract and print structured posts as JSON ───
    if (process.env.DEBUG_FIRST === 'true') {
      log(`DEBUG_FIRST — ${graphqlResponses.length} GraphQL responses`);

      let allPosts = [];
      const seenDebug = new Set();
      for (const resp of graphqlResponses) {
        const posts = extractPostsFromGraphQL(resp);
        for (const p of posts) {
          const key = p.postText.slice(0, 120).toLowerCase();
          if (seenDebug.has(key)) continue;
          seenDebug.add(key);
          allPosts.push(p);
        }
      }

      log(`Extracted ${allPosts.length} unique posts`);
      console.log(JSON.stringify(allPosts, null, 2));

      await browser.close();
      process.exit(0);
    }

    // Sort is handled by ?sorting_setting=CHRONOLOGICAL in the URL
    // Scroll to trigger feed loading
    log('Scrolling to trigger feed load...');
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await randomDelay(1000, 1500);
    }
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => {});
    log(`Feed load: ${graphqlResponses.length} GraphQL responses total.`);

    // ── Extract posts from all GraphQL data so far ─────────────────
    const seenData = loadSeenPosts();
    log(`Loaded ${seenData.ids.size} seen IDs + ${seenData.fingerprints.size} fingerprints.`);
    const hasPriorData = seenData.ids.size > 0 || seenData.fingerprints.size > 0;

    const allExtracted = [];
    const processedPostIds = new Set();
    let consecutiveKnown = 0;
    let foundKnown = false;
    let scrollCount = 0;

    function processGraphQLData() {
      for (const response of graphqlResponses) {
        const posts = extractPostsFromGraphQL(response);
        for (const post of posts) {
          const postId = post.postId || ('gql-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
          if (processedPostIds.has(postId)) continue;
          processedPostIds.add(postId);

          const fp = makeFingerprint(post.postText);
          // Also check fingerprint dedup
          if (fp && processedPostIds.has('fp:' + fp)) continue;
          if (fp) processedPostIds.add('fp:' + fp);

          const known = hasPriorData && isKnownPost(seenData, postId, fp);
          const commentCount = (post.comments || []).length;

          log(`  ${known ? 'KNOWN' : 'NEW  '} [${postId}] ${post.authorName}: ${post.postText.slice(0, 120)}`);
          log(`         ${commentCount} comment(s)`);
          for (const c of post.comments) {
            log(`         💬 ${c.authorName}: ${(c.commentText || '').slice(0, 100)}`);
          }

          seenData.ids.add(postId);
          if (fp) seenData.fingerprints.add(fp);

          allExtracted.push({
            postId,
            authorName: post.authorName || 'Unknown',
            postText: post.postText.slice(0, 2000),
            timestamp: new Date().toISOString(),
          });
          for (let i = 0; i < (post.comments || []).length; i++) {
            const c = post.comments[i];
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
              return;
            }
          } else {
            consecutiveKnown = 0;
          }
        }
      }
    }

    // Process initial page load data
    log('Processing initial GraphQL data...');
    processGraphQLData();

    // ── Scroll loop to load more posts ─────────────────────────────
    for (let round = 0; round < MAX_SCROLLS && !foundKnown; round++) {
      const beforeCount = graphqlResponses.length;
      await page.evaluate((amt) => window.scrollBy(0, amt), 300 + Math.floor(Math.random() * 400));
      scrollCount++;
      log(`Scroll ${scrollCount}/${MAX_SCROLLS}...`);
      await randomDelay(2000, 4000);

      // Wait for new GraphQL responses
      await new Promise((resolve) => {
        const check = () => {
          if (graphqlResponses.length > beforeCount) return resolve();
          setTimeout(check, 500);
        };
        setTimeout(check, 500);
        setTimeout(resolve, 10000); // timeout after 10s
      });

      log(`  ${graphqlResponses.length - beforeCount} new GraphQL responses.`);
      processGraphQLData();
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

    // ── Send to ingest API ─────────────────────────────────────────
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
