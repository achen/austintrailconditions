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
 * Returns true when any rain event is active OR any trail is in a drying state
 * ("Probably Not Rideable" or "Probably Rideable" that isn't "Verified Rideable").
 *
 * Adaptive polling per Requirement 1.4:
 * - Daily when no active rain events and all trails are stable
 * - Hourly when rain events are active or trails are drying
 */
export /**
 * Determine if the system should poll frequently (hourly) or infrequently (daily).
 *
 * Returns true only when rain is actively falling OR trails are still
 * "Probably Not Rideable" (actually drying). "Probably Rideable" trails
 * are nearly dry and don't need frequent weather updates.
 *
 * Adaptive polling per Requirement 1.4:
 * - Daily around midday when no active rain and no actively drying trails
 * - Hourly when rain is active or trails are in "Probably Not Rideable"
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

  // Only poll frequently for trails that are actively drying (not rideable yet)
  const dryingTrailsResult = await sql`
    SELECT EXISTS (
      SELECT 1 FROM trails
      WHERE is_archived = false
        AND updates_enabled = true
        AND condition_status = 'Probably Not Rideable'
    ) AS has_drying_trails
  `;

  return !!dryingTrailsResult.rows[0]?.has_drying_trails;
}
