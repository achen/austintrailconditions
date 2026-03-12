#!/usr/bin/env node

/**
 * Reset recent post classifications so they get re-processed by the AI.
 * Also undoes any trail verifications that came from those posts.
 *
 * Usage: source .env.local && node scripts/reclassify-posts.js [hours=24]
 */

const { neon } = require("@neondatabase/serverless");

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!dbUrl) {
  console.error("DATABASE_URL not set. Run: source .env.local && node scripts/reclassify-posts.js");
  process.exit(1);
}

const sql = neon(dbUrl);

async function main() {
  const hours = parseInt(process.argv[2]) || 24;
  console.log(`Resetting classifications from the last ${hours} hours...`);

  // 1. Find posts that were classified in the window
  const posts = await sql`
    SELECT post_id, classification, trail_references, confidence_score
    FROM trail_reports
    WHERE classification IS NOT NULL
      AND timestamp > now() - make_interval(hours => ${hours})
    ORDER BY timestamp DESC
  `;
  console.log(`Found ${posts.length} classified posts to reset`);

  if (posts.length === 0) {
    console.log("Nothing to do");
    process.exit(0);
  }

  const postIds = posts.map(r => r.post_id);

  // 2. Delete trail verifications from these posts
  const deleted = await sql`
    DELETE FROM trail_verifications
    WHERE post_id = ANY(${postIds})
    RETURNING post_id, trail_id, new_status
  `;
  console.log(`Deleted ${deleted.length} trail verifications`);

  // 3. Null out classification so they get re-processed
  const reset = await sql`
    UPDATE trail_reports
    SET classification = NULL,
        confidence_score = NULL,
        trail_references = '{}',
        flagged_for_review = false
    WHERE post_id = ANY(${postIds})
  `;
  console.log(`Reset ${posts.length} post classifications`);

  // 4. Show what was reset
  for (const row of posts) {
    const trails = (row.trail_references || []).join(", ") || "(none)";
    console.log(`  ${row.post_id}: ${row.classification} -> ${trails}`);
  }

  console.log("\nDone. Trigger the Facebook cron to reclassify.");
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
