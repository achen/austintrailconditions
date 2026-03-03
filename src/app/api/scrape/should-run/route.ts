import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * GET /api/scrape/should-run
 * 
 * Returns whether the Facebook scraper should actually hit Facebook.
 * Logic:
 * - If any trails are wet/drying: scrape every hour
 * - If all trails are dry: scrape once per day (for non-weather closures)
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Check if any trails are not fully dry
    const wetTrails = await sql`
      SELECT COUNT(*) as count FROM trails
      WHERE is_archived = false
        AND condition_status IN ('Probably Not Rideable', 'Probably Rideable', 'Verified Not Rideable')
    `;
    const wetCount = parseInt(wetTrails.rows[0]?.count as string) || 0;
    const hasWetTrails = wetCount > 0;

    // Check when we last scraped Facebook
    const lastScrape = await sql`
      SELECT MAX(timestamp) as last_scrape FROM trail_reports
      WHERE timestamp > now() - interval '7 days'
    `;
    const lastScrapeTime = lastScrape.rows[0]?.last_scrape 
      ? new Date(lastScrape.rows[0].last_scrape as string)
      : null;
    
    const hoursSinceLastScrape = lastScrapeTime
      ? (Date.now() - lastScrapeTime.getTime()) / (1000 * 60 * 60)
      : 999;

    let shouldScrape = false;
    let reason = '';

    if (hasWetTrails) {
      // Wet trails: scrape if it's been at least 1 hour
      shouldScrape = hoursSinceLastScrape >= 1;
      reason = shouldScrape 
        ? `${wetCount} wet trail(s), ${hoursSinceLastScrape.toFixed(1)}h since last scrape`
        : `${wetCount} wet trail(s), but only ${hoursSinceLastScrape.toFixed(1)}h since last scrape`;
    } else {
      // All dry: scrape once per day for non-weather closures
      shouldScrape = hoursSinceLastScrape >= 24;
      reason = shouldScrape
        ? `All trails dry, ${hoursSinceLastScrape.toFixed(1)}h since last scrape (daily check)`
        : `All trails dry, only ${hoursSinceLastScrape.toFixed(1)}h since last scrape (next in ${(24 - hoursSinceLastScrape).toFixed(1)}h)`;
    }

    return NextResponse.json({
      shouldScrape,
      reason,
      wetTrailCount: wetCount,
      hoursSinceLastScrape: Math.round(hoursSinceLastScrape * 10) / 10,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('should-run check failed:', message);
    // On error, default to scraping to be safe
    return NextResponse.json({
      shouldScrape: true,
      reason: `Error checking status: ${message}`,
      error: true,
    });
  }
}
