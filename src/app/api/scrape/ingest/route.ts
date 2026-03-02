import { NextResponse } from 'next/server';
import { storePosts } from '@/services/post-collector';
import { classify } from '@/services/post-classifier';
import { listActive } from '@/services/trail-service';
import { applyVerifiedStatuses } from '@/services/trail-verifier';
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
    const unmatchedPosts: Array<{ postId: string; text: string; classification: string }> = [];

    if (process.env.OPENAI_API_KEY) {
      const activeTrails = await listActive();
      const knownTrailNames = activeTrails.map((t) => t.name);

      for (const post of posts) {
        if (!newPostIds.has(post.postId)) continue; // Skip already-stored posts
        if (!post.postText || post.postText.length < 3) continue;
        try {
          const result = await classify(post, knownTrailNames);
          classified++;
          if (
            (result.classification === 'dry' || result.classification === 'wet') &&
            result.trailReferences.length === 0
          ) {
            unmatchedPosts.push({
              postId: result.postId,
              text: post.postText.slice(0, 200),
              classification: result.classification,
            });
          }
        } catch (err) {
          console.error(`Classification failed for ${post.postId}:`, err);
        }
      }
    }

    const verifications = await applyVerifiedStatuses();

    return NextResponse.json({
      success: true,
      received: rawPosts.length,
      stored: newPostIds.size,
      classified,
      verified: verifications.length,
      unmatchedPosts: unmatchedPosts.length > 0 ? unmatchedPosts : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Ingest failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
