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

/** Drying window: 8am–6pm Central Time (10 hours of effective drying per day). */
const DRYING_START_HOUR = 8;  // 8am CT
const DRYING_END_HOUR = 18;   // 6pm CT
const DRYING_HOURS_PER_DAY = DRYING_END_HOUR - DRYING_START_HOUR; // 10

/**
 * Calculate when a trail will be dry based on daytime-only drying.
 *
 * Rules:
 * - Drying only happens 8am–6pm CT (10 hours/day)
 * - Drying starts the first morning (8am CT) after rain ends
 * - Overnight hours don't count at all
 * - dryingRate is inches dried per full drying day (10 hours)
 */
function calculateDryTime(
  rainEnd: Date,
  effectiveRain: number,
  dryingRatePerDay: number,
): Date {
  const DRYING_HOURS = DRYING_END_HOUR - DRYING_START_HOUR; // 10

  // How many drying days needed (each day = dryingRate inches dried)
  const fullDaysNeeded = effectiveRain / dryingRatePerDay;
  const wholeDays = Math.floor(fullDaysNeeded);
  const fractionalDay = fullDaysNeeded - wholeDays;
  const fractionalHours = Math.round(fractionalDay * DRYING_HOURS);

  // Find "tomorrow 8am CT" in UTC
  // Step 1: get the CT date of rain end
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(rainEnd);

  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;

  // Next day at 8am CT as an ISO string
  const rainEndDateCT = new Date(
    Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  );
  const nextDay = new Date(rainEndDateCT);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const ny = nextDay.getUTCFullYear();
  const nm = nextDay.getUTCMonth() + 1;
  const nd = nextDay.getUTCDate();

  // Build "YYYY-MM-DDT08:00:00" in CT, then find the UTC offset for that moment
  // CT is either UTC-6 (CST) or UTC-5 (CDT)
  const target8amCT = `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}T${String(DRYING_START_HOUR).padStart(2, '0')}:00:00`;

  // Use Intl to find the actual UTC offset at that CT time
  // Create a UTC date and check what CT hour it maps to, then adjust
  const guess = new Date(target8amCT + 'Z'); // pretend it's UTC
  const guessParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric', hour12: false,
  }).formatToParts(guess);
  const guessHourCT = +(guessParts.find(x => x.type === 'hour')?.value ?? '0');
  const offsetHours = guessHourCT - DRYING_START_HOUR;

  // Adjust: if CT shows a different hour, shift to compensate
  const dryingStartUtc = new Date(guess.getTime() - offsetHours * 60 * 60 * 1000);

  // Add whole drying days + fractional hours
  const dryTimeUtc = new Date(
    dryingStartUtc.getTime()
    + wholeDays * 24 * 60 * 60 * 1000
    + fractionalHours * 60 * 60 * 1000
  );

  return dryTimeUtc;
}



/**
 * Update predictions for all trails with status "Predicted Wet" or "Predicted Dry".
 *
 * For each drying trail:
 *  1. Get the most recent rain event
 *  2. Get the latest weather observation for the trail's station
 *  3. Get historical outcomes for context
 *  4. Generate an updated prediction
 *  5. If predicted dry time has passed, transition to "Predicted Dry" (Req 4.4)
 *
 * Returns all updated predictions.
 */
export async function updatePredictions(): Promise<Prediction[]> {
  const updatedPredictions: Prediction[] = [];

  // Get all drying trails that don't have an active rain event
  // (active rain means it's still raining — predictions should wait)
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

    // Get the most recent ended rain event for this trail
    const rainResult = await sql`
      SELECT id, trail_id, start_timestamp, end_timestamp,
             total_precipitation_in, is_active
      FROM rain_events
      WHERE trail_id = ${trail.id} AND is_active = false
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

    // Simple drying rate model:
    // Cap the effective rain at max_drying_days * drying_rate_in_per_day
    const dryingRate = trail.dryingRateInPerDay > 0 ? trail.dryingRateInPerDay : 1;
    const maxAbsorbable = trail.maxDryingDays * dryingRate;
    const effectiveRain = Math.min(rainEvent.totalPrecipitationIn, maxAbsorbable);

    // Drying only happens during daylight hours (8am–6pm CT).
    // Drying starts the first morning after rain ends.
    // We step forward through daytime hours, deducting drying_rate per full day.
    const predictedDryTime = calculateDryTime(
      rainEvent.endTimestamp,
      effectiveRain,
      dryingRate,
    );

    // Build input data for record keeping
    const inputData: PredictionInput = {
      totalPrecipitationIn: rainEvent.totalPrecipitationIn,
      dryingRateInPerDay: trail.dryingRateInPerDay,
      maxDryingDays: trail.maxDryingDays,
      temperatureF: 0,
      humidityPercent: 0,
      windSpeedMph: 0,
      solarRadiationWm2: 0,
      daylightHours: 0,
      historicalOutcomes: [],
    };

    // Check if there's an existing prediction for this rain event to update
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

    // Transition to "Predicted Dry" if predicted dry time has passed
    if (predictedDryTime <= new Date() && trail.updatesEnabled) {
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
 *
 * Updates the most recent prediction for the given trail + rain event
 * with the actual dry time (Req 10.1).
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
