import { sql } from '@/lib/db';
import {
  Trail,
  RainEvent,
  Prediction,
  PredictionInput,
} from '@/types';
import type { ForecastDaypart } from '@/services/weather-collector';

function mapRowToPrediction(row: Record<string, unknown>): Prediction {
  return {
    id: row.id as string,
    trailId: row.trail_id as string,
    rainEventId: row.rain_event_id as string,
    predictedDryTime: new Date(row.predicted_dry_time as string),
    actualDryTime: row.actual_dry_time ? new Date(row.actual_dry_time as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    inputData: (typeof row.input_data === 'string' ? JSON.parse(row.input_data) : row.input_data) as PredictionInput,
  };
}

// ── Weather-responsive drying model ──────────────────────────────────
//
// Base evaporation rate: calibrated against observed drying times on
// Central Texas rocky/limestone trails. Real-world trails dry ~0.3–0.5″
// per sunny day. With 10 daytime hours and typical multipliers (~0.8),
// a base of 0.048 in/hr yields ~0.38″/day under good conditions.
//
// Solar multiplier (from solar radiation W/m²):
//   >= 600  → 1.0  (full sun)
//   200-600 → 0.7  (partly cloudy)
//   < 200   → 0.3  (overcast)
//   0       → 0.0  (night / no sun at all)
//
// Wind multiplier:
//   < 3 mph  → 0.8  (calm — still evaporates)
//   3-10 mph → 1.0  (light breeze)
//   > 10 mph → 1.3  (windy)
//
// Temperature multiplier:
//   < 50°F  → 0.3
//   50-60°F → 0.5
//   60-80°F → 1.0
//   80-90°F → 1.2
//   > 90°F  → 1.3

const BASE_EVAP_IN_PER_HR = 0.048;

function solarMultiplier(solarWm2: number): number {
  if (solarWm2 <= 0) return 0;
  if (solarWm2 < 200) return 0.3;
  if (solarWm2 < 600) return 0.7;
  return 1.0;
}

function windMultiplier(windMph: number): number {
  if (windMph < 3) return 0.8;
  if (windMph <= 10) return 1.0;
  return 1.3;
}

function tempMultiplier(tempF: number): number {
  if (tempF < 50) return 0.3;
  if (tempF < 60) return 0.5;
  if (tempF <= 80) return 1.0;
  if (tempF <= 90) return 1.2;
  return 1.3;
}

interface HourlyWeather {
  solarRadiationWm2: number;
  windSpeedMph: number;
  temperatureF: number;
}

/**
 * Calculate how many inches of moisture are evaporated in one hour
 * given the weather conditions.
 */
function dryingPerHour(w: HourlyWeather): number {
  return BASE_EVAP_IN_PER_HR
    * solarMultiplier(w.solarRadiationWm2)
    * windMultiplier(w.windSpeedMph)
    * tempMultiplier(w.temperatureF);
}

/**
 * Compute total inches dried so far using actual hourly weather observations
 * from rain end to now. Only counts daytime hours (8am-6pm CT).
 *
 * Returns { driedSoFar, lastObsTime, avgConditions }.
 */
async function computeActualDrying(
  trailId: string,
  stationId: string,
  rainEnd: Date,
): Promise<{
  driedSoFar: number;
  lastObsTime: Date | null;
  avgSolar: number;
  avgWind: number;
  avgTemp: number;
}> {
  // Get hourly observations during daytime (8am-6pm CT) since rain ended.
  // Solar radiation is effectively the same across the metro area, so always
  // use the max reading from any station at the same hour. This compensates
  // for cheap/missing solar sensors on individual stations.
  const obs = await sql`
    SELECT
      o.timestamp,
      o.wind_speed_mph,
      o.temperature_f,
      GREATEST(o.solar_radiation_wm2, COALESCE((
        SELECT MAX(o2.solar_radiation_wm2)
        FROM weather_observations o2
        WHERE date_trunc('hour', o2.timestamp) = date_trunc('hour', o.timestamp)
          AND o2.solar_radiation_wm2 > 0
      ), 0)) AS solar_radiation_wm2
    FROM weather_observations o
    WHERE o.trail_id = ${trailId}
      AND o.station_id = ${stationId}
      AND o.timestamp >= ${rainEnd.toISOString()}
      AND EXTRACT(HOUR FROM o.timestamp AT TIME ZONE 'America/Chicago') >= 8
      AND EXTRACT(HOUR FROM o.timestamp AT TIME ZONE 'America/Chicago') < 18
    ORDER BY o.timestamp ASC
  `;

  let driedSoFar = 0;
  let lastObsTime: Date | null = null;
  let totalSolar = 0, totalWind = 0, totalTemp = 0;

  for (const o of obs.rows) {
    const w: HourlyWeather = {
      solarRadiationWm2: Number(o.solar_radiation_wm2),
      windSpeedMph: Number(o.wind_speed_mph),
      temperatureF: Number(o.temperature_f),
    };
    // Each observation ≈ 1 hour of conditions (hourly polling)
    driedSoFar += dryingPerHour(w);
    lastObsTime = new Date(o.timestamp as string);
    totalSolar += w.solarRadiationWm2;
    totalWind += w.windSpeedMph;
    totalTemp += w.temperatureF;
  }

  const count = obs.rows.length || 1;
  return {
    driedSoFar,
    lastObsTime,
    avgSolar: totalSolar / count,
    avgWind: totalWind / count,
    avgTemp: totalTemp / count,
  };
}

/**
 * Estimate remaining drying time based on recent weather conditions.
 * Uses the average conditions from the last 6 hours of daytime observations
 * to project forward. If no recent observations, uses conservative defaults
 * (overcast, calm, cool).
 *
 * Returns estimated hours until dry (daytime hours only, 8am-6pm CT).
 */
/**
 * Estimate remaining drying time using stored forecast dayparts.
 *
 * Reads the most recent weather_forecasts row with dayparts, then steps
 * through each daytime daypart (~10 drying hours each) computing drying
 * per daypart using the forecast's solar/wind/temp values.
 *
 * Falls back to "typical Austin" conditions if no forecast dayparts exist.
 */
async function estimateRemainingHours(
  remainingIn: number,
): Promise<{ hours: number; ratePerHour: number }> {
  // Try to load forecast dayparts from DB
  const forecastResult = await sql`
    SELECT dayparts FROM weather_forecasts
    WHERE dayparts IS NOT NULL
    ORDER BY forecast_date DESC
    LIMIT 1
  `;

  let dayparts: ForecastDaypart[] = [];
  if (forecastResult.rows.length > 0 && forecastResult.rows[0].dayparts) {
    const raw = forecastResult.rows[0].dayparts;
    dayparts = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ForecastDaypart[];
  }

  if (dayparts.length === 0) {
    // Fallback: typical Austin conditions
    const typicalRate = dryingPerHour({
      solarRadiationWm2: 400,
      windSpeedMph: 5,
      temperatureF: 75,
    });
    const ratePerHour = Math.max(typicalRate, 0.001);
    return { hours: remainingIn / ratePerHour, ratePerHour };
  }

  // Step through forecast dayparts, each represents ~10 daytime drying hours
  const HOURS_PER_DAYPART = 10;
  let moisture = remainingIn;
  let totalHours = 0;

  // Figure out which daypart we're currently in so we don't re-count past ones
  const now = new Date();
  const ctHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now).find(p => p.type === 'hour')?.value ?? '12'
  );

  // Today is dayOffset 0. If it's past 6pm CT, start from tomorrow (dayOffset 1)
  const startDayOffset = ctHour >= 18 ? 1 : 0;
  // If we're mid-day, only partial hours remain today
  const hoursLeftToday = ctHour >= 8 && ctHour < 18 ? 18 - ctHour : 0;

  for (const dp of dayparts) {
    if (dp.dayOffset < startDayOffset) continue;
    if (moisture <= 0) break;

    // Skip dayparts with high rain chance — no drying during rain
    if (dp.precipChance >= 50) {
      // Rain daypart: count the hours but no drying
      const hrs = dp.dayOffset === startDayOffset && hoursLeftToday > 0
        ? hoursLeftToday : HOURS_PER_DAYPART;
      totalHours += hrs;
      continue;
    }

    const rate = dryingPerHour({
      solarRadiationWm2: dp.solarRadiationWm2,
      windSpeedMph: dp.windSpeedMph,
      temperatureF: dp.temperatureF,
    });

    const hrs = dp.dayOffset === startDayOffset && hoursLeftToday > 0
      ? hoursLeftToday : HOURS_PER_DAYPART;
    const dried = rate * hrs;

    if (dried >= moisture) {
      // Finishes during this daypart
      totalHours += moisture / Math.max(rate, 0.001);
      moisture = 0;
    } else {
      totalHours += hrs;
      moisture -= dried;
    }
  }

  // If forecast dayparts ran out but moisture remains, use last daypart's rate
  // (or typical conditions) for the remainder
  if (moisture > 0) {
    const lastDp = dayparts[dayparts.length - 1];
    const fallbackRate = lastDp
      ? dryingPerHour({
          solarRadiationWm2: lastDp.solarRadiationWm2,
          windSpeedMph: lastDp.windSpeedMph,
          temperatureF: lastDp.temperatureF,
        })
      : dryingPerHour({ solarRadiationWm2: 400, windSpeedMph: 5, temperatureF: 75 });
    totalHours += moisture / Math.max(fallbackRate, 0.001);
  }

  const avgRate = totalHours > 0 ? remainingIn / totalHours : 0.001;
  return { hours: totalHours, ratePerHour: avgRate };
}

