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
const FB_GROUP_ID = '325119181430845';
const MAX_SCROLLS = parseInt(process.env.MAX_SCROLLS || '5', 10);
const HEADLESS = process.env.HEADLESS !== 'false';

// Email config
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'info@austintrailconditions.com';

const SOURCE_PROFILE = process.env.CHROME_PROFILE || path.join(os.homedir(), '.config', 'google-chrome');
const SCRAPER_PROFILE = path.join(__dirname, '.chrome-profile');

if (!API_SECRET) { console.error('Missing API_SECRET in .env'); process.exit(1); }

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function randomDelay(minMs, maxMs) {
  return new Promise(resolve => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

/**
 * Convert a relative timestamp like "1w", "2d", "3h", "45m" to an ISO date string.
 * Falls back to current time if unparseable.
 */
function relativeTimestampToISO(rel) {
  if (!rel) return new Date().toISOString();
  // Already an ISO string?
  if (rel.includes('T') || rel.includes('-')) {
    const d = new Date(rel);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const match = rel.match(/^(\d+)\s*([smhdwy])$/i);
  if (!match) return new Date().toISOString();
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31536000000 };
  return new Date(Date.now() - num * (ms[unit] || 0)).toISOString();
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

// ── Seen posts (via API) ─────────────────────────────────────────────

/**
 * Check which post/comment IDs already exist in the database via the API.
 * Returns { seenPostIds: Set, seenCommentIds: Set }
 */
async function checkSeenIds(postIds, commentIds) {
  try {
    const res = await fetch(`${API_URL}/api/scrape/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_SECRET}` },
      body: JSON.stringify({ postIds: Array.from(postIds), commentIds: Array.from(commentIds) }),
    });
    if (!res.ok) {
      log(`Seen-check API error: ${res.status}`);
      return { seenPostIds: new Set(), seenCommentIds: new Set() };
    }
    const data = await res.json();
    return {
      seenPostIds: new Set(data.seenPostIds || []),
      seenCommentIds: new Set(data.seenCommentIds || []),
    };
  } catch (e) {
    log(`Seen-check failed: ${e.message}`);
    return { seenPostIds: new Set(), seenCommentIds: new Set() };
  }
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
 * 
 * Only returns posts that belong to the target group (FB_GROUP_ID).
 */
function extractPostsFromGraphQL(responseObj) {
  const stories = [];

  // Format 1: batch edges - also capture the parent group ID
  const groupNode = responseObj?.data?.node;
  const parentGroupId = groupNode?.id ? extractGroupIdFromNode(groupNode) : null;
  
  const edges = groupNode?.group_feed?.edges;
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      if (edge?.node?.__typename === 'Story') {
        edge.node._parentGroupId = parentGroupId;
        stories.push(edge.node);
      }
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

    // Validate this post belongs to our target group
    const storyGroupId = extractGroupIdFromStory(story);
    if (storyGroupId && storyGroupId !== FB_GROUP_ID) {
      // Post is from a different group - skip it
      log(`  Skipping post from different group (${storyGroupId}): ${postText.slice(0, 50)}...`);
      continue;
    }

    const postId = story.post_id || pickBestId(story);
    const authorName = story.feedback?.owning_profile?.name || pickAuthor(story) || 'Unknown';
    const comments = extractCommentsFromStory(story);

    const timestamp = extractTimestamp(story);
    posts.push({ postId: String(postId), authorName, postText, timestamp, comments });
  }

  return posts;
}

/**
 * Extract group ID from a group node (the parent of group_feed).
 */
function extractGroupIdFromNode(node) {
  if (!node?.id) return null;
  try {
    // FB encodes IDs as base64, e.g., "Group:325119181430845"
    const decoded = Buffer.from(node.id, 'base64').toString('utf-8');
    const match = decoded.match(/Group:(\d+)/);
    if (match) return match[1];
    // Fallback: raw numeric ID
    if (/^\d+$/.test(node.id)) return node.id;
  } catch {}
  return null;
}

/**
 * Extract the group ID from a story node.
 * FB stores group info in various locations within the story structure.
 */
function extractGroupIdFromStory(story) {
  // Check _parentGroupId set during extraction
  if (story._parentGroupId) return story._parentGroupId;
  
  // Check feedback.owning_profile for group info
  const owningProfile = story?.feedback?.owning_profile;
  if (owningProfile?.id) {
    try {
      const decoded = Buffer.from(owningProfile.id, 'base64').toString('utf-8');
      const match = decoded.match(/Group:(\d+)/);
      if (match) return match[1];
    } catch {}
  }
  
  // Check comet_sections for group context
  const contextStory = story?.comet_sections?.context_layout?.story;
  const groupLink = contextStory?.comet_sections?.title?.story?.attached_story?.target;
  if (groupLink?.id) {
    try {
      const decoded = Buffer.from(groupLink.id, 'base64').toString('utf-8');
      const match = decoded.match(/Group:(\d+)/);
      if (match) return match[1];
    } catch {}
    if (/^\d+$/.test(groupLink.id)) return groupLink.id;
  }
  
  // Search recursively for group ID in the story
  return findGroupId(story, 0);
}

/**
 * Recursively search for a group ID in an object.
 */
function findGroupId(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  
  // Look for __typename === 'Group' with an id
  if (obj.__typename === 'Group' && obj.id) {
    try {
      const decoded = Buffer.from(obj.id, 'base64').toString('utf-8');
      const match = decoded.match(/Group:(\d+)/);
      if (match) return match[1];
    } catch {}
    if (/^\d+$/.test(obj.id)) return obj.id;
  }
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findGroupId(item, depth + 1);
      if (r) return r;
    }
  } else {
    for (const key of Object.keys(obj)) {
      if (key === 'message' || key === 'body' || key === 'comments') continue;
      const r = findGroupId(obj[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
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
 * Visit each post's permalink and extract comments from the DOM.
 * FB renders comments server-side — GraphQL interception doesn't capture them.
 * Returns a Map of postId -> [{commentId, authorName, commentText}]
 */
async function loadCommentsViaPermalinks(page, posts, groupId = '325119181430845') {
  const commentsByPost = new Map();
  const postsWithComments = posts.filter(p => p.postId && /^\d+$/.test(p.postId));
  let consecutiveFullyKnown = 0;

  log(`Loading comments for ${postsWithComments.length} posts via permalinks...`);

  for (let i = 0; i < postsWithComments.length; i++) {
    const post = postsWithComments[i];
    const url = `https://www.facebook.com/groups/${groupId}/permalink/${post.postId}/`;

    try {
      log(`  [${i + 1}/${postsWithComments.length}] Visiting post ${post.postId}...`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomDelay(2000, 3000);

      // Scroll down to ensure comments are rendered
      for (let s = 0; s < 3; s++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await randomDelay(800, 1200);
      }

      // Sort comments by Newest
      try {
        const clickedSort = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'));
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text.includes('most relevant') || text.includes('all comments') || text.includes('newest')) {
              btn.click();
              return true;
            }
          }
          return false;
        });
        if (clickedSort) {
          await randomDelay(500, 800);
          // Click "Newest" in the dropdown menu
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
          await randomDelay(1500, 2000);
        }
      } catch (e) { /* sort is best-effort */ }

      // Extract comments from the DOM
      const comments = await page.evaluate(() => {
        const results = [];
        const articles = Array.from(document.querySelectorAll('div[role="article"]'));
        if (articles.length <= 1) return results;

        for (let idx = 1; idx < articles.length; idx++) {
          const article = articles[idx];

          // Author
          let author = 'Unknown';
          const authorLink = article.querySelector('a[role="link"] span');
          if (authorLink) {
            const name = (authorLink.textContent || '').trim();
            if (name && name.length > 1 && name.length < 80) author = name;
          }

          // Comment text: concatenate all div[dir="auto"] text within the article
          let text = '';
          const textDivs = article.querySelectorAll('div[dir="auto"]');
          const textParts = [];
          for (const div of textDivs) {
            const t = (div.textContent || '').trim();
            if (t.length >= 2 && t !== author && !t.match(/^\d+[hmdwy]$/)) {
              textParts.push(t);
            }
          }
          // Use the longest text found (FB nests divs, so child text is duplicated in parent)
          if (textParts.length > 0) {
            text = textParts.reduce((a, b) => a.length >= b.length ? a : b, '');
          }

          // Timestamp from comment permalink aria-label or relative time
          let timestamp = null;
          const timeLinks = article.querySelectorAll('a[role="link"]');
          for (const link of timeLinks) {
            const aria = (link.getAttribute('aria-label') || '').trim();
            const href = link.getAttribute('href') || '';
            if (href.includes('comment_id=') || href.includes('reply_comment_id=')) {
              if (aria) timestamp = aria;
              break;
            }
          }
          if (!timestamp) {
            const spans = article.querySelectorAll('span');
            for (const span of spans) {
              const t = (span.textContent || '').trim();
              if (/^\d+[hmdwy]$/.test(t)) { timestamp = t; break; }
            }
          }

          // Comment ID from permalink
          let commentId = null;
          const permalinks = article.querySelectorAll('a[href*="comment_id="]');
          if (permalinks.length > 0) {
            const match = (permalinks[0].getAttribute('href') || '').match(/comment_id=(\d+)/);
            if (match) commentId = match[1];
          }

          // hasCommentId helps us distinguish real comments from sidebar posts
          if (text) {
            results.push({ commentId, authorName: author, commentText: text, timestamp, hasCommentId: !!commentId });
          }
        }
        return results;
      });

      if (comments.length > 0) {
        const seen = new Set();
        const deduped = [];
        for (const c of comments) {
          // Only keep entries that have a comment_id — filters out sidebar/recommended posts
          if (!c.hasCommentId) continue;
          const fp = c.commentText.slice(0, 60).toLowerCase();
          if (!seen.has(fp)) {
            seen.add(fp);
            deduped.push({ commentId: c.commentId, authorName: c.authorName, commentText: c.commentText, timestamp: c.timestamp || null });
          }
        }
        if (deduped.length > 0) {
          commentsByPost.set(post.postId, deduped);
          log(`    Found ${deduped.length} comment(s) (${comments.length} total articles)`);
          for (const c of deduped) {
            log(`      💬 [${c.commentId || '?'}] ${c.authorName} (${c.timestamp || '?'}): ${c.commentText.slice(0, 200)}`);
          }

          // Check against DB if post + all comments are already stored
          const commentIdsToCheck = deduped.filter(c => c.commentId).map(c => c.commentId);
          const { seenPostIds, seenCommentIds } = await checkSeenIds([post.postId], commentIdsToCheck);
          const postKnown = seenPostIds.has(post.postId);
          const allCommentsKnown = commentIdsToCheck.length > 0 && commentIdsToCheck.every(id => seenCommentIds.has(id));
          if (postKnown && allCommentsKnown) {
            consecutiveFullyKnown++;
            log(`    Post + all comments already in DB (${consecutiveFullyKnown} consecutive)`);
            if (consecutiveFullyKnown >= 2) {
              log(`  Stopping — ${consecutiveFullyKnown} consecutive fully-known posts`);
              break;
            }
          } else {
            consecutiveFullyKnown = 0;
          }
        } else {
          log(`    ${comments.length} articles found but none with comment_id — likely sidebar posts`);
        }
      } else {
        log(`    No comments found`);
        // Post with no comments — check if post itself is in DB
        const { seenPostIds } = await checkSeenIds([post.postId], []);
        if (seenPostIds.has(post.postId)) {
          consecutiveFullyKnown++;
          log(`    Post already in DB, no comments (${consecutiveFullyKnown} consecutive)`);
          if (consecutiveFullyKnown >= 2) {
            log(`  Stopping — ${consecutiveFullyKnown} consecutive fully-known posts`);
            break;
          }
        } else {
          consecutiveFullyKnown = 0;
        }
      }
    } catch (e) {
      log(`    Error loading post ${post.postId}: ${e.message}`);
    }

    await randomDelay(1000, 2000);
  }

  return commentsByPost;
}

async function scrape() {
  log('Starting Facebook group scrape');

  // Check if we should actually scrape Facebook
  const forceRun = process.argv.includes('--force');
  try {
    const shouldRunUrl = `${API_URL}/api/scrape/should-run${forceRun ? '?force=true' : ''}`;
    const shouldRunRes = await fetch(shouldRunUrl, {
      headers: { 'Authorization': `Bearer ${API_SECRET}` },
    });
    if (shouldRunRes.ok) {
      const { shouldScrape, reason } = await shouldRunRes.json();
      log(`Should scrape check: ${reason}`);
      if (!shouldScrape) {
        log('Skipping Facebook scrape — not needed right now');
        process.exit(0);
      }
    } else {
      log(`Should-run check failed (${shouldRunRes.status}), proceeding anyway`);
    }
  } catch (e) {
    log(`Should-run check error: ${e.message}, proceeding anyway`);
  }

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

      // Load comments by visiting each post's permalink
      const commentsByPost = await loadCommentsViaPermalinks(page, allPosts);

      // Merge comments into posts
      for (const post of allPosts) {
        const extra = commentsByPost.get(post.postId) || [];
        const existingTexts = new Set(post.comments.map(c => c.commentText.slice(0, 60).toLowerCase()));
        for (const c of extra) {
          const fp = c.commentText.slice(0, 60).toLowerCase();
          if (!existingTexts.has(fp)) {
            post.comments.push(c);
            existingTexts.add(fp);
          }
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
    const allExtracted = [];
    const processedPostIds = new Set();
    let scrollCount = 0;

    function extractNewPosts() {
      for (const response of graphqlResponses) {
        const posts = extractPostsFromGraphQL(response);
        for (const post of posts) {
          const postId = post.postId || ('gql-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
          if (processedPostIds.has(postId)) continue;
          processedPostIds.add(postId);

          // Fingerprint dedup
          const fp = (post.postText || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
          if (fp && processedPostIds.has('fp:' + fp)) continue;
          if (fp) processedPostIds.add('fp:' + fp);

          log(`  [${postId}] ${post.authorName}: ${post.postText.slice(0, 120)}`);

          allExtracted.push({
            postId,
            authorName: post.authorName || 'Unknown',
            postText: post.postText,
            timestamp: post.timestamp || new Date().toISOString(),
            isComment: false,
          });
        }
      }
    }

    // Process initial page load data
    log('Processing initial GraphQL data...');
    extractNewPosts();

    // ── Scroll loop to load more posts ─────────────────────────────
    for (let round = 0; round < MAX_SCROLLS; round++) {
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
        setTimeout(resolve, 10000);
      });

      log(`  ${graphqlResponses.length - beforeCount} new GraphQL responses.`);
      extractNewPosts();
    }

    // ── Load comments via post permalinks ─────────────────────────
    // Collect unique posts we've extracted (with numeric IDs only)
    const postsForComments = [];
    const seenPostIdsForComments = new Set();
    for (const response of graphqlResponses) {
      const posts = extractPostsFromGraphQL(response);
      for (const post of posts) {
        if (post.postId && /^\d+$/.test(post.postId) && !seenPostIdsForComments.has(post.postId)) {
          seenPostIdsForComments.add(post.postId);
          postsForComments.push(post);
        }
      }
    }
    log(`Loading comments for ${postsForComments.length} posts...`);
    const commentsByPost = await loadCommentsViaPermalinks(page, postsForComments);

    // Add comments to allExtracted
    let commentCount = 0;
    for (const [postId, comments] of commentsByPost) {
      for (let i = 0; i < comments.length; i++) {
        const c = comments[i];
        if (!c.commentText) continue;
        allExtracted.push({
          postId: c.commentId || `${postId}-c${i}`,
          parentPostId: postId,
          authorName: c.authorName || 'Unknown',
          postText: c.commentText,
          timestamp: relativeTimestampToISO(c.timestamp),
          isComment: true,
        });
        commentCount++;
      }
    }

    const postCount = allExtracted.length - commentCount;
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

    const fbGroupId = '325119181430845';
    function fbLink(postId) {
      if (/^\d+$/.test(postId)) return `https://www.facebook.com/groups/${fbGroupId}/permalink/${postId}/`;
      return null;
    }
    function fmtTime(ts) {
      if (!ts) return '?';
      return new Date(ts).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
    function classColor(c) {
      if (c === 'dry') return 'green';
      if (c === 'wet') return 'red';
      if (c === 'inquiry') return '#b8860b';
      return '#888';
    }

    const allClassified = result.allClassified || [];
    const statusChanges = result.statusChanges || {};

    const classifiedHtml = allClassified.length > 0
      ? `<h3>📋 All Classified Posts (${allClassified.length})</h3>
         <table style="border-collapse:collapse;font-size:13px;width:100%">
           <tr style="background:#f0f0f0">
             <th style="padding:4px 8px;text-align:left">Time</th>
             <th style="padding:4px 8px;text-align:left">Class</th>
             <th style="padding:4px 8px;text-align:left">Trails</th>
             <th style="padding:4px 8px;text-align:left">Status Change</th>
             <th style="padding:4px 8px;text-align:left">Post</th>
           </tr>
           ${allClassified.map(p => {
             const ts = fmtTime(p.timestamp);
             const trails = (p.trails && p.trails.length > 0) ? p.trails.join(', ') : '';
             const link = fbLink(p.postId);
             const textCell = link ? `<a href="${link}">${p.text}</a>` : p.text;
             const change = statusChanges[p.postId] || '';
             const changeStyle = change ? 'background:#fff3cd;font-weight:bold' : '';
             return `<tr style="${changeStyle}"><td style="padding:4px 8px;white-space:nowrap">${ts}</td><td style="padding:4px 8px;color:${classColor(p.classification)}">${p.classification}</td><td style="padding:4px 8px">${trails}</td><td style="padding:4px 8px">${change}</td><td style="padding:4px 8px">${textCell}</td></tr>`;
           }).join('')}
         </table>`
      : '';

    const subject = changedCount > 0
      ? `${changedCount} trail change${changedCount > 1 ? 's' : ''} — ${postCount} posts`
      : `${postCount} posts, ${commentCount} comments — no changes`;

    await sendEmail(subject,
      `<h3>Scraper Run</h3>
       <p>Posts: ${postCount} · Comments: ${commentCount} · Scrolls: ${scrollCount} · Stored: ${result.stored} · Classified: ${result.classified}</p>
       ${classifiedHtml}
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
