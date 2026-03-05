import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrapeTrailStatus } from '@/services/trail-status-scraper';

const TRAIL = {
  id: 'test-id',
  name: 'Reimers Ranch',
  status_url: 'https://parks.traviscountytx.gov/parks/reimers-ranch',
  condition_status: 'Predicted Rideable',
};

const OPEN_HTML = `
<div class="alert alert-success" role="alert">
  <h4>Mountain Biking Trails Status</h4>
  <p>The mountain bike trails at Milton <a class="tclink" href="/parks/reimers-ranch/">Reimers Ranch Park</a> are open. They sometimes close after rain.</p>
</div>`;

const CLOSED_HTML = `
<div class="alert alert-danger" role="alert">
  <h4>Mountain Biking Trails Status</h4>
  <p>The mountain bike trails at Milton <a class="tclink" href="/parks/reimers-ranch/">Reimers Ranch Park</a> are closed due to recent rain. They will reopen when dry.</p>
</div>`;

const NO_STATUS_HTML = `
<div class="park-content">
  <p>Welcome to Reimers Ranch Park.</p>
</div>`;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('scrapeTrailStatus', () => {
  it('detects open status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(OPEN_HTML, { status: 200 }));
    const result = await scrapeTrailStatus(TRAIL);
    expect(result).not.toBeNull();
    expect(result!.isOpen).toBe(true);
    expect(result!.rawText).toMatch(/are\s+open/i);
  });

  it('detects closed status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(CLOSED_HTML, { status: 200 }));
    const result = await scrapeTrailStatus(TRAIL);
    expect(result).not.toBeNull();
    expect(result!.isOpen).toBe(false);
    expect(result!.rawText).toMatch(/are\s+closed/i);
  });

  it('returns null when no status pattern found', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(NO_STATUS_HTML, { status: 200 }));
    const result = await scrapeTrailStatus(TRAIL);
    expect(result).toBeNull();
  });

  it('returns null on HTTP error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));
    const result = await scrapeTrailStatus(TRAIL);
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));
    const result = await scrapeTrailStatus(TRAIL);
    expect(result).toBeNull();
  });
});
