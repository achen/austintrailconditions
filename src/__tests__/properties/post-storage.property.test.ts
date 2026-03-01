import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { TrailReport } from '@/types';

// Feature: trail-conditions-predictor, Property 3: Trail report storage round-trip
// **Validates: Requirements 2.2**
// Feature: trail-conditions-predictor, Property 4: Trail report idempotency
// **Validates: Requirements 2.4**

// In-memory store simulating the trail_reports table
let store: Map<string, Record<string, unknown>>;

// Mock @/lib/db before importing the service
vi.mock('@/lib/db', () => {
  const sqlMock = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    if (query.includes('INSERT INTO trail_reports')) {
      const [
        postId,
        authorName,
        postText,
        timestamp,
        trailReferences,
        classification,
        confidenceScore,
        flaggedForReview,
      ] = values;

      const key = String(postId);

      // ON CONFLICT (post_id) DO NOTHING behavior
      if (store.has(key)) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      store.set(key, {
        post_id: postId,
        author_name: authorName,
        post_text: postText,
        timestamp,
        trail_references: trailReferences,
        classification,
        confidence_score: confidenceScore,
        flagged_for_review: flaggedForReview,
      });

      return Promise.resolve({ rowCount: 1, rows: [] });
    }

    if (query.includes('SELECT') && query.includes('trail_reports')) {
      const [postId] = values;
      const key = String(postId);
      const row = store.get(key);
      return Promise.resolve({
        rows: row ? [row] : [],
        rowCount: row ? 1 : 0,
      });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  return { sql: sqlMock };
});

// Import after mock is set up
import { storePosts } from '@/services/post-collector';

/**
 * Helper to query the in-memory store by post ID.
 */
function queryByPostId(postId: string): Record<string, unknown> | undefined {
  return store.get(postId);
}

/**
 * Generator for valid TrailReport objects matching the design spec.
 */
const trailReportArb: fc.Arbitrary<TrailReport> = fc.record({
  postId: fc.stringMatching(/^[a-zA-Z0-9_]+$/).filter((s) => s.length > 0),
  authorName: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
  postText: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
  timestamp: fc.date({
    min: new Date('2020-01-01T00:00:00Z'),
    max: new Date('2030-12-31T23:59:59Z'),
    noInvalidDate: true,
  }),
  trailReferences: fc.array(fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0), { minLength: 0, maxLength: 5 }),
  classification: fc.constant(null) as fc.Arbitrary<null>,
  confidenceScore: fc.constant(null) as fc.Arbitrary<null>,
  flaggedForReview: fc.constant(false),
});

describe('Property 3: Trail report storage round-trip', () => {
  beforeEach(() => {
    store = new Map();
  });

  it('storing a trail report and querying by post ID returns all original field values', async () => {
    await fc.assert(
      fc.asyncProperty(trailReportArb, async (report) => {
        // Skip if this key was already used in a prior iteration
        if (store.has(report.postId)) return;

        // Store the report
        const count = await storePosts([report]);
        expect(count).toBe(1);

        // Query back by post ID
        const row = queryByPostId(report.postId);

        expect(row).toBeDefined();
        expect(row!.post_id).toBe(report.postId);
        expect(row!.author_name).toBe(report.authorName);
        expect(row!.post_text).toBe(report.postText);
        expect(row!.timestamp).toBe(report.timestamp.toISOString());
        expect(row!.trail_references).toEqual(report.trailReferences);
        expect(row!.classification).toBe(report.classification);
        expect(row!.confidence_score).toBe(report.confidenceScore);
        expect(row!.flagged_for_review).toBe(report.flaggedForReview);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 4: Trail report idempotency', () => {
  beforeEach(() => {
    store = new Map();
  });

  it('calling storePosts twice with the same report results in exactly one record and no error on the second call', async () => {
    await fc.assert(
      fc.asyncProperty(trailReportArb, async (report) => {
        // Skip if this key was already used in a prior iteration
        if (store.has(report.postId)) return;

        // First call — should insert one record
        const firstCount = await storePosts([report]);
        expect(firstCount).toBe(1);

        // Second call with the same report — should insert zero (ON CONFLICT DO NOTHING)
        const secondCount = await storePosts([report]);
        expect(secondCount).toBe(0);

        // Verify exactly one record exists for this post ID
        expect(store.has(report.postId)).toBe(true);

        // Count entries for this specific postId to verify no duplicates
        let countForKey = 0;
        store.forEach((_value, k) => {
          if (k === report.postId) {
            countForKey++;
          }
        });
        expect(countForKey).toBe(1);
      }),
      { numRuns: 100 }
    );
  });
});
