#!/usr/bin/env node
/**
 * Flat Rock Ranch Trail Status Scraper
 *
 * Scrapes flatrockranchtx.com for trail open/closed status using a headless browser.
 * The site is Squarespace and renders status via JS, so we need Puppeteer.
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

const FRR_URL = 'https://www.flatrockranchtx.com/';
const CLOSED_PATTERN = /(?:trails?\s+(?:are|is)\s+)?closed/i;
const OPEN_PATTERN = /(?:trails?\s+(?:are|is)\s+)?open/i;

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

    // Look for trail status — typically in an announcement bar or banner
    // Search for lines containing open/closed near "trail" or "ranch" context
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
    let isOpen = null;
    let rawText = '';

    for (const line of lines) {
      const lower = line.toLowerCase();
      // Skip generic nav/footer text, focus on status announcements
      if (lower.length > 200) continue;
      if (lower.includes('closed') && (lower.includes('trail') || lower.includes('ranch') || lower.includes('weather') || lower.includes('rain') || lower.includes('wet'))) {
        isOpen = false;
        rawText = line.slice(0, 200);
        break;
      }
      if (lower.includes('open') && (lower.includes('trail') || lower.includes('ranch') || lower.includes('riding'))) {
        isOpen = true;
        rawText = line.slice(0, 200);
        break;
      }
    }

    // Fallback: broader pattern match on full body
    if (isOpen === null) {
      const closedMatch = bodyText.match(/trails?\s+(?:are|is)\s+closed/i);
      const openMatch = bodyText.match(/trails?\s+(?:are|is)\s+open/i);
      if (closedMatch) {
        isOpen = false;
        rawText = closedMatch[0];
      } else if (openMatch) {
        isOpen = true;
        rawText = openMatch[0];
      }
    }

    if (isOpen === null) {
      log('No open/closed status found on page. Skipping update.');
      log(`Page text preview: ${bodyText.slice(0, 500)}`);
      await browser.close();
      process.exit(0);
    }

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
