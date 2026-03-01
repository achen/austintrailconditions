import { NextResponse } from 'next/server';
import { scrapeAllTrailStatuses } from '@/services/trail-status-scraper';

/**
 * GET /api/cron/scrape
 * Scrape official trail status pages and update conditions.
 * Triggered by Vercel Cron every 30 minutes.
 */
export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await scrapeAllTrailStatuses();
    return NextResponse.json({
      success: true,
      scraped: result.scraped,
      updated: result.updated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Scrape cron failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
