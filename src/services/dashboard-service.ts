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
      p.remaining_moisture_in
    FROM trails t
    LEFT JOIN LATERAL (
      SELECT predicted_dry_time,
             COALESCE((input_data->>'remainingMoistureIn')::numeric, (input_data->>'totalPrecipitationIn')::numeric) AS remaining_moisture_in
      FROM predictions
      WHERE trail_id = t.id
      ORDER BY created_at DESC
      LIMIT 1
    ) p ON t.condition_status = 'Predicted Wet'
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

