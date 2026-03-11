import { unstable_noStore as noStore } from 'next/cache';
import { sql } from '@/lib/db';
import type { ConditionStatus } from '@/types';

export interface DashboardTrail {
  id: string;
  name: string;
  condition_status: ConditionStatus;
  updated_at: string;
  predicted_dry_time: string | null;
  remaining_moisture_in: number | null;
  has_active_rain: boolean;
  active_rain_in: number | null;
  total_rain_in: number | null;
  max_absorbable_in: number;
}

/**
 * Fetch all non-archived trails with their current condition status and,
 * for drying trails, the most recent predicted dry time.
 */
export async function getTrailsWithConditions(): Promise<DashboardTrail[]> {
  noStore();
  const { rows } = await sql`
    SELECT
      t.id,
      t.name,
      t.condition_status,
      t.updated_at,
      p.predicted_dry_time,
      p.remaining_moisture_in,
      EXISTS (
        SELECT 1 FROM rain_events
        WHERE trail_id = t.id AND is_active = true
          AND total_precipitation_in >= 0.1
      ) AS has_active_rain,
      LEAST(rain.raw_rain_in, CASE WHEN t.drying_rate_in_per_day > 0 THEN t.drying_rate_in_per_day ELSE 0.86 END) AS active_rain_in,
      rain.raw_rain_in AS total_rain_in,
      CASE WHEN t.drying_rate_in_per_day > 0 THEN t.drying_rate_in_per_day ELSE 0.86 END AS max_absorbable_in
    FROM trails t
    LEFT JOIN LATERAL (
      SELECT predicted_dry_time,
             COALESCE((input_data->>'remainingMoistureIn')::numeric, (input_data->>'totalPrecipitationIn')::numeric) AS remaining_moisture_in
      FROM predictions
      WHERE trail_id = t.id
      ORDER BY created_at DESC
      LIMIT 1
    ) p ON t.condition_status = 'Predicted Wet'
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(re.total_precipitation_in), 0) AS raw_rain_in
      FROM rain_events re
      WHERE re.trail_id = t.id
        AND re.total_precipitation_in >= 0.1
        AND (re.is_active = true
             OR re.end_timestamp >= now() - interval '48 hours')
        AND re.start_timestamp > COALESCE(
          (SELECT MAX(tv.created_at) FROM trail_verifications tv
           WHERE tv.trail_id = t.id AND tv.classification = 'dry'),
          '1970-01-01'::timestamptz
        )
    ) rain ON true
    WHERE t.is_archived = false
    ORDER BY t.name ASC
  `;
  return rows as DashboardTrail[];
}

/**
 * Calculate prediction accuracy for the last 10 rain events.
 * A prediction is "accurate" if |predicted_dry_time - actual_dry_time| <= 2 hours.
 * Returns null if no predictions have actual outcomes.
 */
export async function getPredictionAccuracy(): Promise<{ accurate: number; total: number } | null> {
  const { rows } = await sql`
    SELECT predicted_dry_time, actual_dry_time
    FROM predictions
    WHERE predicted_dry_time IS NOT NULL
      AND actual_dry_time IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 10
  `;
  if (rows.length === 0) return null;
  const accurate = rows.filter((r) => {
    const diff = Math.abs(
      new Date(r.predicted_dry_time).getTime() - new Date(r.actual_dry_time).getTime()
    );
    return diff <= 2 * 60 * 60 * 1000; // 2 hours in ms
  }).length;
  return { accurate, total: rows.length };
}

