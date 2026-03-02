import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * POST /api/scrape/seen
 *
 * Given arrays of post IDs and comment IDs, returns which ones already exist in the database.
 * Used by the scraper to determine early-stop without maintaining local state.
 */
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const postIds: string[] = body.postIds || [];
    const commentIds: string[] = body.commentIds || [];

    const allIds = [...postIds, ...commentIds];
    if (allIds.length === 0) {
      return NextResponse.json({ seenPostIds: [], seenCommentIds: [] });
    }

    const result = await sql`
      SELECT post_id FROM trail_reports WHERE post_id = ANY(${allIds})
    `;

    const seenSet = new Set(result.rows.map((r: Record<string, string>) => r.post_id));

    return NextResponse.json({
      seenPostIds: postIds.filter(id => seenSet.has(id)),
      seenCommentIds: commentIds.filter(id => seenSet.has(id)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Seen check failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
