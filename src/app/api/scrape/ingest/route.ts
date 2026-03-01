import { NextResponse } from 'next/server';
import { storePosts } from '@/services/post-collector';
import { classify } from '@/services/post-classifier';
import { listActive } from '@/services/trail-service';
import { applyVerifiedStatuses } from '@/services/trail-verifier';
import { TrailReport } from '@/types';

interface IngestPost {
  postId: string;
  authorName: string;
  postText: string;
  timestamp: string;
}

/**
 * POST /api/scrape/ingest
 *
 * Receives scraped Facebook posts from the browser extension.
 * Stores, classifies, and applies trail status updates.
 */
export async function POST(request: Request) {
  // Auth check
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

    // Convert to TrailReport format
    const posts: TrailReport[] = rawPosts.map((p) => ({
      postId: p.postId,
      authorName: p.authorName || 'Unknown',
      postText: p.postText,
      timestamp: new Date(p.timestamp),
      trailReferences: [],
      classification: null,
      confidenceScore: null,
      flaggedForReview: false,
    }));

    // Store (deduplicates via ON CONFLICT)
    const stored = await storePosts(posts);

    // Classify if OpenAI is configured
    let classified = 0;
    if (process.env.OPENAI_API_KEY) {
      const activeTrails = await listActive();
      const knownTrailNames = activeTrails.map((t) => t.name);

      for (const post of posts) {
        try {
          await classify(post, knownTrailNames);
          classified++;
        } catch (err) {
          console.error(`Classification failed for ${post.postId}:`, err);
        }
      }
    }

    // Apply verified statuses
    const verifications = await applyVerifiedStatuses();

    return NextResponse.json({
      success: true,
      received: rawPosts.length,
      stored,
      classified,
      verified: verifications.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Ingest failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
