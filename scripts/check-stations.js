/**
 * Quick check of all station IDs in the database.
 * Usage: WEATHER_API_KEY=xxx DATABASE_URL=xxx node scripts/check-stations.js
 */
const { neon } = require('@neondatabase/serverless');

async function run() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const apiKey = process.env.WEATHER_API_KEY;
  if (!dbUrl || !apiKey) {
    console.error('Need DATABASE_URL and WEATHER_API_KEY');
    process.exit(1);
  }

  const sql = neon(dbUrl);
  const rows = await sql`
    SELECT DISTINCT primary_station_id, name FROM trails
    WHERE is_archived = false AND updates_enabled = true
      AND primary_station_id IS NOT NULL AND primary_station_id != ''
    ORDER BY name
  `;

  console.log(`Checking ${rows.length} trail stations...\n`);

  let ok = 0, fail = 0;
  for (const row of rows) {
    const sid = row.primary_station_id;
    const url = `https://api.weather.com/v2/pws/observations/current?stationId=${sid}&format=json&units=e&apiKey=${apiKey}`;
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        const data = await res.json();
        const obs = data.observations?.[0];
        const temp = obs?.imperial?.temp ?? '?';
        console.log(`✅ ${sid.padEnd(18)} ${row.name.padEnd(25)} ${temp}°F`);
        ok++;
      } else if (res.status === 204) {
        console.log(`⚠️  ${sid.padEnd(18)} ${row.name.padEnd(25)} No data (204)`);
        fail++;
      } else {
        console.log(`❌ ${sid.padEnd(18)} ${row.name.padEnd(25)} HTTP ${res.status}`);
        fail++;
      }
    } catch (e) {
      console.log(`❌ ${sid.padEnd(18)} ${row.name.padEnd(25)} ${e.message}`);
      fail++;
    }
  }

  console.log(`\n${ok} working, ${fail} failed out of ${rows.length}`);
}

run();
