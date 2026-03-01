/**
 * Database migration runner for Vercel Postgres.
 * Reads SQL migration files from src/db/migrations/ and executes them in order.
 * Tracks applied migrations in a _migrations table to avoid re-running.
 *
 * Usage: node scripts/migrate.js
 * Requires POSTGRES_URL environment variable.
 */

const { createPool } = require("@vercel/postgres");
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");

async function run() {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error("Error: POSTGRES_URL environment variable is not set.");
    process.exit(1);
  }

  const pool = createPool({ connectionString });

  try {
    // Ensure the migrations tracking table exists
    await pool.sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    // Get already-applied migrations
    const { rows: applied } = await pool.sql`
      SELECT name FROM _migrations ORDER BY id
    `;
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
      const sql = fs.readFileSync(filePath, "utf-8");

      console.log(`Applying migration: ${file}`);
      await pool.query(sql);
      await pool.sql`INSERT INTO _migrations (name) VALUES (${file})`;
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
  } finally {
    await pool.end();
  }
}

run();
