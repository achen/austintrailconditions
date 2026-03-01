import { NextResponse } from 'next/server';
import { validateConfig } from '@/services/config-validator';
import { updatePredictions, recordActualOutcome } from '@/services/prediction-engine';
import { listActive } from '@/services/trail-service';
import { notifyCronFailure } from '@/services/notification-service';
import { sql } from '@/lib/db';

/**
 * GET /api/cron/predict
 *
 * Vercel Cron endpoint for prediction updates and report processing.
 * - Validates CRON_SECRET authorization
 * - Updates predictions for all drying trails (Req 4.3)
 * - Processes classified "dry" reports to transition trails to "Verified Rideable" (Req 4.5)
 * - Processes classified "wet" reports to transition trails to "Verified Not Rideable" (Req 4.6)
 *
 * Requirements: 4.1, 4.3, 4.4, 4.5, 4.6
 */
export async function GET(request: Request) {
  // 1. Cron authorization check
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 2. Validate configuration
    validateConfig();

    // 3. Update predictions for all drying trails (Req 4.3, 4.4)
    const updatedPredictions = await updatePredictions();

    // 4. Get active trails for name matching
    const activeTrails = await listActive();
    const trailsByName = new Map(activeTrails.map((t) => [t.name.toLowerCase(), t]));

    // 5. Query classified reports that haven't been processed yet
    //    A report is "unprocessed" if it has a classification but hasn't been acted on.
    //    We track this by checking for reports with classification in ('dry', 'wet')
    //    that were created since the last prediction cron run, or use a processed flag approach.
    //    Since there's no processed column, we use a pragmatic approach: process reports
    //    from the last hour that have a classification and trail references.
    const reportsResult = await sql`
      SELECT id, post_id, author_name, post_text, timestamp,
             trail_references, classification, confidence_score, flagged_for_review
      FROM trail_reports
      WHERE classification IN ('dry', 'wet')
        AND flagged_for_review = false
        AND confidence_score >= 0.6
        AND timestamp > now() - INTERVAL '1 hour'
      ORDER BY timestamp DESC
    `;

    let dryReportsProcessed = 0;
    let wetReportsProcessed = 0;
    const errors: string[] = [];

    for (const row of reportsResult.rows) {
      const classification = row.classification as string;
      const trailRefs = (row.trail_references as string[]) ?? [];

      for (const trailRef of trailRefs) {
        const trail = trailsByName.get(trailRef.toLowerCase());
        if (!trail) continue;

        try {
          if (classification === 'dry') {
            // Only transition trails in drying states (Req 4.5)
            if (
              trail.conditionStatus === 'Probably Not Rideable' ||
              trail.conditionStatus === 'Probably Rideable'
            ) {
              // Set trail status to "Verified Rideable"
              await sql`
                UPDATE trails
                SET condition_status = 'Verified Rideable',
                    updated_at = now()
                WHERE id = ${trail.id}
              `;

              // Record actual outcome on the most recent prediction (Req 10.1)
              const latestRainResult = await sql`
                SELECT id FROM rain_events
                WHERE trail_id = ${trail.id} AND is_active = false
                ORDER BY end_timestamp DESC
                LIMIT 1
              `;

              if (latestRainResult.rows.length > 0) {
                await recordActualOutcome(
                  trail.id,
                  latestRainResult.rows[0].id as string,
                  new Date(row.timestamp as string)
                );
              }

              dryReportsProcessed++;
            }
          } else if (classification === 'wet') {
            // Set trail status to "Verified Not Rideable" (Req 4.6)
            await sql`
              UPDATE trails
              SET condition_status = 'Verified Not Rideable',
                  updated_at = now()
              WHERE id = ${trail.id}
            `;

            wetReportsProcessed++;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error processing report ${row.post_id} for trail ${trail.name}: ${message}`);
          errors.push(`${row.post_id}/${trail.name}: ${message}`);
        }
      }
    }

    // 6. Return summary response
    return NextResponse.json({
      success: true,
      predictionsUpdated: updatedPredictions.length,
      reportsProcessed: reportsResult.rows.length,
      dryReportsProcessed,
      wetReportsProcessed,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Prediction cron failed: ${message}`);
    await notifyCronFailure('predict', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
