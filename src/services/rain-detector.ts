import { RainEvent, WeatherObservation } from '@/types';
import { sql } from '@/lib/db';

/** Minimum total precipitation (inches) before a rain event affects trail status. */
const MIN_RAIN_THRESHOLD_IN = 0.1;

/**
 * RainDetector — Detects and manages rain events from weather observations.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4
 *
 * - evaluate(): processes observations with precipitation > 0, creating or
 *   extending active rain events per trail. Only sets trail status to
 *   "Predicted Wet" once the event's total reaches MIN_RAIN_THRESHOLD_IN.
 * - checkForRainEnd(): ends active rain events when 60+ minutes of zero
 *   precipitation have elapsed since the last precipitation observation.
 *   Events that never reached the threshold are cleaned up without affecting
 *   trail status.
 */

/**
 * Find all non-archived trails whose primary_station_id matches the given station.
 */
async function getTrailsByStation(stationId: string): Promise<{ id: string; primaryStationId: string }[]> {
  const result = await sql`
    SELECT id, primary_station_id
    FROM trails
    WHERE primary_station_id = ${stationId}
      AND is_archived = false
  `;
  return result.rows.map((r) => ({
    id: r.id as string,
    primaryStationId: r.primary_station_id as string,
  }));
}

/**
 * Get the active rain event for a trail, if one exists.
 */
async function getActiveRainEvent(trailId: string): Promise<RainEvent | null> {
  const result = await sql`
    SELECT id, trail_id, start_timestamp, end_timestamp,
           total_precipitation_in, is_active
    FROM rain_events
    WHERE trail_id = ${trailId} AND is_active = true
    LIMIT 1
  `;
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return mapRowToRainEvent(row);
}

/**
 * Map a database row to a RainEvent object.
 */
function mapRowToRainEvent(row: Record<string, unknown>): RainEvent {
  return {
    id: row.id as string,
    trailId: row.trail_id as string,
    startTimestamp: new Date(row.start_timestamp as string),
    endTimestamp: row.end_timestamp ? new Date(row.end_timestamp as string) : null,
    totalPrecipitationIn: Number(row.total_precipitation_in),
    isActive: row.is_active as boolean,
  };
}

/**
 * Evaluate weather observations and create/extend rain events for affected trails.
 *
 * For each observation with precipitation > 0:
 *  1. Find trails using that station (via primary_station_id)
 *  2. If trail has an active rain event → extend it (add precipitation)
 *  3. If trail has no active rain event → create one
 *  4. Set trail condition_status to "Predicted Wet"
 *
 * Returns all rain events that were created or updated.
 */
export async function evaluate(observations: WeatherObservation[]): Promise<RainEvent[]> {
  const affectedEvents: RainEvent[] = [];

  // Filter to observations with precipitation
  const rainyObs = observations.filter((obs) => obs.precipitationIn > 0);
  if (rainyObs.length === 0) return affectedEvents;

  for (const obs of rainyObs) {
    const trails = await getTrailsByStation(obs.stationId);

    for (const trail of trails) {
      const existing = await getActiveRainEvent(trail.id);

      if (existing) {
        // Extend the active rain event — add precipitation
        const result = await sql`
          UPDATE rain_events
          SET total_precipitation_in = total_precipitation_in + ${obs.precipitationIn}
          WHERE id = ${existing.id}
          RETURNING id, trail_id, start_timestamp, end_timestamp,
                    total_precipitation_in, is_active
        `;
        affectedEvents.push(mapRowToRainEvent(result.rows[0]));
      } else {
        // Create a new rain event
        const result = await sql`
          INSERT INTO rain_events (trail_id, start_timestamp, total_precipitation_in, is_active)
          VALUES (${trail.id}, ${obs.timestamp.toISOString()}, ${obs.precipitationIn}, true)
          RETURNING id, trail_id, start_timestamp, end_timestamp,
                    total_precipitation_in, is_active
        `;
        affectedEvents.push(mapRowToRainEvent(result.rows[0]));
      }

      // Only flip trail status once the rain event total reaches the threshold
      const event = affectedEvents[affectedEvents.length - 1];
      if (event.totalPrecipitationIn >= MIN_RAIN_THRESHOLD_IN) {
        await sql`
          UPDATE trails
          SET condition_status = 'Predicted Wet',
              updated_at = now()
          WHERE id = ${trail.id}
        `;
      }
    }
  }

  return affectedEvents;
}

/**
 * Check all active rain events and end those where 60+ minutes of zero
 * precipitation have elapsed since the last precipitation observation.
 *
 * For each active rain event:
 *  1. Look up the trail's primary station
 *  2. Find the most recent weather observation for that station
 *  3. Find the most recent observation with precipitation > 0 for that station
 *  4. If the gap between the latest observation and the last rainy observation
 *     is >= 60 minutes, end the rain event
 *
 * Returns the list of rain events that were ended.
 */
export async function checkForRainEnd(): Promise<RainEvent[]> {
  const endedEvents: RainEvent[] = [];

  // Get all active rain events with their trail's station ID
  const activeResult = await sql`
    SELECT re.id, re.trail_id, re.start_timestamp, re.end_timestamp,
           re.total_precipitation_in, re.is_active,
           t.primary_station_id
    FROM rain_events re
    JOIN trails t ON t.id = re.trail_id
    WHERE re.is_active = true
  `;

  for (const row of activeResult.rows) {
    const stationId = row.primary_station_id as string;

    // Get the latest weather observation for this trail
    const latestObsResult = await sql`
      SELECT timestamp FROM weather_observations
      WHERE trail_id = ${row.trail_id as string}
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    if (latestObsResult.rows.length === 0) continue;

    const latestObsTime = new Date(latestObsResult.rows[0].timestamp as string);

    // Get the most recent observation with precipitation > 0
    const lastRainResult = await sql`
      SELECT timestamp FROM weather_observations
      WHERE trail_id = ${row.trail_id as string}
        AND precipitation_in > 0
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    if (lastRainResult.rows.length === 0) {
      // No rainy observations at all — shouldn't normally happen for an active event,
      // but end it to be safe
      const ended = await endRainEvent(row.id as string, latestObsTime);
      endedEvents.push(ended);
      continue;
    }

    const lastRainTime = new Date(lastRainResult.rows[0].timestamp as string);
    const gapMinutes = (latestObsTime.getTime() - lastRainTime.getTime()) / (1000 * 60);

    if (gapMinutes >= 60) {
      const ended = await endRainEvent(row.id as string, latestObsTime);
      endedEvents.push(ended);
    }
  }

  return endedEvents;
}

/**
 * End a rain event: set is_active = false and record the end timestamp.
 */
async function endRainEvent(eventId: string, endTime: Date): Promise<RainEvent> {
  const result = await sql`
    UPDATE rain_events
    SET is_active = false,
        end_timestamp = ${endTime.toISOString()}
    WHERE id = ${eventId}
    RETURNING id, trail_id, start_timestamp, end_timestamp,
              total_precipitation_in, is_active
  `;
  return mapRowToRainEvent(result.rows[0]);
}
