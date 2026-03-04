#!/usr/bin/env node
/**
 * Find replacement weather stations for any offline trails.
 * 
 * SAFE: No automatic updates. No loops. Hard cap on API calls.
 * Just prints candidates so you can review and update manually.
 *
 * Usage:
 *   node scripts/find-replacement-stations.js
 *
 * Reads .env.local automatically for WEATHER_API_KEY and DATABASE_URL.
 */

const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

// Load .env.local if present
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const API_KEY = process.env.WEATHER_API_KEY;
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!API_KEY || !DB_URL) {
  console.error('Missing WEATHER_API_KEY or DATABASE_URL');
  process.exit(1);
}

const sql = neon(DB_URL);
const WU_BASE = 'https://api.weather.com';

// Hard cap: never make more than this many API calls total
const MAX_API_CALLS = 40;
let apiCallCount = 0;

async function apiFetch(url) {
  if (apiCallCount >= MAX_API_CALLS) {
    console.log(`⛔ API call limit reached (${MAX_API_CALLS}). Stopping.`);
    return null;
  }
  apiCallCount++;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (resp.status === 401 || resp.status === 403) {
    console.error(`\n🚨 ACCESS DENIED (HTTP ${resp.status}) — API key may be locked. Stopping immediately.`);
    process.exit(1);
  }
  return resp;
}

async function checkStation(stationId) {
  const url = `${WU_BASE}/v2/pws/observations/current?stationId=${encodeURIComponent(stationId)}&format=json&units=e&apiKey=${encodeURIComponent(API_KEY)}`;
  const resp = await apiFetch(url);
  if (!resp) return null;
  if (resp.status !== 200) return null;
  const data = await resp.json();
  return data.observations?.[0] ?? null;
}

async function findNearby(lat, lon) {
  const url = `${WU_BASE}/v3/location/near?geocode=${lat},${lon}&product=pws&format=json&apiKey=${encodeURIComponent(API_KEY)}`;
  const resp = await apiFetch(url);
  if (!resp || !resp.ok) return [];
  const data = await resp.json();
  const loc = data.location;
  if (!loc?.stationId) return [];

  const stations = [];
  for (let i = 0; i < loc.stationId.length && stations.length < 8; i++) {
    stations.push({
      stationId: loc.stationId[i],
      name: loc.stationName[i] || '?',
      distanceMi: loc.distanceMi[i],
      qcStatus: loc.qcStatus[i],
    });
  }
  return stations;
}

async function run() {
  // Pull all active trails with stations from the database
  const trails = await sql`
    SELECT name, primary_station_id, latitude, longitude
    FROM trails
    WHERE is_archived = false AND updates_enabled = true
      AND primary_station_id IS NOT NULL AND primary_station_id != ''
      AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY name
  `;

  console.log(`Checking ${trails.length} active trail stations...\n`);

  let onlineCount = 0;
  let offlineCount = 0;

  for (const trail of trails) {
    const sid = trail.primary_station_id;
    const obs = await checkStation(sid);

    if (obs) {
      const temp = obs.imperial?.temp ?? '?';
      console.log(`✅ ${sid.padEnd(18)} ${trail.name.padEnd(25)} ${temp}°F`);
      onlineCount++;
      continue;
    }

    console.log(`\n━━━ ${trail.name} (current: ${sid}) ━━━`);
    console.log(`  ❌ Current station is OFFLINE`);
    offlineCount++;

    if (apiCallCount >= MAX_API_CALLS) break;

    // Find nearby replacements
    const nearby = await findNearby(parseFloat(trail.latitude), parseFloat(trail.longitude));
    if (nearby.length === 0) {
      console.log(`  ⚠️  No nearby stations found.\n`);
      continue;
    }

    console.log(`  Found ${nearby.length} nearby stations. Probing up to 5...`);

    let probed = 0;
    for (const candidate of nearby) {
      if (candidate.stationId === sid) continue;
      if (probed >= 5) break;
      probed++;

      const cObs = await checkStation(candidate.stationId);
      if (cObs) {
        const temp = cObs.imperial?.temp ?? '?';
        const precip = cObs.imperial?.precipTotal ?? '?';
        console.log(`  ✅ ${candidate.stationId.padEnd(18)} ${candidate.distanceMi.toFixed(1)}mi  ${temp}°F  precip: ${precip}"  (${candidate.name})`);
      } else {
        console.log(`  ❌ ${candidate.stationId.padEnd(18)} ${candidate.distanceMi.toFixed(1)}mi  OFFLINE  (${candidate.name})`);
      }

      if (apiCallCount >= MAX_API_CALLS) break;
    }
    console.log();
  }

  console.log(`\n${onlineCount} online, ${offlineCount} offline out of ${trails.length} trails`);
  console.log(`Total API calls: ${apiCallCount}/${MAX_API_CALLS}`);

  if (offlineCount > 0) {
    console.log('\nTo update a station, run:');
    console.log("  UPDATE trails SET primary_station_id = 'NEW_ID' WHERE primary_station_id = 'OLD_ID';");
  }
}

run().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
