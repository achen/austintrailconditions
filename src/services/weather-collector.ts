import { WeatherObservation } from '@/types';
import { sql } from '@/lib/db';

const AUSTIN_LATITUDE = 30.27; // degrees North

/**
 * Calculate daylight hours for a given date at Austin's latitude (~30.27°N).
 * Uses the astronomical formula based on solar declination and hour angle.
 */
export function calculateDaylightHours(date: Date): number {
  const dayOfYear = getDayOfYear(date);

  // Solar declination angle (radians)
  const declination =
    0.4093 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));

  const latRad = (AUSTIN_LATITUDE * Math.PI) / 180;

  // Hour angle at sunrise/sunset
  const cosHourAngle = -Math.tan(latRad) * Math.tan(declination);

  // Clamp for polar edge cases (shouldn't happen at 30°N, but be safe)
  if (cosHourAngle < -1) return 24;
  if (cosHourAngle > 1) return 0;

  const hourAngle = Math.acos(cosHourAngle);
  const daylightHours = (2 * hourAngle * 24) / (2 * Math.PI);

  return Math.round(daylightHours * 10) / 10; // round to 1 decimal
}

function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Fetch latest weather observations from Weather Underground API for a station.
 * Returns parsed WeatherObservation array with daylight hours calculated.
 */
