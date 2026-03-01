import { NextResponse } from 'next/server';
import { validateConfig } from '@/services/config-validator';
import { fetchPosts, storePosts } from '@/services/post-collector';
import { classify } from '@/services/post-classifier';
import { listActive } from '@/services/trail-service';
import { sql } from '@/lib/db';
import { TrailReport } from '@/types';

/**
 * GET /api/cron/facebook
 *
 * Vercel Cron endpoint for Facebook post collection and classification.
 * - Validates CRON_SECRET authorization
 * - Fetches recent posts from the configured Facebook group
 * - Stores new posts (deduplicates by post_id)
 * - Classifies any unclassified posts using OpenAI
 * - Logs errors and flags admin notification on Facebook API failures
 *
 * Requirements: 2.1, 2.3, 2.5, 7.1
 */
export async function GET(request: Request) {
  // 1. Cron authorization check
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 2. Validate configuration
    const config = validateConfig();

    // 3. Fetch posts from Facebook (Req 2.1)
    let posts: TrailReport[];
    try {
      posts = await fetchPosts(config.facebook.groupId, config.facebook.accessToken);
    } catch (err) {
      // Log error and flag admin notification on Facebook API failure (Req 2.3)
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Facebook API failure: ${message}`);
      return NextResponse.json(
        { error: 'Facebook API failure', details: message, adminNotification: true },
        { status: 502 }
      );
    }

    // 4. Store new posts (Req 2.2, 2.4 — deduplication via ON CONFLICT)
    const stored = await storePosts(posts);

    // 5. Query unclassified posts (classification IS NULL) (Req 7.1)
    const unclassifiedResult = await sql`
      SELECT post_id, author_name, post_text, timestamp,
             trail_references, classification, confidence_score, flagged_for_review
      FROM trail_reports
      WHERE classification IS NULL
      ORDER BY timestamp DESC
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

    // 6. Get known trail names for classification (Req 7.2)
    const activeTrails = await listActive();
    const knownTrailNames = activeTrails.map((t) => t.name);

    // 7. Classify each unclassified post (Req 7.1)
    const classificationResults = [];
    const classificationErrors: string[] = [];

    for (const post of unclassifiedPosts) {
      try {
        const result = await classify(post, knownTrailNames);
        classificationResults.push(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Classification failed for post ${post.postId}: ${message}`);
        classificationErrors.push(`${post.postId}: ${message}`);
      }
    }

    // 8. Return summary response
    return NextResponse.json({
      success: true,
      postsFetched: posts.length,
      postsStored: stored,
      postsClassified: classificationResults.length,
      classificationErrors: classificationErrors.length > 0 ? classificationErrors : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Facebook cron failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
