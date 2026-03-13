import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * GET /api/admin/rain-events?trailId=xxx — rain events for a trail
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const trailId = searchParams.get('trailId');

  if (!trailId) {
    return NextResponse.json({ error: 'trailId required' }, { status: 400 });
  }

  const { rows } = await sql`
    SELECT
      re.id,
      re.start_timestamp,
      re.end_timestamp,
      re.total_precipitation_in,
      re.is_active,
      re.created_at
    FROM rain_events re
    WHERE re.trail_id = ${trailId}
      AND re.total_precipitation_in >= 0.05
    ORDER BY re.start_timestamp DESC
    LIMIT 30
  `;

  return NextResponse.json(rows);
}