/**
 * Convert daytime-only hours into a future UTC timestamp.
 * Only counts hours between 8am-6pm CT (10 hours per day).
 */
function addDaytimeHours(fromUtc: Date, daytimeHours: number): Date {
  const DRYING_START = 8;
  const DRYING_END = 18;
  const HOURS_PER_DAY = DRYING_END - DRYING_START;

  // Get current CT hour
  const ctParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(fromUtc);
  const cp: Record<string, string> = {};
  for (const { type, value } of ctParts) cp[type] = value;
  const ctHour = +cp.hour;
  const ctMinute = +cp.minute;

  let remaining = daytimeHours;
  let cursor = new Date(fromUtc);

  // If we're currently in daytime, use remaining hours today first
  if (ctHour >= DRYING_START && ctHour < DRYING_END) {
    const hoursLeftToday = DRYING_END - ctHour - ctMinute / 60;
    if (remaining <= hoursLeftToday) {
      return new Date(cursor.getTime() + remaining * 60 * 60 * 1000);
    }
    remaining -= hoursLeftToday;
    // Advance to end of today's drying window
    cursor = new Date(cursor.getTime() + hoursLeftToday * 60 * 60 * 1000);
  }

  // Now we need to advance through full days
  const fullDays = Math.floor(remaining / HOURS_PER_DAY);
  const fractionalHours = remaining - fullDays * HOURS_PER_DAY;

  // Find next 8am CT
  const nextParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour12: false,
  }).formatToParts(cursor);
  const np: Record<string, string> = {};
  for (const { type, value } of nextParts) np[type] = value;

  // Move to tomorrow
  const tomorrow = new Date(Date.UTC(+np.year, +np.month - 1, +np.day));
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  // Build 8am CT for tomorrow, find UTC offset
  const target = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}T${String(DRYING_START).padStart(2, '0')}:00:00`;
  const guess = new Date(target + 'Z');
  const gp = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric', hour12: false,
  }).formatToParts(guess);
  const guessHour = +(gp.find(x => x.type === 'hour')?.value ?? '0');
  const offset = guessHour - DRYING_START;
  const next8amUtc = new Date(guess.getTime() - offset * 60 * 60 * 1000);

  // Add full days + fractional hours from 8am
  return new Date(
    next8amUtc.getTime()
    + fullDays * 24 * 60 * 60 * 1000
    + fractionalHours * 60 * 60 * 1000
  );
}

/**
 * Update predictions for all trails with status "Predicted Wet" or "Predicted Dry".
 *
 * Weather-responsive drying model:
 *  1. Sum total rain across all recent overlapping/consecutive rain events
 *  2. Compute actual drying so far using real hourly weather observations
 *  3. Estimate remaining drying time based on recent weather trend
 *  4. If fully dried, transition to "Predicted Dry"
 */
export async function updatePredictions(): Promise<Prediction[]> {
  const updatedPredictions: Prediction[] = [];

  const trailsResult = await sql`
    SELECT id, name, description, primary_station_id, drying_rate_in_per_day,
           max_drying_days, updates_enabled, is_archived, condition_status,
           created_at, updated_at
    FROM trails
    WHERE condition_status IN ('Predicted Wet', 'Predicted Dry')
      AND is_archived = false
      AND NOT EXISTS (
        SELECT 1 FROM rain_events
        WHERE trail_id = trails.id AND is_active = true
          AND total_precipitation_in >= 0.1
      )
  `;

  for (const row of trailsResult.rows) {
    const trail: Trail = {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | null,
      primaryStationId: row.primary_station_id as string,
      dryingRateInPerDay: Number(row.drying_rate_in_per_day),
      maxDryingDays: Number(row.max_drying_days),
      updatesEnabled: row.updates_enabled as boolean,
      isArchived: row.is_archived as boolean,
      conditionStatus: row.condition_status as Trail['conditionStatus'],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      aliases: [],
    };

    // Get the most recent ended rain event (must be >= 0.1" to matter)
    const rainResult = await sql`
      SELECT id, trail_id, start_timestamp, end_timestamp,
             total_precipitation_in, is_active
      FROM rain_events
      WHERE trail_id = ${trail.id} AND is_active = false
        AND total_precipitation_in >= 0.1
      ORDER BY end_timestamp DESC
      LIMIT 1
    `;

    if (rainResult.rows.length === 0) continue;

    const rainEvent: RainEvent = {
      id: rainResult.rows[0].id as string,
      trailId: rainResult.rows[0].trail_id as string,
      startTimestamp: new Date(rainResult.rows[0].start_timestamp as string),
      endTimestamp: rainResult.rows[0].end_timestamp
        ? new Date(rainResult.rows[0].end_timestamp as string)
        : null,
      totalPrecipitationIn: Number(rainResult.rows[0].total_precipitation_in),
      isActive: rainResult.rows[0].is_active as boolean,
    };

    if (!rainEvent.endTimestamp) continue;

    // Find the last time this trail was confirmed dry — don't compound rain from before that
    const lastDryResult = await sql`
      SELECT MAX(tv.created_at) as last_dry
      FROM trail_verifications tv
      WHERE tv.trail_id = ${trail.id} AND tv.classification = 'dry'
    `;
    const lastDryTime = lastDryResult.rows[0]?.last_dry
      ? new Date(lastDryResult.rows[0].last_dry as string)
      : null;

    // Sum precipitation from all rain events that ended within 48h before
    // this one started (consecutive/overlapping storms compound moisture)
    // but only events AFTER the last confirmed dry report
    const compoundCutoff = lastDryTime && lastDryTime > new Date(rainEvent.startTimestamp.getTime() - 48 * 60 * 60 * 1000)
      ? lastDryTime
      : new Date(rainEvent.startTimestamp.getTime() - 48 * 60 * 60 * 1000);

    const compoundResult = await sql`
      SELECT COALESCE(SUM(total_precipitation_in), 0) as compound_precip
      FROM rain_events
      WHERE trail_id = ${trail.id}
        AND is_active = false
        AND total_precipitation_in >= 0.1
        AND end_timestamp >= ${compoundCutoff.toISOString()}
        AND end_timestamp <= ${rainEvent.endTimestamp.toISOString()}
    `;
    const totalRain = Number(compoundResult.rows[0].compound_precip);

    // Cap at max absorbable — drying_rate_in_per_day is repurposed as
    // max absorbable inches (soil capacity). Rocky trails absorb less,
    // dirt trails absorb more. Extra rain beyond this just runs off.
    // Fallback: ~3 sunny warm days of drying (0.288″/day × 3 ≈ 0.86″).
    const maxAbsorbable = trail.dryingRateInPerDay > 0 ? trail.dryingRateInPerDay : 0.86;
    const effectiveRain = Math.min(totalRain, maxAbsorbable);

    // Compute actual drying that has occurred based on real weather
    const { driedSoFar, avgSolar, avgWind, avgTemp } = await computeActualDrying(
      trail.id,
      trail.primaryStationId,
      rainEvent.endTimestamp,
    );

    const remainingMoisture = Math.max(0, effectiveRain - driedSoFar);

    let predictedDryTime: Date;

    if (remainingMoisture <= 0) {
      // Already dry
      predictedDryTime = new Date();
    } else {
      // Estimate when it will finish drying based on recent conditions
      const { hours } = await estimateRemainingHours(
        remainingMoisture,
      );
      predictedDryTime = addDaytimeHours(new Date(), hours);
    }

    const inputData: PredictionInput = {
      totalPrecipitationIn: totalRain,
      remainingMoistureIn: remainingMoisture,
      dryingRateInPerDay: trail.dryingRateInPerDay,
      maxDryingDays: trail.maxDryingDays,
      temperatureF: avgTemp,
      humidityPercent: 0,
      windSpeedMph: avgWind,
      solarRadiationWm2: avgSolar,
      daylightHours: 0,
      historicalOutcomes: [],
    };

    // Upsert prediction
    const existingPredResult = await sql`
      SELECT id FROM predictions
      WHERE trail_id = ${trail.id} AND rain_event_id = ${rainEvent.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    let prediction: Prediction;

    if (existingPredResult.rows.length > 0) {
      const updateResult = await sql`
        UPDATE predictions
        SET predicted_dry_time = ${predictedDryTime.toISOString()},
            input_data = ${JSON.stringify(inputData)},
            updated_at = now()
        WHERE id = ${existingPredResult.rows[0].id as string}
        RETURNING id, trail_id, rain_event_id, predicted_dry_time, actual_dry_time,
                  created_at, updated_at, input_data
      `;
      prediction = mapRowToPrediction(updateResult.rows[0]);
    } else {
      const insertResult = await sql`
        INSERT INTO predictions (trail_id, rain_event_id, predicted_dry_time, input_data)
        VALUES (
          ${trail.id},
          ${rainEvent.id},
          ${predictedDryTime.toISOString()},
          ${JSON.stringify(inputData)}
        )
        RETURNING id, trail_id, rain_event_id, predicted_dry_time, actual_dry_time,
                  created_at, updated_at, input_data
      `;
      prediction = mapRowToPrediction(insertResult.rows[0]);
    }

    updatedPredictions.push(prediction);

    // Transition to "Predicted Dry" if remaining moisture is gone
    if (remainingMoisture <= 0 && trail.updatesEnabled) {
      await sql`
        UPDATE trails
        SET condition_status = 'Predicted Dry',
            updated_at = now()
        WHERE id = ${trail.id}
          AND condition_status = 'Predicted Wet'
      `;
    }
  }

  return updatedPredictions;
}

/**
 * Record actual dry time when a community report confirms trail is dry.
 */
export async function recordActualOutcome(
  trailId: string,
  rainEventId: string,
  actualDryTime: Date
): Promise<void> {
  await sql`
    UPDATE predictions
    SET actual_dry_time = ${actualDryTime.toISOString()},
        updated_at = now()
    WHERE trail_id = ${trailId}
      AND rain_event_id = ${rainEventId}
      AND actual_dry_time IS NULL
  `;
}
