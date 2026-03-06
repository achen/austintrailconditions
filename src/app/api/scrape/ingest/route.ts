import { NextResponse } from 'next/server';
import { storePosts } from '@/services/post-collector';
import { classify } from '@/services/post-classifier';
import { listActive } from '@/services/trail-service';
import { applyVerifiedStatuses, expireStaleVerifications } from '@/services/trail-verifier';
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

      for (const post of posts) {
        if (!newPostIds.has(post.postId)) continue; // Skip already-stored posts
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
          console.error(`Classification failed for ${post.postId}:`, err);
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
