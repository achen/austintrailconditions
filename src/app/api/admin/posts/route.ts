import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * GET /api/admin/posts — recent Facebook posts with classification decisions
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
  const classification = searchParams.get('classification');

  let rows;
  if (classification) {
    const result = await sql`
      SELECT
        tr.post_id,
        tr.author_name,
        tr.post_text,
        tr.timestamp,
        tr.classification,
        tr.confidence_score,
        tr.trail_references,
        tr.flagged_for_review,
        tr.is_comment,
        tr.parent_post_id,
        tr.created_at,
        tv.new_status AS applied_status,
        tv.created_at AS applied_at
      FROM trail_reports tr
      LEFT JOIN trail_verifications tv ON tv.post_id = tr.post_id
      WHERE tr.classification = ${classification}
      ORDER BY tr.timestamp DESC
      LIMIT ${limit}
    `;
    rows = result.rows;
  } else {
    const result = await sql`
      SELECT
        tr.post_id,
        tr.author_name,
        tr.post_text,
        tr.timestamp,
        tr.classification,
        tr.confidence_score,
        tr.trail_references,
        tr.flagged_for_review,
        tr.is_comment,
        tr.parent_post_id,
        tr.created_at,
        tv.new_status AS applied_status,
        tv.created_at AS applied_at
      FROM trail_reports tr
      LEFT JOIN trail_verifications tv ON tv.post_id = tr.post_id
      ORDER BY tr.timestamp DESC
      LIMIT ${limit}
    `;
    rows = result.rows;
  }

  return NextResponse.json(rows);
}
