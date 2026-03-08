import { sql } from '@/lib/db';
import {
  Trail,
  RainEvent,
  Prediction,
  PredictionInput,
} from '@/types';

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
// Base evaporation rate: 0.6 mm/hr ≈ 0.024 in/hr under ideal conditions
// (sunny, warm, breezy). Multipliers adjust for actual conditions.
//
// Solar multiplier (from solar radiation W/m²):
//   >= 600  → 1.0  (full sun)
//   200-600 → 0.7  (partly cloudy)
//   < 200   → 0.3  (overcast)
//   0       → 0.0  (night / no sun at all)
//
// Wind multiplier:
//   < 3 mph  → 0.5  (calm)
//   3-10 mph → 1.0  (light breeze)
//   > 10 mph → 1.3  (windy)
//
// Temperature multiplier:
//   < 50°F  → 0.3
//   50-60°F → 0.5
//   60-80°F → 1.0
//   80-90°F → 1.2
//   > 90°F  → 1.3

const BASE_EVAP_IN_PER_HR = 0.024; // 0.6 mm/hr in inches

function solarMultiplier(solarWm2: number): number {
  if (solarWm2 <= 0) return 0;
  if (solarWm2 < 200) return 0.3;
  if (solarWm2 < 600) return 0.7;
  return 1.0;
}

function windMultiplier(windMph: number): number {
  if (windMph < 3) return 0.5;
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
  // Get hourly observations during daytime (8am-6pm CT) since rain ended
  const obs = await sql`
    SELECT solar_radiation_wm2, wind_speed_mph, temperature_f, timestamp
    FROM weather_observations
    WHERE trail_id = ${trailId}
      AND station_id = ${stationId}
      AND timestamp >= ${rainEnd.toISOString()}
      AND EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Chicago') >= 8
      AND EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Chicago') < 18
    ORDER BY timestamp ASC
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
async function estimateRemainingHours(
  trailId: string,
  stationId: string,
  remainingIn: number,
): Promise<{ hours: number; ratePerHour: number }> {
  // Get the most recent 6 daytime observations for trend
  const recent = await sql`
    SELECT solar_radiation_wm2, wind_speed_mph, temperature_f
    FROM weather_observations
    WHERE trail_id = ${trailId}
      AND station_id = ${stationId}
      AND EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Chicago') >= 8
      AND EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Chicago') < 18
    ORDER BY timestamp DESC
    LIMIT 6
  `;

  let ratePerHour: number;

  if (recent.rows.length > 0) {
    // Average the recent conditions
    let totalRate = 0;
    for (const o of recent.rows) {
      totalRate += dryingPerHour({
        solarRadiationWm2: Number(o.solar_radiation_wm2),
        windSpeedMph: Number(o.wind_speed_mph),
        temperatureF: Number(o.temperature_f),
      });
    }
    ratePerHour = totalRate / recent.rows.length;
  } else {
    // Conservative default: overcast, calm, cool
    ratePerHour = dryingPerHour({
      solarRadiationWm2: 100,
      windSpeedMph: 2,
      temperatureF: 55,
    });
  }

  // Minimum rate to avoid infinite predictions
  ratePerHour = Math.max(ratePerHour, 0.001);

  const hours = remainingIn / ratePerHour;
  return { hours, ratePerHour };
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

    // Sum precipitation from all rain events that ended within 48h before
    // this one started (consecutive/overlapping storms compound moisture)
    const compoundResult = await sql`
      SELECT COALESCE(SUM(total_precipitation_in), 0) as compound_precip
      FROM rain_events
      WHERE trail_id = ${trail.id}
        AND is_active = false
        AND total_precipitation_in >= 0.1
        AND end_timestamp >= ${new Date(rainEvent.startTimestamp.getTime() - 48 * 60 * 60 * 1000).toISOString()}
        AND end_timestamp <= ${rainEvent.endTimestamp.toISOString()}
    `;
    const totalRain = Number(compoundResult.rows[0].compound_precip);

    // Cap at max absorbable
    const maxAbsorbable = trail.maxDryingDays * BASE_EVAP_IN_PER_HR * 10; // 10 hrs/day ideal
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
        trail.id,
        trail.primaryStationId,
        remainingMoisture,
      );
      predictedDryTime = addDaytimeHours(new Date(), hours);
    }

    const inputData: PredictionInput = {
      totalPrecipitationIn: totalRain,
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
