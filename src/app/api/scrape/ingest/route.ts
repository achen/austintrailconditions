import { NextResponse } from 'next/server';
import { storePosts } from '@/services/post-collector';
import { classify } from '@/services/post-classifier';
import { listActive } from '@/services/trail-service';
import { applyVerifiedStatuses } from '@/services/trail-verifier';
import { extractFromHtml } from '@/services/html-extractor';
import { TrailReport } from '@/types';

interface IngestPost {
  postId: string;
  postHtml?: string;   // new: raw HTML for AI extraction
  postText?: string;    // legacy: pre-extracted text
  authorName?: string;
  timestamp: string;
}

/**
 * POST /api/scrape/ingest
 *
 * Receives scraped Facebook posts from the scraper.
 * If posts contain postHtml, uses AI to extract text + comments.
 * Then stores, classifies, and applies trail status updates.
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

    let posts: TrailReport[] = [];
    let extractedCount = 0;

    // Check if posts have HTML (new format) or text (legacy format)
    const hasHtml = rawPosts.some(p => p.postHtml);

    if (hasHtml && process.env.OPENAI_API_KEY) {
      // AI extraction from HTML
      const htmlPosts = rawPosts
        .filter(p => p.postHtml)
        .map(p => ({ postId: p.postId, postHtml: p.postHtml!, timestamp: p.timestamp }));

      const extracted = await extractFromHtml(htmlPosts);
      extractedCount = extracted.length;

      for (const ex of extracted) {
        // Main post
        posts.push({
          postId: ex.postId,
          authorName: ex.authorName,
          postText: ex.postText,
          timestamp: new Date(ex.timestamp),
          trailReferences: [],
          classification: null,
          confidenceScore: null,
          flaggedForReview: false,
        });

        // Comments as separate posts
        for (let i = 0; i < ex.comments.length; i++) {
          const c = ex.comments[i];
          posts.push({
            postId: `${ex.postId}-c${i}`,
            authorName: c.authorName,
            postText: c.commentText,
            timestamp: new Date(ex.timestamp),
            trailReferences: [],
            classification: null,
            confidenceScore: null,
            flaggedForReview: false,
          });
        }
      }
    } else {
      // Legacy format: postText already extracted
      posts = rawPosts.map((p) => ({
        postId: p.postId,
        authorName: p.authorName || 'Unknown',
        postText: p.postText || '',
        timestamp: new Date(p.timestamp),
        trailReferences: [],
        classification: null,
        confidenceScore: null,
        flaggedForReview: false,
      }));
    }

    // Store (deduplicates via ON CONFLICT)
    const stored = await storePosts(posts);

    // Classify
    let classified = 0;
    const unmatchedPosts: Array<{ postId: string; text: string; classification: string }> = [];

    if (process.env.OPENAI_API_KEY) {
      const activeTrails = await listActive();
      const knownTrailNames = activeTrails.map((t) => t.name);

      for (const post of posts) {
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
      extracted: extractedCount,
      stored,
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
