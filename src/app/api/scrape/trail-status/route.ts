import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * POST /api/scrape/trail-status
 * Accept trail status results from the headless browser scraper.
 * Body: { trailName: string, isOpen: boolean, rawText?: string }
 *
 * isOpen: true  → "Predicted Dry"
 * isOpen: false → "Closed" (the official page says trails are closed)
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { trailName, isOpen, rawText } = body;

    if (typeof trailName !== 'string' || typeof isOpen !== 'boolean') {
      return NextResponse.json({ error: 'Invalid body: need trailName (string) and isOpen (boolean)' }, { status: 400 });
    }

    const newStatus = isOpen ? 'Predicted Dry' : 'Closed';

    const { rowCount } = await sql`
      UPDATE trails
      SET condition_status = ${newStatus}, updated_at = now()
      WHERE name = ${trailName}
        AND is_archived = false
        AND condition_status != ${newStatus}
    `;

    const changed = (rowCount ?? 0) > 0;
    if (changed) {
      console.log(`${trailName}: status updated to "${newStatus}" (scraped: "${rawText || ''}")`);
    }

    return NextResponse.json({ success: true, changed, trailName, newStatus });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Trail status scrape ingest failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
