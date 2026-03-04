import { sql } from '@/lib/db';
import { WeatherObservation } from '@/types';
import { notifyWeatherApiAccessDenied } from '@/services/notification-service';

const WU_BASE = 'https://api.weather.com';

/**
 * If the WU API returns 401/403, send an alert and throw to halt all further calls.
 */
async function handleWeatherApiAccessDenied(statusCode: number, endpoint: string): Promise<never> {
  console.error(`Weather API access denied (HTTP ${statusCode}) at ${endpoint}. Halting all weather API calls.`);
  await notifyWeatherApiAccessDenied(statusCode, endpoint);
  throw new Error(`Weather API access denied (HTTP ${statusCode}). API key may be locked. Alert email sent.`);
}

interface NearbyStation {
  stationId: string;
  name: string;
  distanceMi: number;
}

/**
 * Find nearby working weather stations using the WU nearby API.
 * Returns up to `limit` stations sorted by distance.
 */
export async function findNearbyStations(
  lat: number,
  lon: number,
  apiKey: string,
  limit: number = 5
): Promise<NearbyStation[]> {
  const url = `${WU_BASE}/v3/location/near?geocode=${lat},${lon}&product=pws&format=json&apiKey=${encodeURIComponent(apiKey)}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (resp.status === 401 || resp.status === 403) {
      await handleWeatherApiAccessDenied(resp.status, `findNearbyStations(${lat},${lon})`);
    }
    if (!resp.ok) return [];
    const data = await resp.json();
    const loc = data.location;
    if (!loc?.stationId) return [];

    const stations: NearbyStation[] = [];
    for (let i = 0; i < loc.stationId.length && stations.length < limit; i++) {
      if (loc.qcStatus[i] === 1) {
        stations.push({
          stationId: loc.stationId[i],
          name: loc.stationName[i],
          distanceMi: loc.distanceMi[i],
        });
      }
    }
    return stations;
  } catch {
    return [];
  }
}

/**
 * Check if a station is responding with data.
 * Returns the observation if working, null if offline.
 */
async function probeStation(
  stationId: string,
  apiKey: string
): Promise<Record<string, unknown> | null> {
  const url = `${WU_BASE}/v2/pws/observations/current?stationId=${encodeURIComponent(stationId)}&format=json&units=e&apiKey=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (resp.status === 401 || resp.status === 403) {
      await handleWeatherApiAccessDenied(resp.status, `probeStation(${stationId})`);
    }
    if (resp.status !== 200) return null;
    const data = await resp.json();
    return data.observations?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * For each offline station, find a nearby replacement and update the trail's
 * primary_station_id in the database. Returns a list of replacements made.
 */
export async function autoReplaceOfflineStations(
  apiKey: string
): Promise<Array<{ trailName: string; oldStation: string; newStation: string; distanceMi: number }>> {
  const trails = await sql`
    SELECT id, name, primary_station_id, latitude, longitude
    FROM trails
    WHERE is_archived = false AND updates_enabled = true
      AND latitude IS NOT NULL AND longitude IS NOT NULL
  `;

  const replacements: Array<{ trailName: string; oldStation: string; newStation: string; distanceMi: number }> = [];

  for (const trail of trails.rows) {
    const stationId = trail.primary_station_id as string;
    if (!stationId) continue;

    const obs = await probeStation(stationId, apiKey);
    if (obs) continue; // Station is working

    const lat = parseFloat(trail.latitude as string);
    const lon = parseFloat(trail.longitude as string);
    const nearby = await findNearbyStations(lat, lon, apiKey, 5);

    // Find first nearby station that's different from current and actually responds
    for (const candidate of nearby) {
      if (candidate.stationId === stationId) continue;
      const check = await probeStation(candidate.stationId, apiKey);
      if (check) {
        await sql`
          UPDATE trails SET primary_station_id = ${candidate.stationId}, updated_at = now()
          WHERE id = ${trail.id as string}
        `;
        replacements.push({
          trailName: trail.name as string,
          oldStation: stationId,
          newStation: candidate.stationId,
          distanceMi: candidate.distanceMi,
        });
        break;
      }
    }
  }

  return replacements;
}

/**
 * Cross-validate precipitation readings against nearby stations.
 * If the primary station shows 0 precip but nearby stations show rain,
 * returns the average precipitation from nearby stations.
 * This catches broken rain gauges.
 */
export async function crossValidatePrecipitation(
  stationId: string,
  precipIn: number,
  lat: number,
  lon: number,
  apiKey: string
): Promise<{ adjusted: boolean; precipIn: number; source: string }> {
  // Only cross-validate when primary shows no rain
  if (precipIn > 0) {
    return { adjusted: false, precipIn, source: stationId };
  }

  const nearby = await findNearbyStations(lat, lon, apiKey, 5);
  const nearbyWithRain: Array<{ stationId: string; precipIn: number; distanceMi: number }> = [];

  for (const candidate of nearby) {
    if (candidate.stationId === stationId) continue;
    if (candidate.distanceMi > 10) continue; // Only check within 10 miles

    const obs = await probeStation(candidate.stationId, apiKey);
    if (!obs) continue;

    const imperial = obs.imperial as Record<string, number> | undefined;
    const precip = imperial?.precipTotal ?? 0;
    if (precip > 0) {
      nearbyWithRain.push({
        stationId: candidate.stationId,
        precipIn: precip,
        distanceMi: candidate.distanceMi,
      });
    }
  }

  // If 2+ nearby stations show rain, the primary gauge is likely broken
  if (nearbyWithRain.length >= 2) {
    const avgPrecip = nearbyWithRain.reduce((sum, s) => sum + s.precipIn, 0) / nearbyWithRain.length;
    const sourceIds = nearbyWithRain.map((s) => s.stationId).join(',');
    console.warn(
      `Station ${stationId} shows 0 precip but ${nearbyWithRain.length} nearby stations show rain (avg ${avgPrecip.toFixed(3)}"). Using nearby data.`
    );
    return { adjusted: true, precipIn: avgPrecip, source: sourceIds };
  }

  return { adjusted: false, precipIn, source: stationId };
}
