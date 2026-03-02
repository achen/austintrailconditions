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

    const timestamp = extractTimestamp(story);
    posts.push({ postId: String(postId), authorName, postText, timestamp, comments });
  }

  return posts;
}

/**
 * Extract the post creation timestamp from a story node.
 * FB stores it as a unix epoch (seconds) in various locations.
 */
function extractTimestamp(story) {
  // Direct creation_time on the story
  if (story?.creation_time) return new Date(story.creation_time * 1000).toISOString();

  // Nested in comet_sections context
  const ctxStory = story?.comet_sections?.context_layout?.story;
  if (ctxStory?.creation_time) return new Date(ctxStory.creation_time * 1000).toISOString();

  // In comet_sections → metadata
  const metaStory = story?.comet_sections?.content?.story;
  if (metaStory?.creation_time) return new Date(metaStory.creation_time * 1000).toISOString();

  // Recursive fallback: find first creation_time in the story object
  const ts = findCreationTime(story, 0);
  if (ts) return new Date(ts * 1000).toISOString();

  return null;
}

function findCreationTime(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (typeof obj.creation_time === 'number' && obj.creation_time > 1000000000) return obj.creation_time;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findCreationTime(item, depth + 1);
      if (r) return r;
    }
  } else {
    for (const key of Object.keys(obj)) {
      const r = findCreationTime(obj[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
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
  const seen = new Set();

  // FB nests feedback in multiple places — collect all feedback objects
  const feedbacks = [
    story?.feedback,
    story?.comet_sections?.feedback?.story?.feedback,
    story?.comet_sections?.content?.story?.feedback,
  ].filter(Boolean);

  for (const fb of feedbacks) {
    // Primary path: display_comments.edges[].node
    const displayComments = fb?.display_comments?.edges
      || fb?.comment_rendering_instance?.comments?.edges
      || [];
    for (const edge of displayComments) {
      const node = edge?.node;
      if (!node) continue;
      addComment(node, comments, seen);
    }

    // Also search recursively for any Comment nodes we missed
    findCommentNodes(fb, comments, seen, 0);
  }

  return comments;
}

function addComment(node, results, seen) {
  const text = node?.body?.text || node?.message?.text;
  if (!text || text.length < 1) return;
  const fp = text.slice(0, 60).toLowerCase();
  if (seen.has(fp)) return;
  seen.add(fp);
  const author = node?.author?.name || node?.actors?.[0]?.name || 'Unknown';
  const commentId = node?.id || node?.legacy_fbid || null;
  results.push({ commentId, authorName: author, commentText: text });
}

function findCommentNodes(obj, results, seen, depth) {
  if (!obj || typeof obj !== 'object' || depth > 12) return;

  if (obj.__typename === 'Comment' && !obj.group_feed) {
    addComment(obj, results, seen);
  }

  if (Array.isArray(obj)) {
    for (const item of obj) findCommentNodes(item, results, seen, depth + 1);
  } else {
    for (const key of Object.keys(obj)) {
      // Skip keys that would lead us into post text or infinite loops
      if (key === 'message' || key === 'body' || key === 'group_feed') continue;
      findCommentNodes(obj[key], results, seen, depth + 1);
    }
  }
}

// ── Main scrape function ─────────────────────────────────────────────

/**
 * Click into each visible post to load its comments via GraphQL.
 * For each post: click the comment count link → sort by Newest → wait → close modal.
 */
async function loadCommentsForPosts(page, graphqlResponses, maxPosts = 20) {
  // First, scroll back to top so we can see all articles
  await page.evaluate(() => window.scrollTo(0, 0));
  await randomDelay(500, 800);

  // Debug: dump what clickable elements exist in the first article
  const debugInfo = await page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    if (articles.length === 0) return 'No articles found';
    const first = articles[0];
    const clickables = first.querySelectorAll('a, span[role="button"], div[role="button"], [role="link"]');
    return Array.from(clickables).slice(0, 30).map(el => {
      const text = (el.textContent || '').trim().slice(0, 60);
      const tag = el.tagName;
      const role = el.getAttribute('role') || '';
      const aria = el.getAttribute('aria-label') || '';
      return `<${tag} role="${role}" aria="${aria}"> ${text}`;
    });
  });
  log(`DEBUG article clickables: ${JSON.stringify(debugInfo, null, 2)}`);

  // Find all comment links in the feed articles
  const commentLinks = await page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    const links = [];
    for (const article of articles) {
      // Search broadly for any clickable element mentioning "comment(s)"
      const candidates = article.querySelectorAll('a, span, div[role="button"], [role="link"]');
      let found = false;
      for (const el of candidates) {
        const text = (el.textContent || '').trim().toLowerCase();
        // Match "X comments", "1 comment", "View X more comments", etc.
        if (/\d+\s+comments?/.test(text) || /^comments?$/.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.y > 0) {
            links.push({
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2,
              text: text.slice(0, 40),
              articleIdx: links.length,
            });
            found = true;
            break;
          }
        }
      }
      // Also try aria-label containing "comment"
      if (!found) {
        const ariaEls = article.querySelectorAll('[aria-label*="comment" i], [aria-label*="Comment" i]');
        for (const el of ariaEls) {
          const label = el.getAttribute('aria-label') || '';
          if (/\d+\s+comments?/i.test(label) || /^comments?$/i.test(label)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.y > 0) {
              links.push({
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                text: label.slice(0, 40),
                articleIdx: links.length,
              });
              break;
            }
          }
        }
      }
    }
    return links;
  });

  log(`Found ${commentLinks.length} comment links to click`);
  const limit = Math.min(commentLinks.length, maxPosts);

  for (let i = 0; i < limit; i++) {
    const link = commentLinks[i];
    const beforeCount = graphqlResponses.length;

    log(`  Opening comments ${i + 1}/${limit} ("${link.text}")...`);

    // Scroll the link into view first, then re-get its position and click
    await page.evaluate((y) => window.scrollTo(0, y - 300), link.y);
    await randomDelay(300, 500);

    // Re-find the link position after scroll
    const freshPos = await page.evaluate((idx) => {
      const articles = Array.from(document.querySelectorAll('div[role="article"]'));
      let count = 0;
      for (const article of articles) {
        const allLinks = article.querySelectorAll('a[role="link"], span[role="button"]');
        for (const link of allLinks) {
          const text = (link.textContent || '').trim().toLowerCase();
          if (/^\d+\s+comments?$/.test(text) || text === 'comment' || text === 'comments') {
            const rect = link.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              if (count === idx) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              count++;
              break;
            }
          }
        }
      }
      return null;
    }, i);

    if (!freshPos) { log(`    Could not find comment link ${i}, skipping`); continue; }

    await page.mouse.click(freshPos.x, freshPos.y);
    await randomDelay(1500, 2500);

    // Wait for comment GraphQL responses to arrive
    await new Promise((resolve) => {
      const check = () => {
        if (graphqlResponses.length > beforeCount) return resolve();
        setTimeout(check, 300);
      };
      setTimeout(check, 300);
      setTimeout(resolve, 5000);
    });

    // Try to sort comments by "Newest" — look for the sort dropdown
    try {
      const sorted = await page.evaluate(() => {
        // Look for "Most relevant" or sort button in the modal/expanded comments
        const buttons = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'));
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text.includes('most relevant') || text.includes('all comments')) {
            btn.click();
            return 'clicked-sort';
          }
        }
        return 'no-sort-found';
      });

      if (sorted === 'clicked-sort') {
        await randomDelay(500, 800);
        // Now click "Newest" in the dropdown
        await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('div[role="menuitem"], div[role="option"], span'));
          for (const item of items) {
            const text = (item.textContent || '').trim().toLowerCase();
            if (text === 'newest' || text === 'new') {
              item.click();
              return;
            }
          }
        });
        await randomDelay(1000, 1500);

        // Wait for sorted comments to load
        const afterSort = graphqlResponses.length;
        await new Promise((resolve) => {
          const check = () => {
            if (graphqlResponses.length > afterSort) return resolve();
            setTimeout(check, 300);
          };
          setTimeout(check, 300);
          setTimeout(resolve, 3000);
        });
      }
    } catch (e) {
      // Sort is best-effort
    }

    // Close the modal/expanded view — press Escape
    await page.keyboard.press('Escape');
    await randomDelay(500, 1000);

    // If modal is still open (sometimes needs a second Escape)
    await page.keyboard.press('Escape');
    await randomDelay(300, 500);

    log(`    +${graphqlResponses.length - beforeCount} GraphQL responses`);
  }
}

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

    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('graphql')) return;
      const status = response.status();
      if (status < 200 || status >= 300) return;

      let text;
      try { text = await response.text(); } catch { return; }

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

      // First pass: extract posts from feed data
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
      log(`Feed extraction: ${allPosts.length} unique posts`);

      // Load comments for each post
      await loadCommentsForPosts(page, graphqlResponses);

      // Second pass: re-extract with comment data now available
      allPosts = [];
      seenDebug.clear();
      for (const resp of graphqlResponses) {
        const posts = extractPostsFromGraphQL(resp);
        for (const p of posts) {
          const key = p.postText.slice(0, 120).toLowerCase();
          if (seenDebug.has(key)) continue;
          seenDebug.add(key);
          allPosts.push(p);
        }
      }

      const totalComments = allPosts.reduce((sum, p) => sum + p.comments.length, 0);
      log(`Extracted ${allPosts.length} unique posts with ${totalComments} total comments`);
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
            timestamp: post.timestamp || new Date().toISOString(),
          });
          for (let i = 0; i < (post.comments || []).length; i++) {
            const c = post.comments[i];
            if (!c.commentText) continue;
            allExtracted.push({
              postId: c.commentId || `${postId}-c${i}`,
              authorName: c.authorName || 'Unknown',
              postText: c.commentText.slice(0, 2000),
              timestamp: post.timestamp || new Date().toISOString(),
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

    // ── Load comments for visible posts ────────────────────────────
    log('Loading comments for posts...');
    await loadCommentsForPosts(page, graphqlResponses);
    // Re-process to pick up newly loaded comments
    processGraphQLData();

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
