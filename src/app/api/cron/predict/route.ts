import { NextResponse } from 'next/server';
import { validateConfig } from '@/services/config-validator';
import { updatePredictions } from '@/services/prediction-engine';
import { expireStaleVerifications } from '@/services/trail-verifier';
import { notifyCronFailure } from '@/services/notification-service';

/**
 * GET /api/cron/predict
 *
 * Vercel Cron endpoint for prediction updates.
 * - Validates CRON_SECRET authorization
 * - Expires stale "Verified Not Rideable" statuses
 * - Updates predictions for all drying trails (Req 4.3, 4.4)
 *
 * Note: Verified status changes (Req 4.5, 4.6) are handled exclusively
 * by the trail verifier via Facebook post classification in the ingest
 * and facebook cron routes.
 *
 * Requirements: 4.1, 4.3, 4.4
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

    // 3. Expire stale "Verified Not Rideable" statuses
    const expired = await expireStaleVerifications();

    // 4. Update predictions for all drying trails (Req 4.3, 4.4)
    const updatedPredictions = await updatePredictions();

    // 5. Return summary response
    return NextResponse.json({
      success: true,
      expiredVerifications: expired.length > 0 ? expired : undefined,
      predictionsUpdated: updatedPredictions.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Prediction cron failed: ${message}`);
    await notifyCronFailure('predict', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
