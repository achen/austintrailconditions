import { TrailReport } from '@/types';
import { sql } from '@/lib/db';

/**
 * Fetch recent posts from a Facebook group using the Graph API.
 * Maps Facebook post data to TrailReport objects with default classification fields.
 */
export async function fetchPosts(
  groupId: string,
  accessToken: string,
  since?: Date,
  baseUrl: string = 'https://graph.facebook.com/v18.0'
): Promise<TrailReport[]> {
  let url = `${baseUrl}/${encodeURIComponent(groupId)}/feed?access_token=${encodeURIComponent(accessToken)}&fields=id,from,message,created_time`;

  if (since) {
    const sinceTimestamp = Math.floor(since.getTime() / 1000);
    url += `&since=${sinceTimestamp}`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    console.error(
      `Facebook Graph API error: ${response.status} ${response.statusText}`
    );
    return [];
  }

  const data = await response.json();

  if (!data.data || !Array.isArray(data.data)) {
    console.error('Unexpected Facebook API response: no data array');
    return [];
  }

  return data.data
    .filter((post: Record<string, unknown>) => post.message)
    .map((post: Record<string, unknown>) => {
      const from = post.from as Record<string, string> | undefined;

      return {
        postId: post.id as string,
        authorName: from?.name ?? 'Unknown',
        postText: post.message as string,
        timestamp: new Date(post.created_time as string),
        trailReferences: [],
        classification: null,
        confidenceScore: null,
        flaggedForReview: false,
      } satisfies TrailReport;
    });
}


/**
 * Store trail reports in the database.
 * Uses ON CONFLICT (post_id) DO NOTHING for deduplication.
 * Returns the count of newly inserted records.
 */
export async function storePosts(posts: TrailReport[]): Promise<number> {
  if (posts.length === 0) return 0;

  let insertedCount = 0;

  for (const post of posts) {
    const result = await sql`
      INSERT INTO trail_reports (
        post_id, author_name, post_text, timestamp,
        trail_references, classification, confidence_score, flagged_for_review
      ) VALUES (
        ${post.postId},
        ${post.authorName},
        ${post.postText},
        ${post.timestamp.toISOString()},
        ${post.trailReferences as string[]},
        ${post.classification},
        ${post.confidenceScore},
        ${post.flaggedForReview}
      )
      ON CONFLICT (post_id) DO NOTHING
    `;
    if (result.rowCount && result.rowCount > 0) {
      insertedCount++;
    }
  }

  return insertedCount;
}
