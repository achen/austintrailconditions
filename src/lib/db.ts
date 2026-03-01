import { sql, createPool } from '@vercel/postgres';

/**
 * Vercel Postgres database client utilities.
 *
 * - `sql` — Tagged template for simple queries: sql`SELECT * FROM trails`
 * - `getPool()` — Returns a connection pool for transactional or batch work
 *
 * Both use the POSTGRES_URL environment variable automatically.
 */

let pool: ReturnType<typeof createPool> | null = null;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error(
        'Missing POSTGRES_URL environment variable. Database connection cannot be established.'
      );
    }
    pool = createPool({ connectionString });
  }
  return pool;
}

export { sql };
