#!/usr/bin/env node
/**
 * Reimers Ranch Trail Status Scraper
 *
 * The Reimers status page renders its open/closed banner via JavaScript,
 * so we need a headless browser to see it. Reads the page with puppeteer,
 * checks for the mountain bike trails open/closed pattern, and POSTs the
 * result to the API.
 *
 * Uses the same .env and Chrome setup as the Facebook scraper.
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
const HEADLESS = process.env.HEADLESS !== 'false';

if (!API_SECRET) { console.error('Missing API_SECRET in .env'); process.exit(1); }

const REIMERS_URL = 'https://parks.traviscountytx.gov/parks/reimers-ranch';
const OPEN_PATTERN = /mountain bike trails[^.]*are\s+(?:currently\s+)?open/i;
const CLOSED_PATTERN = /mountain bike trails[^.]*are\s+(?:currently\s+)?closed/i;

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

async function scrapeReimers() {
  log('Starting Reimers Ranch status scrape');

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
    log(`Navigating to ${REIMERS_URL}`);
    await page.goto(REIMERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait a moment for any dynamic content to render
    await new Promise(r => setTimeout(r, 3000));

    const bodyText = await page.evaluate(() => document.body.innerText);

    let isOpen = null;
    let rawText = '';

    if (OPEN_PATTERN.test(bodyText)) {
      isOpen = true;
      rawText = bodyText.match(OPEN_PATTERN)[0].trim();
    } else if (CLOSED_PATTERN.test(bodyText)) {
      isOpen = false;
      rawText = bodyText.match(CLOSED_PATTERN)[0].trim();
    }

    if (isOpen === null) {
      log('No open/closed pattern found on page. Skipping update.');
      await browser.close();
      process.exit(0);
    }

    log(`Reimers Ranch: ${isOpen ? 'OPEN' : 'CLOSED'} — "${rawText}"`);

    const res = await fetch(`${API_URL}/api/scrape/trail-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_SECRET}`,
      },
      body: JSON.stringify({ trailName: 'Reimers Ranch', isOpen, rawText }),
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

scrapeReimers();
