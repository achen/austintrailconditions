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
 * - dry → "Observed Dry"
 * - wet → "Observed Wet"
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
      ? 'Observed Dry'
      : 'Observed Wet';

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

      // Guard against stale "wet" reports: if there's been no rain within
      // this trail's max drying window, a "wet" classification is almost
      // certainly from an outdated post. Skip it.
      // If rain IS recent but drying took longer than max_drying_days,
      // adjust max_drying_days upward to match reality.
      if (classification === 'wet') {
        const trailConfig = await sql`
          SELECT max_drying_days FROM trails WHERE id = ${trailId}
        `;
        const maxDays = Number(trailConfig.rows[0]?.max_drying_days ?? 7);
        const recentRain = await sql`
          SELECT end_timestamp FROM rain_events
          WHERE trail_id = ${trailId}
            AND is_active = false
            AND end_timestamp IS NOT NULL
          ORDER BY end_timestamp DESC
          LIMIT 1
        `;
        const activeRain = await sql`
          SELECT 1 FROM rain_events
          WHERE trail_id = ${trailId} AND is_active = true
          LIMIT 1
        `;

        if (activeRain.rows.length === 0 && recentRain.rows.length > 0) {
          const rainEndTime = new Date(recentRain.rows[0].end_timestamp as string);
          const daysSinceRainEnd = (postTimestamp.getTime() - rainEndTime.getTime()) / (1000 * 60 * 60 * 24);

          if (daysSinceRainEnd > maxDays) {
            // Trail is still wet beyond max_drying_days — bump it up
            const newMaxDays = Math.ceil(daysSinceRainEnd);
            await sql`
              UPDATE trails
              SET max_drying_days = ${newMaxDays}, updated_at = now()
              WHERE id = ${trailId}
            `;
            console.log(
              `Adjusted max_drying_days for "${trail.name as string}": ${maxDays} → ${newMaxDays} (wet report ${Math.round(daysSinceRainEnd)}d after rain)`
            );
          }
        } else if (activeRain.rows.length === 0) {
          // No rain at all — stale report
          console.log(
            `Skipping stale "wet" report for "${trail.name as string}" (post ${postId}) — no rain events found`
          );
          continue;
        }
        // If rain is active, the wet report makes sense — proceed normally
      }

      // Update trail status
      await sql`
        UPDATE trails
        SET condition_status = ${newStatus}, updated_at = now()
        WHERE id = ${trailId}
      `;

      // If marked dry, close out all active rain events — the trail is confirmed dry
      // so prior rain shouldn't compound into future predictions
      if (classification === 'dry') {
        await sql`
          UPDATE rain_events
          SET is_active = false,
              end_timestamp = COALESCE(end_timestamp, ${postTimestamp.toISOString()})
          WHERE trail_id = ${trailId} AND is_active = true
        `;
      }

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
/**
 * Expire stale "Observed Wet" statuses.
 *
 * If a trail is marked "Observed Wet" but there's been no rain
 * within its max_drying_days window, the verification is stale.
 * Transition it to "Predicted Dry" so the dashboard reflects reality.
 */
export async function expireStaleVerifications(): Promise<string[]> {
  const result = await sql`
    UPDATE trails
    SET condition_status = 'Predicted Dry', updated_at = now()
    WHERE condition_status = 'Observed Wet'
      AND is_archived = false
      AND NOT EXISTS (
        SELECT 1 FROM rain_events
        WHERE trail_id = trails.id
          AND (is_active = true
               OR end_timestamp > now() - (trails.max_drying_days || ' days')::interval)
      )
    RETURNING name
  `;

  const expired = result.rows.map(r => r.name as string);
  if (expired.length > 0) {
    console.log(`Expired stale "Observed Wet" for: ${expired.join(', ')}`);
  }
  return expired;
}
