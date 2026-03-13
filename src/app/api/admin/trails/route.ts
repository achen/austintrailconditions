import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * GET /api/admin/trails — all trails with rain event data and drying config
 */
export async function GET() {
  const { rows } = await sql`
    SELECT
      t.id,
      t.name,
      t.condition_status,
      t.drying_rate_in_per_day AS max_absorbable_in,
      t.max_drying_days,
      t.updates_enabled,
      t.primary_station_id,
      t.updated_at,
      COALESCE(active_rain.total, 0) AS active_rain_in,
      active_rain.start_timestamp AS rain_start,
      COALESCE(recent_rain.total, 0) AS recent_rain_total,
      recent_rain.event_count AS recent_event_count,
      p.remaining_moisture_in,
      p.predicted_dry_time,
      p.dried_so_far
    FROM trails t
    LEFT JOIN LATERAL (
      SELECT
        SUM(total_precipitation_in) AS total,
        MIN(start_timestamp) AS start_timestamp
      FROM rain_events
      WHERE trail_id = t.id AND is_active = true
    ) active_rain ON true
    LEFT JOIN LATERAL (
      SELECT
        SUM(total_precipitation_in) AS total,
        COUNT(*) AS event_count
      FROM rain_events
      WHERE trail_id = t.id
        AND total_precipitation_in >= 0.1
        AND (is_active = true OR end_timestamp >= now() - interval '7 days')
    ) recent_rain ON true
    LEFT JOIN LATERAL (
      SELECT
        COALESCE((input_data->>'remainingMoistureIn')::numeric, 0) AS remaining_moisture_in,
        predicted_dry_time,
        COALESCE((input_data->>'totalPrecipitationIn')::numeric, 0)
          - COALESCE((input_data->>'remainingMoistureIn')::numeric, 0) AS dried_so_far
      FROM predictions
      WHERE trail_id = t.id
      ORDER BY created_at DESC
      LIMIT 1
    ) p ON true
    WHERE t.is_archived = false
    ORDER BY t.name ASC
  `;

  return NextResponse.json(rows);
}
