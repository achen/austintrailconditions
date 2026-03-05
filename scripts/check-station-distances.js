#!/usr/bin/env node
/**
 * Fetch station lat/lon from WU API, store in DB, and calculate distances to trails.
 */
const API_KEY = process.env.WEATHER_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY || !DATABASE_URL) {
  console.error('Need WEATHER_API_KEY and DATABASE_URL env vars');
  process.exit(1);
}

const { neon } = require('@neondatabase/serverless');
const sql = neon(DATABASE_URL, { fullResults: true });

function haversineDistanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchStationLocation(stationId) {
  const url = `https://api.weather.com/v2/pws/observations/current?stationId=${encodeURIComponent(stationId)}&format=json&units=e&apiKey=${encodeURIComponent(API_KEY)}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const obs = data.observations?.[0];
    if (!obs) return null;
    return { lat: obs.lat, lon: obs.lon };
  } catch {
    return null;
  }
}

async function main() {
  const { rows } = await sql`
    SELECT DISTINCT name, primary_station_id, latitude, longitude
    FROM trails
    WHERE is_archived = false AND updates_enabled = true
      AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY name
  `;

  console.log(`\n${'Trail'.padEnd(26)} ${'Station'.padEnd(14)} ${'Distance'.padStart(10)}  Station Location`);
  console.log('-'.repeat(75));

  for (const row of rows) {
    const stationId = row.primary_station_id;
    const trailLat = parseFloat(row.latitude);
    const trailLon = parseFloat(row.longitude);

    const loc = await fetchStationLocation(stationId);
    if (!loc) {
      console.log(`${row.name.padEnd(26)} ${stationId.padEnd(14)} ${'OFFLINE'.padStart(10)}`);
      continue;
    }

    const dist = haversineDistanceMiles(trailLat, trailLon, loc.lat, loc.lon);

    // Store station lat/lon in DB
    await sql`
      UPDATE trails SET station_latitude = ${loc.lat}, station_longitude = ${loc.lon}
      WHERE name = ${row.name}
    `;

    const flag = dist > 10 ? ' ⚠️' : '';
    console.log(`${row.name.padEnd(26)} ${stationId.padEnd(14)} ${dist.toFixed(1).padStart(8)} mi  (${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)})${flag}`);
  }
}

main().catch(console.error);
