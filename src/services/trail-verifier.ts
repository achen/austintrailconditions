import { sql } from '@/lib/db';
import { recordActualOutcome } from '@/services/prediction-engine';
import { storeDryingConditions } from '@/services/drying-model';

const CONFIDENCE_THRESHOLD = 0.7;

interface VerificationResult {
  trailName: string;
  trailId: string;
  newStatus: string;
  postId: string;
  classification: string;
  confidence: number;
}

/**
 * Apply verified trail status updates based on classified Facebook posts.
 *
 * When someone reports a trail as dry or wet with high confidence:
 * - dry → "Verified Rideable"
 * - wet → "Verified Not Rideable"
 *
 * Only updates trails that have updates_enabled = true.
 * Also records actual dry time for prediction accuracy tracking.
 */
export async function applyVerifiedStatuses(): Promise<VerificationResult[]> {
  // Get recently classified posts (last 24h) that reference specific trails
  // and haven't been applied yet.
  // ORDER BY timestamp ASC so we process oldest first — if someone says "dry"
  // then later says "wet", the later post wins (overwrites the earlier one).
  const reportsResult = await sql`
    SELECT tr.post_id, tr.classification, tr.confidence_score,
           tr.trail_references, tr.timestamp
    FROM trail_reports tr
    WHERE tr.classification IN ('dry', 'wet')
      AND tr.confidence_score >= ${CONFIDENCE_THRESHOLD}
      AND tr.timestamp > now() - interval '24 hours'
      AND tr.trail_references IS NOT NULL
      AND array_length(tr.trail_references, 1) > 0
      AND NOT EXISTS (
        SELECT 1 FROM trail_verifications tv
        WHERE tv.post_id = tr.post_id
      )
    ORDER BY tr.timestamp ASC
  `;

  const results: VerificationResult[] = [];

  for (const row of reportsResult.rows) {
    const postId = row.post_id as string;
    const classification = row.classification as string;
    const confidence = Number(row.confidence_score);
    const trailNames = row.trail_references as string[];
    const postTimestamp = new Date(row.timestamp as string);

    const newStatus = classification === 'dry'
      ? 'Verified Rideable'
      : 'Verified Not Rideable';

    for (const trailName of trailNames) {
      // Find the trail by name
      const trailResult = await sql`
        SELECT id, name, condition_status, updates_enabled
        FROM trails
        WHERE name = ${trailName}
          AND is_archived = false
          AND updates_enabled = true
      `;

      if (trailResult.rows.length === 0) continue;

      const trail = trailResult.rows[0];
      const trailId = trail.id as string;
      const currentStatus = trail.condition_status as string;

      // Skip if status is already the same
      if (currentStatus === newStatus) continue;

      // Guard against stale "wet" reports: if there's been no rain in the
      // last 7 days for this trail, a "wet" classification is almost certainly
      // from an outdated post (e.g. extension scraped an old post with a
      // fallback timestamp of "now"). Skip it.
      if (classification === 'wet') {
        const recentRain = await sql`
          SELECT 1 FROM rain_events
          WHERE trail_id = ${trailId}
            AND (is_active = true OR end_timestamp > now() - interval '7 days')
          LIMIT 1
        `;
        if (recentRain.rows.length === 0) {
          console.log(
            `Skipping stale "wet" report for "${trail.name as string}" (post ${postId}) — no rain in last 7 days`
          );
          continue;
        }
      }

      // Update trail status
      await sql`
        UPDATE trails
        SET condition_status = ${newStatus}, updated_at = now()
        WHERE id = ${trailId}
      `;

      // Record the verification so we don't apply it again
      await sql`
        INSERT INTO trail_verifications (post_id, trail_id, classification, confidence_score, new_status)
        VALUES (${postId}, ${trailId}, ${classification}, ${confidence}, ${newStatus})
      `;

      // If trail was marked dry, record actual outcome for prediction accuracy
      if (classification === 'dry') {
        const recentRainEvent = await sql`
          SELECT id FROM rain_events
          WHERE trail_id = ${trailId} AND is_active = false
          ORDER BY end_timestamp DESC
          LIMIT 1
        `;
        if (recentRainEvent.rows.length > 0) {
          const rainEventId = recentRainEvent.rows[0].id as string;
          await recordActualOutcome(trailId, rainEventId, postTimestamp);
          // Store weather features for ML training
          try {
            await storeDryingConditions(trailId, rainEventId, postTimestamp);
          } catch (err) {
            console.error('Failed to store drying conditions:', err);
          }
        }
      }

      results.push({
        trailName: trail.name as string,
        trailId,
        newStatus,
        postId,
        classification,
        confidence,
      });

      console.log(
        `Trail "${trail.name as string}" → ${newStatus} (from post ${postId}, confidence ${confidence})`
      );
    }
  }

  return results;
}
