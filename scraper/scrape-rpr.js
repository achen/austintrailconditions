#!/usr/bin/env node
/**
 * Reveille Peak Ranch Trail Status Scraper
 *
 * Scrapes rprtexas.com and sends the page text to OpenAI to determine
 * if trails are open or closed today. RPR never closes for weather
 * but does close for events (e.g. NICA races).
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

const RPR_URL = 'https://www.rprtexas.com/';

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

The following text is from the Reveille Peak Ranch website. RPR is a mountain bike trail that never closes for weather, but does close for events (races, private events, etc).

Based on the text below, are the trails OPEN or CLOSED today?

Respond with ONLY valid JSON: {"isOpen": true} or {"isOpen": false, "reason": "brief reason"}

Website text:
${pageText.slice(0, 2000)}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'You determine if a trail is open or closed today based on website text. Respond only with JSON.' },
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

  // Parse JSON from response (handle markdown code blocks)
  const jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  return JSON.parse(jsonStr);
}

async function scrapeRPR() {
  log('Starting Reveille Peak Ranch status scrape');

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
    log(`Navigating to ${RPR_URL}`);
    await page.goto(RPR_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    await new Promise(r => setTimeout(r, 3000));

    const bodyText = await page.evaluate(() => document.body.innerText);
    log(`Page text (first 300 chars): ${bodyText.slice(0, 300).replace(/\n/g, ' ')}`);

    const aiResult = await askAI(bodyText);
    const isOpen = aiResult.isOpen;
    const rawText = aiResult.reason || (isOpen ? 'AI: open' : 'AI: closed');

    log(`Reveille Peak Ranch: ${isOpen ? 'OPEN' : 'CLOSED'} — "${rawText}"`);

    const res = await fetch(`${API_URL}/api/scrape/trail-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_SECRET}`,
      },
      body: JSON.stringify({ trailName: 'Reveille Peak Ranch', isOpen, rawText }),
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

scrapeRPR();
