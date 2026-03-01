import { sql } from '@/lib/db';

interface ScrapableTrail {
  id: string;
  name: string;
  status_url: string;
  condition_status: string;
}

interface ScrapeResult {
  trailId: string;
  trailName: string;
  isOpen: boolean;
  rawText: string;
}

/**
 * Fetch trails that have a status_url configured.
 */
export async function getScrapableTrails(): Promise<ScrapableTrail[]> {
  const { rows } = await sql`
    SELECT id, name, status_url, condition_status
    FROM trails
    WHERE status_url IS NOT NULL
      AND is_archived = false
      AND updates_enabled = true
  `;
  return rows as ScrapableTrail[];
}

/**
 * Scrape a trail's official status page and determine open/closed.
 * Looks for text patterns like "trails...are open" or "trails...are closed".
 */
export async function scrapeTrailStatus(trail: ScrapableTrail): Promise<ScrapeResult | null> {
  try {
    const res = await fetch(trail.status_url, {
      headers: { 'User-Agent': 'AustinTrailConditions/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`Scrape failed for ${trail.name}: HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();

    // Strip HTML tags for pattern matching (the status text spans across <a> tags)
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    // Look for patterns like "mountain bike trails...are open" or "...are closed"
    const openPattern = /mountain bike trails[^.]*are\s+open/i;
    const closedPattern = /mountain bike trails[^.]*are\s+closed/i;

    if (openPattern.test(text)) {
      const match = text.match(openPattern);
      return { trailId: trail.id, trailName: trail.name, isOpen: true, rawText: match![0].trim() };
    }
    if (closedPattern.test(text)) {
      const match = text.match(closedPattern);
      return { trailId: trail.id, trailName: trail.name, isOpen: false, rawText: match![0].trim() };
    }

    console.warn(`Scrape for ${trail.name}: no open/closed pattern found`);
    return null;
  } catch (err) {
    console.error(`Scrape error for ${trail.name}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Update trail condition_status based on scrape result.
 * Only updates if the scraped status differs from current.
 */
export async function applyScrapedStatus(result: ScrapeResult): Promise<boolean> {
  const newStatus = result.isOpen ? 'Verified Rideable' : 'Verified Not Rideable';

  const { rowCount } = await sql`
    UPDATE trails
    SET condition_status = ${newStatus}, updated_at = now()
    WHERE id = ${result.trailId}
      AND condition_status != ${newStatus}
  `;

  if (rowCount && rowCount > 0) {
    console.log(`${result.trailName}: status updated to "${newStatus}" (scraped: "${result.rawText}")`);
    return true;
  }
  return false;
}

/**
 * Scrape all configured trails and apply status updates.
 */
export async function scrapeAllTrailStatuses(): Promise<{ scraped: number; updated: number }> {
  const trails = await getScrapableTrails();
  let scraped = 0;
  let updated = 0;

  for (const trail of trails) {
    const result = await scrapeTrailStatus(trail);
    if (result) {
      scraped++;
      const changed = await applyScrapedStatus(result);
      if (changed) updated++;
    }
  }

  return { scraped, updated };
}
