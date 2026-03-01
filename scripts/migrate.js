/**
 * Database migration runner for Neon Postgres.
 * Reads SQL migration files from src/db/migrations/ and executes them in order.
 * Tracks applied migrations in a _migrations table to avoid re-running.
 *
 * Usage: node scripts/migrate.js
 * Requires DATABASE_URL (or POSTGRES_URL) environment variable.
 */

const { neon } = require("@neondatabase/serverless");
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");

async function run() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error("Error: DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  const sql = neon(connectionString);

  try {
    // Ensure the migrations tracking table exists
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    // Get already-applied migrations
    const applied = await sql`SELECT name FROM _migrations ORDER BY id`;
    const appliedSet = new Set(applied.map((r) => r.name));

    // Read migration files sorted alphabetically
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("No migration files found.");
      return;
    }

    let ranCount = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`Skipping (already applied): ${file}`);
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const migrationSql = fs.readFileSync(filePath, "utf-8");

      console.log(`Applying migration: ${file}`);
      // neon() tagged template can't run raw SQL strings, so use the query method
      await sql(migrationSql);
      await sql`INSERT INTO _migrations (name) VALUES (${file})`;
      console.log(`Applied: ${file}`);
      ranCount++;
    }

    if (ranCount === 0) {
      console.log("All migrations already applied.");
    } else {
      console.log(`Done. Applied ${ranCount} migration(s).`);
    }
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  }
}

run();
