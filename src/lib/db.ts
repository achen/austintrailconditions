import { neon } from '@neondatabase/serverless';

/**
 * Neon Postgres database client.
 *
 * `sql` — Tagged template for queries: sql`SELECT * FROM trails`
 * Returns { rows, rowCount, ... } via fullResults mode.
 *
 * Uses DATABASE_URL (or POSTGRES_URL as fallback) environment variable.
 */

function getConnectionString(): string {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      'Missing DATABASE_URL environment variable. Database connection cannot be established.'
    );
  }
  return url;
}

export const sql = neon(getConnectionString(), { fullResults: true });
