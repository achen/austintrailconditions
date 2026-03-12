import { NextResponse } from 'next/server';
import { storePosts } from '@/services/post-collector';
import { classify } from '@/services/post-classifier';
import { listActive } from '@/services/trail-service';
import { applyVerifiedStatuses, expireStaleVerifications } from '@/services/trail-verifier';
import { sql } from '@/lib/db';
import { TrailReport } from '@/types';

interface IngestPost {
  postId: string;
  parentPostId?: string;
  authorName: string;
  postText: string;
  timestamp: string;
  isComment?: boolean;
}

/**
 * POST /api/scrape/ingest
 *
 * Receives scraped Facebook posts (already extracted to text by the scraper).
 * Stores, classifies, and applies trail status updates.
 */
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const rawPosts: IngestPost[] = body.posts;

    if (!Array.isArray(rawPosts) || rawPosts.length === 0) {
      return NextResponse.json({ error: 'No posts provided' }, { status: 400 });
    }

    const posts: TrailReport[] = rawPosts.map((p) => ({
      postId: p.postId,
      parentPostId: p.parentPostId || null,
      isComment: p.isComment || false,
      authorName: p.authorName || 'Unknown',
      postText: p.postText,
      timestamp: new Date(p.timestamp),
      trailReferences: [],
      classification: null,
      confidenceScore: null,
      flaggedForReview: false,
    }));

    const newPostIds = await storePosts(posts);

    let classified = 0;
    const allClassified: Array<{
      postId: string;
      text: string;
      classification: string;
      confidence: number;
      timestamp: string;
      trails: string[];
    }> = [];

    if (process.env.OPENAI_API_KEY) {
      const activeTrails = await listActive();
      const knownTrailNames = activeTrails.map((t) => t.name);

      // Classify new posts + any existing posts that need (re)classification
      const postIdsToClassify = new Set(
        posts.filter(p => newPostIds.has(p.postId)).map(p => p.postId)
      );

      // Also pick up existing unclassified posts from the last 48h
      const unclassifiedResult = await sql`
        SELECT post_id FROM trail_reports
        WHERE classification IS NULL
          AND timestamp > now() - interval '48 hours'
      `;
      for (const row of unclassifiedResult.rows) {
        postIdsToClassify.add(row.post_id as string);
      }

      // Build a lookup of posts we received in this batch
      const postsByIdFromBatch = new Map(posts.map(p => [p.postId, p]));

      for (const postId of Array.from(postIdsToClassify)) {
        // Use the batch version if available, otherwise load from DB
        let post = postsByIdFromBatch.get(postId);
        if (!post) {
          const dbRow = await sql`
            SELECT post_id, parent_post_id, author_name, post_text, timestamp,
                   trail_references, classification, confidence_score, flagged_for_review
            FROM trail_reports WHERE post_id = ${postId}
          `;
          if (dbRow.rows.length === 0) continue;
          const r = dbRow.rows[0];
          post = {
            postId: r.post_id as string,
            parentPostId: (r.parent_post_id as string) || null,
            authorName: r.author_name as string,
            postText: r.post_text as string,
            timestamp: new Date(r.timestamp as string),
            trailReferences: [],
            classification: null,
            confidenceScore: null,
            flaggedForReview: false,
          };
        }
        if (!post.postText || post.postText.length < 3) continue;
        try {
          const result = await classify(post, knownTrailNames);
          classified++;
          allClassified.push({
            postId: result.postId,
            text: post.postText.slice(0, 200),
            classification: result.classification,
            confidence: result.confidenceScore,
            timestamp: post.timestamp.toISOString(),
            trails: result.trailReferences,
          });
        } catch (err) {
          console.error(`Classification failed for ${postId}:`, err);
        }
      }
    }

    const verifications = await applyVerifiedStatuses();

    // Expire stale "Observed Wet" statuses
    await expireStaleVerifications();

    // Build a map of trail status changes from verifications
    const statusChanges: Record<string, string> = {};
    for (const v of verifications) {
      statusChanges[v.postId] = `${v.trailName} → ${v.newStatus}`;
    }

    return NextResponse.json({
      success: true,
      received: rawPosts.length,
      stored: newPostIds.size,
      classified,
      verified: verifications.length,
      allClassified: allClassified.length > 0 ? allClassified : undefined,
      statusChanges: Object.keys(statusChanges).length > 0 ? statusChanges : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Ingest failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
