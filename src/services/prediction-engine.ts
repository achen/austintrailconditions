import OpenAI from 'openai';
import { sql } from '@/lib/db';
import {
  Trail,
  RainEvent,
  WeatherObservation,
  HistoricalOutcome,
  Prediction,
  PredictionInput,
} from '@/types';
import { findSimilarHistoricalOutcomes } from '@/services/history-service';

/**
 * PredictionEngine — Generates and updates trail dryness predictions.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 10.1, 10.2
 *
 * - predict(): generates a prediction using OpenAI with weather + history context,
 *   falls back to rule-based if OpenAI fails.
 * - updatePredictions(): refreshes predictions for all drying trails, transitions
 *   status when predicted dry time has passed.
 * - fallbackPredict(): pure rule-based estimation using trail drying characteristics.
 * - recordActualOutcome(): records actual dry time on a prediction record.
 */

/**
 * Map a database row to a Prediction object.
 */
function mapRowToPrediction(row: Record<string, unknown>): Prediction {
  return {
    id: row.id as string,
    trailId: row.trail_id as string,
    rainEventId: row.rain_event_id as string,
    predictedDryTime: new Date(row.predicted_dry_time as string),
    actualDryTime: row.actual_dry_time ? new Date(row.actual_dry_time as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    inputData: row.input_data as PredictionInput,
  };
}

/**
 * Build the OpenAI prompt for drying prediction.
 */
function buildPredictionPrompt(
  trail: Trail,
  rainEvent: RainEvent,
  weather: WeatherObservation,
  history: HistoricalOutcome[]
): string {
  const historyContext =
    history.length > 0
      ? history
          .slice(0, 5)
          .map(
            (h, i) =>
              `  ${i + 1}. Precipitation: ${h.precipitationIn}in, Predicted dry: ${h.predictedDryTime.toISOString()}, Actual dry: ${h.actualDryTime.toISOString()}`
          )
          .join('\n')
      : '  No historical data available.';

  return `You are a trail drying prediction model. Given the following data, estimate how many hours until the trail is dry and rideable after the rain event ended.

Trail: ${trail.name}
  Drying rate: ${trail.dryingRateInPerDay} inches/day
  Max drying days: ${trail.maxDryingDays}

Rain Event:
  Total precipitation: ${rainEvent.totalPrecipitationIn} inches
  Started: ${rainEvent.startTimestamp.toISOString()}
  Ended: ${rainEvent.endTimestamp?.toISOString() ?? 'still active'}

Current Weather:
  Temperature: ${weather.temperatureF}°F
  Humidity: ${weather.humidityPercent}%
  Wind speed: ${weather.windSpeedMph} mph
  Solar radiation: ${weather.solarRadiationWm2} W/m²
  Daylight hours: ${weather.daylightHours}

Historical outcomes for similar conditions on this trail:
${historyContext}

Respond ONLY with a JSON object: {"estimatedDryHours": <number>}
The number should be a positive decimal representing hours from now until the trail is dry.`;
}

/**
 * Parse the OpenAI response for estimated dry hours.
 * Returns null if parsing fails.
 */
function parsePredictionResponse(content: string): number | null {
  try {
    const parsed = JSON.parse(content);
    const hours = Number(parsed.estimatedDryHours);
    if (isNaN(hours) || hours <= 0) return null;
    return hours;
  } catch {
    return null;
  }
}

/**
 * Rule-based fallback prediction using the design formula.
 *
 * daysToAbsorb = totalPrecipitationIn / trail.dryingRateInPerDay
 * estimatedDryHours = min(daysToAbsorb, trail.maxDryingDays) * 24
 * estimatedDryHours *= (humidityPercent / 50)       — humidity slows drying
 * estimatedDryHours *= (1 - windSpeedMph * 0.005)   — wind helps
 * estimatedDryHours *= (1 - solarRadiationWm2 * 0.0003) — sun helps
 * estimatedDryHours = max(estimatedDryHours, 1)      — minimum 1 hour
 */
export function fallbackPredict(
  trail: Trail,
  rainEvent: RainEvent,
  currentWeather: WeatherObservation
): Date {
  const dryingRate = trail.dryingRateInPerDay > 0 ? trail.dryingRateInPerDay : 1;
  const daysToAbsorb = rainEvent.totalPrecipitationIn / dryingRate;
  let estimatedDryHours = Math.min(daysToAbsorb, trail.maxDryingDays) * 24;

  // Weather adjustments
  estimatedDryHours *= currentWeather.humidityPercent / 50;
  estimatedDryHours *= 1 - currentWeather.windSpeedMph * 0.005;
  estimatedDryHours *= 1 - currentWeather.solarRadiationWm2 * 0.0003;

  // Minimum 1 hour
  estimatedDryHours = Math.max(estimatedDryHours, 1);

  // Calculate from rain event end time (or now if still active)
  const baseTime = rainEvent.endTimestamp ?? new Date();
  return new Date(baseTime.getTime() + estimatedDryHours * 60 * 60 * 1000);
}

/**
 * Generate a prediction for a trail after a rain event ends.
 *
 * Uses OpenAI with weather data + historical outcomes as context.
 * Falls back to rule-based estimation if OpenAI fails (Req 4.6).
 */
export async function predict(
  trail: Trail,
  rainEvent: RainEvent,
  currentWeather: WeatherObservation,
  history: HistoricalOutcome[],
  openaiClient?: OpenAI
): Promise<Prediction> {
  const inputData: PredictionInput = {
    totalPrecipitationIn: rainEvent.totalPrecipitationIn,
    dryingRateInPerDay: trail.dryingRateInPerDay,
    maxDryingDays: trail.maxDryingDays,
    temperatureF: currentWeather.temperatureF,
    humidityPercent: currentWeather.humidityPercent,
    windSpeedMph: currentWeather.windSpeedMph,
    solarRadiationWm2: currentWeather.solarRadiationWm2,
    daylightHours: currentWeather.daylightHours,
    historicalOutcomes: history,
  };

  let predictedDryTime: Date;

  try {
    const client = openaiClient ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = buildPredictionPrompt(trail, rainEvent, currentWeather, history);

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a trail drying prediction model. Respond only with JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 100,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const estimatedHours = parsePredictionResponse(content);

    if (estimatedHours !== null) {
      predictedDryTime = new Date(Date.now() + estimatedHours * 60 * 60 * 1000);
    } else {
      // OpenAI returned unparseable response — use fallback
      predictedDryTime = fallbackPredict(trail, rainEvent, currentWeather);
    }
  } catch (error) {
    console.error('OpenAI prediction error, using fallback:', error);
    predictedDryTime = fallbackPredict(trail, rainEvent, currentWeather);
  }

  // Store the prediction
  const result = await sql`
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

  // Set trail status to "Probably Not Rideable" (Req 4.1)
  await sql`
    UPDATE trails
    SET condition_status = 'Probably Not Rideable',
        updated_at = now()
    WHERE id = ${trail.id}
  `;

  return mapRowToPrediction(result.rows[0]);
}

/**
 * Update predictions for all trails with status "Probably Not Rideable" or "Probably Rideable".
 *
 * For each drying trail:
 *  1. Get the most recent rain event
 *  2. Get the latest weather observation for the trail's station
 *  3. Get historical outcomes for context
 *  4. Generate an updated prediction
 *  5. If predicted dry time has passed, transition to "Probably Rideable" (Req 4.4)
 *
 * Returns all updated predictions.
 */
export async function updatePredictions(openaiClient?: OpenAI): Promise<Prediction[]> {
  const updatedPredictions: Prediction[] = [];

  // Get all drying trails
  const trailsResult = await sql`
    SELECT id, name, description, primary_station_id, drying_rate_in_per_day,
           max_drying_days, updates_enabled, is_archived, condition_status,
           created_at, updated_at
    FROM trails
    WHERE condition_status IN ('Probably Not Rideable', 'Probably Rideable')
      AND is_archived = false
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

    // Get latest weather observation for this trail's station
    const weatherResult = await sql`
      SELECT station_id, timestamp, precipitation_in, temperature_f,
             humidity_percent, wind_speed_mph, solar_radiation_wm2, daylight_hours
      FROM weather_observations
      WHERE station_id = ${trail.primaryStationId}
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    if (weatherResult.rows.length === 0) continue;

    const currentWeather: WeatherObservation = {
      stationId: weatherResult.rows[0].station_id as string,
      timestamp: new Date(weatherResult.rows[0].timestamp as string),
      precipitationIn: Number(weatherResult.rows[0].precipitation_in),
      temperatureF: Number(weatherResult.rows[0].temperature_f),
      humidityPercent: Number(weatherResult.rows[0].humidity_percent),
      windSpeedMph: Number(weatherResult.rows[0].wind_speed_mph),
      solarRadiationWm2: Number(weatherResult.rows[0].solar_radiation_wm2),
      daylightHours: Number(weatherResult.rows[0].daylight_hours),
    };

    // Get historical outcomes for similar conditions (Req 9.2, 9.3, 10.2)
    const history = await findSimilarHistoricalOutcomes(
      trail.id,
      rainEvent.totalPrecipitationIn,
      currentWeather.temperatureF
    );

    // Check if there's an existing prediction for this rain event to update
    const existingPredResult = await sql`
      SELECT id FROM predictions
      WHERE trail_id = ${trail.id} AND rain_event_id = ${rainEvent.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    // Build input data
    const inputData: PredictionInput = {
      totalPrecipitationIn: rainEvent.totalPrecipitationIn,
      dryingRateInPerDay: trail.dryingRateInPerDay,
      maxDryingDays: trail.maxDryingDays,
      temperatureF: currentWeather.temperatureF,
      humidityPercent: currentWeather.humidityPercent,
      windSpeedMph: currentWeather.windSpeedMph,
      solarRadiationWm2: currentWeather.solarRadiationWm2,
      daylightHours: currentWeather.daylightHours,
      historicalOutcomes: history,
    };

    // Calculate new predicted dry time
    let predictedDryTime: Date;
    try {
      const client = openaiClient ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const prompt = buildPredictionPrompt(trail, rainEvent, currentWeather, history);

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a trail drying prediction model. Respond only with JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 100,
      });

      const content = response.choices[0]?.message?.content ?? '';
      const estimatedHours = parsePredictionResponse(content);
      predictedDryTime = estimatedHours !== null
        ? new Date(Date.now() + estimatedHours * 60 * 60 * 1000)
        : fallbackPredict(trail, rainEvent, currentWeather);
    } catch (error) {
      console.error('OpenAI prediction update error, using fallback:', error);
      predictedDryTime = fallbackPredict(trail, rainEvent, currentWeather);
    }

    let prediction: Prediction;

    if (existingPredResult.rows.length > 0) {
      // Update existing prediction
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
      // Create new prediction
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

    // Transition to "Probably Rideable" if predicted dry time has passed (Req 4.4)
    // Only auto-update status for trails with updates enabled
    if (predictedDryTime <= new Date() && trail.updatesEnabled) {
      await sql`
        UPDATE trails
        SET condition_status = 'Probably Rideable',
            updated_at = now()
        WHERE id = ${trail.id}
          AND condition_status = 'Probably Not Rideable'
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
