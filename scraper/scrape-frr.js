#!/usr/bin/env node
/**
 * Flat Rock Ranch Trail Status Scraper
 *
 * Scrapes flatrockranchtx.com and sends the page text to OpenAI to determine
 * if trails are open or closed. The site is Squarespace and renders via JS.
 */

const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const HEADLESS = process.env.HEADLESS !== 'false';

if (!API_SECRET) { console.error('Missing API_SECRET in .env'); process.exit(1); }
if (!OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY in .env'); process.exit(1); }

const FRR_URL = 'https://www.flatrockranchtx.com/';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function findChrome() {
  const paths = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of paths) { if (fs.existsSync(p)) return p; }
  try { return execSync('which google-chrome').toString().trim(); } catch {}
  try { return execSync('which chromium').toString().trim(); } catch {}
  return null;
}

async function askAI(pageText) {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const prompt = `Today is ${todayStr}.

The following text is from the Flat Rock Ranch website (flatrockranchtx.com). Flat Rock Ranch is a mountain bike trail park near Comfort, TX. They sometimes close trails due to wet weather or events.

Based on the text below, are the mountain bike trails open or closed RIGHT NOW?

If there is no clear indication of open/closed status on the page, respond with {"isOpen": null, "reason": "no status found"}.

Otherwise respond with ONLY valid JSON: {"isOpen": true} or {"isOpen": false, "reason": "brief reason"}

Website text:
${pageText.slice(0, 3000)}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'You determine if a trail is open or closed based on website text. Respond only with JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_completion_tokens: 100,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  log(`AI response: ${content}`);

  const jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  return JSON.parse(jsonStr);
}

async function scrapeFRR() {
  log('Starting Flat Rock Ranch status scrape');

  const chromePath = findChrome();
  if (!chromePath) { log('ERROR: Chrome not found.'); process.exit(1); }
  log(`Using Chrome: ${chromePath}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS ? 'new' : false,
      executablePath: chromePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1440, height: 900 },
    });

    const page = await browser.newPage();
    log(`Navigating to ${FRR_URL}`);
    await page.goto(FRR_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for Squarespace JS to render
    await new Promise(r => setTimeout(r, 5000));

    const bodyText = await page.evaluate(() => document.body.innerText);
    log(`Page text (first 300 chars): ${bodyText.slice(0, 300).replace(/\n/g, ' ')}`);

    const aiResult = await askAI(bodyText);

    if (aiResult.isOpen === null) {
      log(`No status found on page: ${aiResult.reason || 'unknown'}`);
      await browser.close();
      process.exit(0);
    }

    const isOpen = aiResult.isOpen;
    const rawText = aiResult.reason || (isOpen ? 'AI: open' : 'AI: closed');

    log(`Flat Rock Ranch: ${isOpen ? 'OPEN' : 'CLOSED'} — "${rawText}"`);

    const res = await fetch(`${API_URL}/api/scrape/trail-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_SECRET}`,
      },
      body: JSON.stringify({ trailName: 'Flat Rock Ranch', isOpen, rawText }),
    });

    if (res.ok) {
      const result = await res.json();
      log(`API: changed=${result.changed}, status=${result.newStatus}`);
    } else {
      const errText = await res.text().catch(() => '');
      log(`API error ${res.status}: ${errText.slice(0, 200)}`);
      process.exit(1);
    }
  } catch (err) {
    log(`ERROR: ${err.message}`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

scrapeFRR();
