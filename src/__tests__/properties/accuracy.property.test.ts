import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Feature: trail-conditions-predictor, Property 18: Prediction accuracy calculation
// **Validates: Requirements 10.3**

// In-memory prediction store
let predictionsStore: Array<{
  predicted_dry_time: string;
  actual_dry_time: string;
  created_at: string;
}>;

vi.mock('@/lib/db', () => {
  const sqlMock = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    // Accuracy query: SELECT predicted_dry_time, actual_dry_time FROM predictions
    if (
      query.includes('SELECT') &&
      query.includes('predicted_dry_time') &&
      query.includes('actual_dry_time') &&
      query.includes('predictions')
    ) {
      // Sort by created_at DESC and limit to 10, matching the real SQL
      const sorted = [...predictionsStore].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      const rows = sorted.slice(0, 10);
      return Promise.resolve({ rows, rowCount: rows.length });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  return { sql: sqlMock };
});

import { getPredictionAccuracy } from '@/services/dashboard-service';

// --- Generators ---

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Generate a base timestamp as ms within a reasonable range */
const MIN_TS = new Date('2023-01-01T00:00:00Z').getTime();
const MAX_TS = new Date('2025-12-31T00:00:00Z').getTime();

const baseTimestampArb = fc.integer({ min: MIN_TS, max: MAX_TS }).map((ms) => new Date(ms));

/** Generate a prediction with both predicted and actual dry times */
const predictionArb = fc
  .record({
    predictedDryTimeMs: fc.integer({ min: MIN_TS, max: MAX_TS }),
    // Offset in ms from predicted time: range covers well within and outside 2-hour window
    offsetMs: fc.integer({ min: -10 * 60 * 60 * 1000, max: 10 * 60 * 60 * 1000 }),
    // created_at offset in minutes from a base (to ensure ordering)
    createdAtOffsetMin: fc.integer({ min: 0, max: 100000 }),
  })
  .map(({ predictedDryTimeMs, offsetMs, createdAtOffsetMin }) => {
    const predictedDryTime = new Date(predictedDryTimeMs);
    const actualDryTime = new Date(predictedDryTimeMs + offsetMs);
    const createdAt = new Date(MIN_TS + createdAtOffsetMin * 60 * 1000);
    return {
      predicted_dry_time: predictedDryTime.toISOString(),
      actual_dry_time: actualDryTime.toISOString(),
      created_at: createdAt.toISOString(),
    };
  });

const predictionListArb = fc.array(predictionArb, { minLength: 0, maxLength: 25 });

// --- Helper: compute expected accuracy from raw list ---

function computeExpectedAccuracy(
  predictions: Array<{
    predicted_dry_time: string;
    actual_dry_time: string;
    created_at: string;
  }>
): { accurate: number; total: number } | null {
  if (predictions.length === 0) return null;

  // Sort by created_at DESC, take at most 10
  const sorted = [...predictions].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const limited = sorted.slice(0, 10);

  const accurate = limited.filter((p) => {
    const diff = Math.abs(
      new Date(p.predicted_dry_time).getTime() -
        new Date(p.actual_dry_time).getTime()
    );
    return diff <= TWO_HOURS_MS;
  }).length;

  return { accurate, total: limited.length };
}

// --- Tests ---

describe('Property 18: Prediction accuracy calculation', () => {
  beforeEach(() => {
    predictionsStore = [];
  });

  it('accuracy percentage equals count of predictions within 2 hours divided by total, times 100', async () => {
    await fc.assert(
      fc.asyncProperty(predictionListArb, async (predictions) => {
        // Seed the in-memory store
        predictionsStore = [...predictions];

        const result = await getPredictionAccuracy();
        const expected = computeExpectedAccuracy(predictions);

        if (expected === null) {
          expect(result).toBeNull();
        } else {
          expect(result).not.toBeNull();
          expect(result!.accurate).toBe(expected.accurate);
          expect(result!.total).toBe(expected.total);

          // Verify the percentage calculation matches the property definition
          const expectedPercent = (expected.accurate / expected.total) * 100;
          const actualPercent = (result!.accurate / result!.total) * 100;
          expect(actualPercent).toBeCloseTo(expectedPercent, 10);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('uses at most the last 10 predictions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(predictionArb, { minLength: 11, maxLength: 25 }),
        async (predictions) => {
          predictionsStore = [...predictions];

          const result = await getPredictionAccuracy();

          expect(result).not.toBeNull();
          expect(result!.total).toBeLessThanOrEqual(10);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns null when no predictions have actual outcomes', async () => {
    predictionsStore = [];
    const result = await getPredictionAccuracy();
    expect(result).toBeNull();
  });
});
