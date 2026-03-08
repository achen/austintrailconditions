/**
 * Fetch WU 5-day forecast and store dayparts in weather_forecasts table.
 * One-off script to populate dayparts for today's forecast.
 *
 * Usage: source .env.local && node scripts/fetch-forecast-dayparts.js
 */
const { neon } = require("@neondatabase/serverless");

function phraseSolarRadiation(phrase) {
  if (!phrase) return 300;
  const p = phrase.toLowerCase();
  if (p.includes('rain') || p.includes('thunder') || p.includes('shower') || p.includes('storm')) return 50;
  if (p.includes('fog') || p.includes('haze') || p.includes('mist')) return 150;
  if (p.includes('mostly cloudy')) return 200;
  if (p.includes('partly cloudy') || p.includes('partly sunny')) return 400;
  if (p.includes('cloudy') || p.includes('overcast')) return 100;
  if (p.includes('mostly sunny') || p.includes('mostly clear')) return 650;
  if (p.includes('sunny') || p.includes('clear')) return 800;
  return 300;
}

async function run() {
  const apiKey = process.env.WEATHER_API_KEY || process.env.WU_API_KEY;
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!apiKey) { console.error("WEATHER_API_KEY not set"); process.exit(1); }
  if (!dbUrl) { console.error("DATABASE_URL not set"); process.exit(1); }

  const sql = neon(dbUrl);
  const url = `https://api.weather.com/v3/wx/forecast/daily/5day?geocode=30.27,-97.74&format=json&units=e&language=en-US&apiKey=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url);
  if (!resp.ok) { console.error("API error:", resp.status); process.exit(1); }
  const data = await resp.json();

  const dp = data.daypart?.[0];
  if (!dp?.precipChance) { console.error("No daypart data"); process.exit(1); }

  const dayparts = [];
  for (let i = 0; i < dp.temperature.length; i++) {
    if (i % 2 === 1) continue; // skip night
    if (dp.temperature[i] === null) continue;
    dayparts.push({
      dayOffset: Math.floor(i / 2),
      name: dp.daypartName?.[i] || `Day ${Math.floor(i / 2)}`,
      solarRadiationWm2: phraseSolarRadiation(dp.wxPhraseLong?.[i]),
      windSpeedMph: dp.windSpeed?.[i] || 5,
      temperatureF: dp.temperature[i] || 75,
      precipChance: dp.precipChance[i] || 0,
      phrase: dp.wxPhraseLong?.[i] || 'Unknown',
    });
  }

  console.log("Forecast dayparts:");
  for (const d of dayparts) {
    console.log(`  ${d.name}: ${d.phrase} (solar=${d.solarRadiationWm2}, wind=${d.windSpeedMph}mph, temp=${d.temperatureF}F, rain=${d.precipChance}%)`);
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  // Update existing row or insert new one
  const existing = await sql`SELECT forecast_date FROM weather_forecasts WHERE forecast_date = ${todayStr}`;
  if (existing.length > 0) {
    await sql`UPDATE weather_forecasts SET dayparts = ${JSON.stringify(dayparts)}::jsonb WHERE forecast_date = ${todayStr}`;
    console.log(`\nUpdated dayparts for ${todayStr}`);
  } else {
    await sql`INSERT INTO weather_forecasts (forecast_date, rain_expected, max_chance, details, dayparts) VALUES (${todayStr}, false, 0, 'Manual daypart fetch', ${JSON.stringify(dayparts)}::jsonb)`;
    console.log(`\nInserted forecast with dayparts for ${todayStr}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
