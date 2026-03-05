import { Trail, SeedTrail } from '@/types';
import { sql } from '@/lib/db';

/**
 * Map a database row to a Trail object.
 */
function rowToTrail(row: Record<string, unknown>): Trail {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    primaryStationId: row.primary_station_id as string,
    dryingRateInPerDay: Number(row.drying_rate_in_per_day),
    maxDryingDays: Number(row.max_drying_days),
    updatesEnabled: row.updates_enabled as boolean,
    isArchived: row.is_archived as boolean,
    conditionStatus: row.condition_status as Trail['conditionStatus'],
    aliases: (row.aliases as string[]) ?? [],
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/**
 * Create a new trail with default condition_status "Predicted Rideable".
 */
export async function create(data: {
  name: string;
  primaryStationId: string;
  dryingRateInPerDay: number;
  maxDryingDays: number;
  description?: string;
}): Promise<Trail> {
  const result = await sql`
    INSERT INTO trails (name, description, primary_station_id, drying_rate_in_per_day, max_drying_days)
    VALUES (
      ${data.name},
      ${data.description ?? null},
      ${data.primaryStationId},
      ${data.dryingRateInPerDay},
      ${data.maxDryingDays}
    )
    RETURNING *
  `;
  return rowToTrail(result.rows[0]);
}

/**
 * Update specified fields on an existing trail.
 * Only fields present in `data` are updated; absent fields are left unchanged.
 */
export async function update(
  id: string,
  data: Partial<Pick<Trail, 'name' | 'description' | 'primaryStationId' | 'dryingRateInPerDay' | 'maxDryingDays' | 'updatesEnabled'>>
): Promise<Trail> {
  // Build SET clauses only for fields that were explicitly provided
  const hasName = 'name' in data;
  const hasDescription = 'description' in data;
  const hasStation = 'primaryStationId' in data;
  const hasRate = 'dryingRateInPerDay' in data;
  const hasMaxDays = 'maxDryingDays' in data;
  const hasUpdates = 'updatesEnabled' in data;

  const result = await sql`
    UPDATE trails
    SET
      name = CASE WHEN ${hasName} THEN ${data.name ?? null} ELSE name END,
      description = CASE WHEN ${hasDescription} THEN ${data.description ?? null} ELSE description END,
      primary_station_id = CASE WHEN ${hasStation} THEN ${data.primaryStationId ?? null} ELSE primary_station_id END,
      drying_rate_in_per_day = CASE WHEN ${hasRate} THEN ${data.dryingRateInPerDay ?? null} ELSE drying_rate_in_per_day END,
      max_drying_days = CASE WHEN ${hasMaxDays} THEN ${data.maxDryingDays ?? null} ELSE max_drying_days END,
      updates_enabled = CASE WHEN ${hasUpdates} THEN ${data.updatesEnabled ?? null} ELSE updates_enabled END,
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;

  if (result.rows.length === 0) {
    throw new Error(`Trail not found: ${id}`);
  }

  return rowToTrail(result.rows[0]);
}

/**
 * Archive a trail by setting is_archived = true.
 * Retains all associated data (rain events, predictions, reports).
 */
export async function archive(id: string): Promise<Trail> {
  const result = await sql`
    UPDATE trails
    SET is_archived = true, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;

  if (result.rows.length === 0) {
    throw new Error(`Trail not found: ${id}`);
  }

  return rowToTrail(result.rows[0]);
}

/**
 * List all active (non-archived) trails.
 */
export async function listActive(): Promise<Trail[]> {
  const result = await sql`
    SELECT * FROM trails
    WHERE is_archived = false
    ORDER BY name ASC
  `;
  return result.rows.map(rowToTrail);
}

/**
 * Seed trails using ON CONFLICT (name) DO NOTHING for idempotent seeding.
 */
export async function seed(trails: SeedTrail[]): Promise<void> {
  for (const trail of trails) {
    await sql`
      INSERT INTO trails (name, primary_station_id, drying_rate_in_per_day, max_drying_days, updates_enabled)
      VALUES (
        ${trail.name},
        ${trail.primaryStationId},
        ${trail.dryingRateInPerDay},
        ${trail.maxDryingDays},
        ${trail.updatesEnabled}
      )
      ON CONFLICT (name) DO NOTHING
    `;
  }
}
