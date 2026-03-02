import { NextResponse } from 'next/server';
import { fetchGroupPosts } from '@/services/facebook-scraper';
import { storePosts } from '@/services/post-collector';
import { classify } from '@/services/post-classifier';
import { listActive } from '@/services/trail-service';
import { applyVerifiedStatuses } from '@/services/trail-verifier';
import { sql } from '@/lib/db';
import { notifyCronFailure } from '@/services/notification-service';
import { TrailReport } from '@/types';

/**
 * GET /api/cron/facebook
 *
 * Vercel Cron endpoint for Facebook post collection and classification.
 * - Only runs during daytime (6am–8pm CT)
 * - Only scrapes when trails are actively drying (not when all are dry or all are soaked)
 * - Adds random jitter (0–10 min) to avoid predictable request patterns
 * - Scrapes mbasic.facebook.com directly with cookie auth (no Apify)
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 1. Check if any trails are actively drying — skip if all dry or no rain events
    const dryingTrails = await sql`
      SELECT COUNT(*) as count FROM trails t
      JOIN rain_events re ON re.trail_id = t.id
      WHERE t.is_archived = false
        AND re.is_active = false
        AND re.end_timestamp > now() - interval '7 days'
        AND t.condition_status IN ('Probably Not Rideable', 'Probably Rideable')
    `;
    const dryingCount = parseInt(dryingTrails.rows[0]?.count as string) || 0;

    if (dryingCount === 0) {
      return NextResponse.json({
        skipped: true,
        reason: 'No trails actively drying — Facebook scrape not needed',
      });
    }

    // 2. Check if automated Facebook scraping is enabled
    // Disabled by default — use the browser extension instead to avoid account locks.
    // Set FACEBOOK_SCRAPER_ENABLED=true in env to enable Apify-based scraping.
    if (process.env.FACEBOOK_SCRAPER_ENABLED !== 'true') {
      return NextResponse.json({
        skipped: true,
        reason: 'Automated Facebook scraping disabled. Use the browser extension to submit posts.',
      });
    }

    // 3. Random jitter: wait 0–10 minutes to vary request timing
    const jitterMs = Math.floor(Math.random() * 10 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, Math.min(jitterMs, 30_000)));
    // Cap at 30s in practice (Vercel functions have a timeout)

    // 3. Scrape Facebook group posts
    const posts = await fetchGroupPosts(25);

    if (posts.length === 0) {
      return NextResponse.json({
        success: true,
        postsFetched: 0,
        postsStored: 0,
        postsClassified: 0,
        note: 'No posts returned — cookies may be expired or group page empty',
      });
    }

    // 4. Store new posts (deduplicates via ON CONFLICT)
    const stored = await storePosts(posts);

    // 5. Classify unclassified posts
    const unclassifiedResult = await sql`
      SELECT post_id, author_name, post_text, timestamp,
             trail_references, classification, confidence_score, flagged_for_review
      FROM trail_reports
      WHERE classification IS NULL
      ORDER BY timestamp DESC
      LIMIT 50
    `;

    const unclassifiedPosts: TrailReport[] = unclassifiedResult.rows.map(
      (row: Record<string, unknown>) => ({
        postId: row.post_id as string,
        authorName: row.author_name as string,
        postText: row.post_text as string,
        timestamp: new Date(row.timestamp as string),
        trailReferences: (row.trail_references as string[]) ?? [],
        classification: null,
        confidenceScore: null,
        flaggedForReview: row.flagged_for_review as boolean,
      })
    );

    const activeTrails = await listActive();
    const knownTrailNames = activeTrails.map((t) => t.name);

    let classified = 0;
    const classificationErrors: string[] = [];

    // Only classify if OpenAI key is available
    if (process.env.OPENAI_API_KEY) {
      for (const post of unclassifiedPosts) {
        try {
          await classify(post, knownTrailNames);
          classified++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          classificationErrors.push(`${post.postId}: ${msg}`);
        }
      }
    }

    // 6. Apply verified statuses based on classified posts
    const verifications = await applyVerifiedStatuses();

    return NextResponse.json({
      success: true,
      dryingTrails: dryingCount,
      postsFetched: posts.length,
      postsStored: stored.size,
      postsClassified: classified,
      trailsVerified: verifications.length > 0 ? verifications : undefined,
      classificationErrors: classificationErrors.length > 0 ? classificationErrors : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Facebook cron failed: ${message}`);
    await notifyCronFailure('facebook', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