export async function fetchObservations(
  stationId: string,
  apiKey: string,
  baseUrl: string = process.env.WEATHER_API_BASE_URL || 'https://api.weather.com'
): Promise<WeatherObservation[]> {
  const url = `${baseUrl}/v2/pws/observations/current?stationId=${encodeURIComponent(stationId)}&format=json&units=e&apiKey=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url);

  if (!response.ok || response.status === 204) {
    if (response.status !== 204) {
      console.error(
        `Weather API error for station ${stationId}: ${response.status} ${response.statusText}`
      );
    }
    return [];
  }

  const data = await response.json();

  if (!data.observations || !Array.isArray(data.observations)) {
    console.error(`Unexpected Weather API response for station ${stationId}: no observations array`);
    return [];
  }

  return data.observations.map((obs: Record<string, unknown>) => {
    const imperial = obs.imperial as Record<string, number> | undefined;
    const obsDate = new Date(obs.obsTimeUtc as string);

    return {
      stationId: (obs.stationID as string) || stationId,
      timestamp: obsDate,
      precipitationIn: imperial?.precipTotal ?? 0,
      temperatureF: imperial?.temp ?? 0,
      humidityPercent: (obs.humidity as number) ?? 0,
      windSpeedMph: imperial?.windSpeed ?? 0,
      solarRadiationWm2: (obs.solarRadiation as number) ?? 0,
      daylightHours: calculateDaylightHours(obsDate),
    } satisfies WeatherObservation;
  });
}


/**
 * Store weather observations in the database.
 * Uses ON CONFLICT DO NOTHING for deduplication by (station_id, timestamp).
 * Returns the count of newly inserted records.
 */
export async function storeObservations(
  observations: WeatherObservation[]
): Promise<number> {
  if (observations.length === 0) return 0;

  let insertedCount = 0;

  for (const obs of observations) {
    const result = await sql`
      INSERT INTO weather_observations (
        station_id, timestamp, precipitation_in, temperature_f,
        humidity_percent, wind_speed_mph, solar_radiation_wm2, daylight_hours
      ) VALUES (
        ${obs.stationId},
        ${obs.timestamp.toISOString()},
        ${obs.precipitationIn},
        ${obs.temperatureF},
        ${obs.humidityPercent},
        ${obs.windSpeedMph},
        ${obs.solarRadiationWm2},
        ${obs.daylightHours}
      )
      ON CONFLICT (station_id, timestamp) DO NOTHING
    `;
    if (result.rowCount && result.rowCount > 0) {
      insertedCount++;
    }
  }

  return insertedCount;
}

/**
 * Get distinct station IDs from all non-archived trails with updates_enabled = true.
 * Avoids redundant API calls when multiple trails share the same station.
 */
export async function getActiveStationIds(): Promise<string[]> {
  const result = await sql`
    SELECT DISTINCT primary_station_id
    FROM trails
    WHERE is_archived = false
      AND updates_enabled = true
      AND primary_station_id IS NOT NULL
      AND primary_station_id != ''
  `;

  return result.rows.map((row) => row.primary_station_id as string);
}

/**
 * Determine if the system should poll frequently (hourly) or infrequently (daily).
 *
 * Returns true when rain is active OR any trail is still wet/drying.
 * - No active rain + all trails dry → false (forecast-only mode)
 * - Active rain or trails in "Probably Not Rideable" / "Verified Not Rideable" → true
 */
export async function shouldPollFrequently(): Promise<boolean> {
  // Check for active rain events
  const activeRainResult = await sql`
    SELECT EXISTS (
      SELECT 1 FROM rain_events WHERE is_active = true
    ) AS has_active_rain
  `;

  if (activeRainResult.rows[0]?.has_active_rain) {
    return true;
  }

  // Poll frequently for any trail that isn't dry yet
  const dryingTrailsResult = await sql`
    SELECT EXISTS (
      SELECT 1 FROM trails
      WHERE is_archived = false
        AND updates_enabled = true
        AND condition_status IN ('Probably Not Rideable', 'Verified Not Rideable')
    ) AS has_drying_trails
  `;

  return !!dryingTrailsResult.rows[0]?.has_drying_trails;
}
/**
 * Check the WU 5-day forecast for Austin to find when rain is expected.
 * 1. Calls the 5-day daily forecast (1 API call) to see if rain >= 30% in any daypart.
 * 2. If rain found, calls the hourly forecast (1 more API call) to find the exact hour.
 * Returns when to start hourly station polling (4 hours before rain).
 *
 * Total: 1 API call on dry days, 2 API calls when rain is coming.
 */
export /**
 * Check the WU 5-day daily forecast for Austin to determine if/when rain is expected.
 *
 * The PWS contributor API only provides the 5-day daily forecast (not hourly).
 * Dayparts alternate: index 0 = day 1 day, 1 = day 1 night, 2 = day 2 day, etc.
 * Day = 7am-7pm CT, Night = 7pm-7am CT.
 *
 * Algorithm:
 * - Find the first daypart with ≥30% precip chance
 * - Calculate the start of that daypart in UTC (day: 13:00 UTC / 7am CT, night: 01:00 UTC next day / 7pm CT)
 * - If rain is >20h away, defer polling to tomorrow's forecast check
 * - If rain is ≤20h away, set pollAfterUtc = daypart start - 4h, pollUntilUtc = daypart end + 3h
 *
 * Total: 1 API call per day.
 */
export async function isRainForecast(
  apiKey: string,
  baseUrl: string = process.env.WEATHER_API_BASE_URL || 'https://api.weather.com'
): Promise<{ rainExpected: boolean; maxChance: number; details: string; pollAfterUtc: Date | null; pollUntilUtc: Date | null }> {
  const dailyUrl = `${baseUrl}/v3/wx/forecast/daily/5day?geocode=30.27,-97.74&format=json&units=e&language=en-US&apiKey=${encodeURIComponent(apiKey)}`;

  try {
    const dailyResp = await fetch(dailyUrl, { signal: AbortSignal.timeout(10000) });
    if (!dailyResp.ok) {
      console.error(`Forecast API error: ${dailyResp.status}`);
      return { rainExpected: true, maxChance: -1, details: `API error ${dailyResp.status}`, pollAfterUtc: new Date(), pollUntilUtc: null };
    }

    const dailyData = await dailyResp.json();
    const dayParts = dailyData.daypart?.[0];
    if (!dayParts?.precipChance) {
      return { rainExpected: true, maxChance: -1, details: 'No forecast data', pollAfterUtc: new Date(), pollUntilUtc: null };
    }

    // Find max precip chance across all dayparts
    let maxChance = 0;
    let hasRain = false;
    for (const chance of dayParts.precipChance) {
      if (chance !== null && chance > maxChance) maxChance = chance;
      if (chance !== null && chance >= 30) hasRain = true;
    }

    if (!hasRain) {
      return { rainExpected: false, maxChance, details: `5-day max precip: ${maxChance}% — no rain expected`, pollAfterUtc: null, pollUntilUtc: null };
    }

    // Find the first and last dayparts with ≥30% chance to build the polling window
    const now = new Date();
    const startOfDayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    let pollAfterUtc: Date | null = null;
    let pollUntilUtc: Date | null = null;
    let rainDetail = '';

    for (let i = 0; i < dayParts.precipChance.length; i++) {
      if (dayParts.precipChance[i] === null || dayParts.precipChance[i] < 30) continue;

      const dayOffset = Math.floor(i / 2);
      const isNight = i % 2 === 1;

      // Day daypart (7am-7pm CT) = 13:00-01:00 UTC
      // Night daypart (7pm-7am CT) = 01:00-13:00 UTC (next day)
      const dpStartUtc = new Date(startOfDayUtc);
      if (isNight) {
        // Night starts at 01:00 UTC on dayOffset+1 (= 7pm CT on dayOffset)
        dpStartUtc.setUTCDate(dpStartUtc.getUTCDate() + dayOffset + 1);
        dpStartUtc.setUTCHours(1, 0, 0, 0);
      } else {
        // Day starts at 13:00 UTC on dayOffset (= 7am CT)
        dpStartUtc.setUTCDate(dpStartUtc.getUTCDate() + dayOffset);
        dpStartUtc.setUTCHours(13, 0, 0, 0);
      }

      const dpEndUtc = new Date(dpStartUtc.getTime() + 12 * 60 * 60 * 1000);

      if (!pollAfterUtc) {
        // First rain daypart — set poll start
        pollAfterUtc = new Date(dpStartUtc.getTime() - 4 * 60 * 60 * 1000);
        const dayName = dpStartUtc.toLocaleString('en-US', {
          timeZone: 'America/Chicago',
          weekday: 'short',
        });
        rainDetail = `${dayName} ${isNight ? 'night' : 'day'} (${dayParts.precipChance[i]}%)`;
      }

      // Keep extending pollUntilUtc for each rain daypart
      pollUntilUtc = new Date(dpEndUtc.getTime() + 3 * 60 * 60 * 1000);
    }

    const hoursUntilPoll = pollAfterUtc
      ? (pollAfterUtc.getTime() - now.getTime()) / (1000 * 60 * 60)
      : 0;

    let details: string;
    if (hoursUntilPoll > 20) {
      details = `Rain ${maxChance}% — ${rainDetail}, ~${Math.round(hoursUntilPoll + 4)}h away. Polling deferred.`;
    } else {
      details = `Rain ${maxChance}% — ${rainDetail}. Poll after ${pollAfterUtc?.toISOString() ?? 'now'}, until ${pollUntilUtc?.toISOString() ?? 'unknown'}`;
    }

    return { rainExpected: true, maxChance, details, pollAfterUtc, pollUntilUtc };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Forecast check failed: ${msg}`);
    return { rainExpected: true, maxChance: -1, details: `Error: ${msg}`, pollAfterUtc: new Date(), pollUntilUtc: null };
  }
}


