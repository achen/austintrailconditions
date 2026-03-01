import { sql } from '@/lib/db';
import type { HistoricalOutcome, WeatherObservation } from '@/types';

/**
 * HistoryService — Queries historical rain events with similar conditions
 * for correlation analysis.
 *
 * Requirements: 9.2, 9.3, 10.2
 *
 * Finds past rain events for the same trail where:
 *  - total_precipitation_in is within ±0.5 inches
 *  - average temperature during the event is within ±10°F
 * Only includes predictions with recorded actual_dry_time (completed outcomes).
 * Results ordered by most recent first, limited to 10.
 */

/**
 * Query historical rain events with similar conditions for a given trail.
 *
 * @param trailId - The trail to find historical data for
 * @param precipitationIn - Current rain event precipitation to match against (±0.5 in)
 * @param temperatureF - Current temperature to match against (±10°F)
 * @returns Up to 10 HistoricalOutcome records, most recent first
 */
export async function findSimilarHistoricalOutcomes(
  trailId: string,
  precipitationIn: number,
  temperatureF: number
): Promise<HistoricalOutcome[]> {
  const minPrecip = precipitationIn - 0.5;
  const maxPrecip = precipitationIn + 0.5;
  const minTemp = temperatureF - 10;
  const maxTemp = temperatureF + 10;

  const result = await sql`
    SELECT
      re.total_precipitation_in,
      p.predicted_dry_time,
      p.actual_dry_time,
      p.input_data
    FROM predictions p
    JOIN rain_events re ON re.id = p.rain_event_id
    WHERE p.trail_id = ${trailId}
      AND p.actual_dry_time IS NOT NULL
      AND re.total_precipitation_in BETWEEN ${minPrecip} AND ${maxPrecip}
      AND (p.input_data->>'temperatureF')::numeric BETWEEN ${minTemp} AND ${maxTemp}
    ORDER BY p.created_at DESC
    LIMIT 10
  `;

  return result.rows.map((row) => ({
    precipitationIn: Number(row.total_precipitation_in),
    predictedDryTime: new Date(row.predicted_dry_time as string),
    actualDryTime: new Date(row.actual_dry_time as string),
    weatherConditions: extractWeatherConditions(row.input_data),
  }));
}

/**
 * Extract weather conditions from the stored input_data JSONB.
 */
function extractWeatherConditions(
  inputData: unknown
): Partial<WeatherObservation> {
  if (!inputData || typeof inputData !== 'object') return {};

  const data = inputData as Record<string, unknown>;
  const conditions: Partial<WeatherObservation> = {};

  if (typeof data.temperatureF === 'number') conditions.temperatureF = data.temperatureF;
  if (typeof data.humidityPercent === 'number') conditions.humidityPercent = data.humidityPercent;
  if (typeof data.windSpeedMph === 'number') conditions.windSpeedMph = data.windSpeedMph;
  if (typeof data.solarRadiationWm2 === 'number') conditions.solarRadiationWm2 = data.solarRadiationWm2;
  if (typeof data.daylightHours === 'number') conditions.daylightHours = data.daylightHours;

  return conditions;
}
