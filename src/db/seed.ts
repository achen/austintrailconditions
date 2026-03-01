import { getPool } from '../lib/db';
import { seedTrails } from './seed-trails';

/**
 * Seeds the database with the initial set of 30 Central Texas trails.
 * Uses ON CONFLICT DO NOTHING so it's safe to run on every deployment —
 * existing trails won't be overwritten.
 */
export async function seedDatabase(): Promise<number> {
  const pool = getPool();
  let inserted = 0;

  for (const trail of seedTrails) {
    const result = await pool.sql`
      INSERT INTO trails (name, primary_station_id, drying_rate_in_per_day, max_drying_days, updates_enabled)
      VALUES (${trail.name}, ${trail.primaryStationId}, ${trail.dryingRateInPerDay}, ${trail.maxDryingDays}, ${trail.updatesEnabled})
      ON CONFLICT (name) DO NOTHING
    `;
    if (result.rowCount && result.rowCount > 0) {
      inserted++;
    }
  }

  return inserted;
}

// Allow running directly: npx tsx src/db/seed.ts
if (require.main === module) {
  seedDatabase()
    .then((count) => {
      console.log(`Seeded ${count} new trails (${seedTrails.length} total configured).`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
