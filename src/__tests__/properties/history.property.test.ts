import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { PredictionInput } from '@/types';

// Feature: trail-conditions-predictor, Property 17: Historical correlation query returns similar events
// **Validates: Requirements 9.2, 9.3**

// --- In-memory stores simulating database tables ---
let predictionsStore: Map<string, Record<string, unknown>>;
let rainEventsStore: Map<string, Record<string, unknown>>;

vi.mock('@/lib/db', () => {
  const sqlMock = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    // Historical correlation query: predictions JOIN rain_events with precipitation + temperature filters
    if (query.includes('predictions') && query.includes('JOIN rain_events')) {
      const [trailId, minPrecip, maxPrecip, minTemp, maxTemp] = values as [string, number, number, number, number];

      const filtered = Array.from(predictionsStore.values())
        .filter((p) => {
          if (p.trail_id !== trailId || p.actual_dry_time === null) return false;
          const re = rainEventsStore.get(p.rain_event_id as string);
          if (!re) return false;
          const precip = Number(re.total_precipitation_in);
          if (precip < minPrecip || precip > maxPrecip) return false;
          const inputData = p.input_data as Record<string, unknown> | null;
          if (inputData && typeof inputData.temperatureF === 'number') {
            if (inputData.temperatureF < minTemp || inputData.temperatureF > maxTemp) return false;
          }
          return true;
        })
        .sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime())
        .slice(0, 10);

      const rows = filtered.map((p) => {
        const re = rainEventsStore.get(p.rain_event_id as string)!;
        return {
          total_precipitation_in: re.total_precipitation_in,
          predicted_dry_time: p.predicted_dry_time,
          actual_dry_time: p.actual_dry_time,
          input_data: p.input_data,
        };
      });

      return Promise.resolve({ rows, rowCount: rows.length });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  return { sql: sqlMock };
});

import { findSimilarHistoricalOutcomes } from '@/services/history-service';

// --- Helpers ---

let idCounter = 0;

function addPrediction(opts: {
  id: string;
  trailId: string;
  rainEventId: string;
  predictedDryTime: string;
  actualDryTime: string | null;
  inputData: Partial<PredictionInput>;
  createdAt: string;
}) {
  predictionsStore.set(opts.id, {
    id: opts.id,
    trail_id: opts.trailId,
    rain_event_id: opts.rainEventId,
    predicted_dry_time: opts.predictedDryTime,
    actual_dry_time: opts.actualDryTime,
    input_data: opts.inputData,
    created_at: opts.createdAt,
    updated_at: opts.createdAt,
  });
}

function addRainEvent(opts: {
  id: string;
  trailId: string;
  totalPrecipitationIn: number;
}) {
  rainEventsStore.set(opts.id, {
    id: opts.id,
    trail_id: opts.trailId,
    start_timestamp: '2024-06-01T10:00:00Z',
    end_timestamp: '2024-06-01T12:00:00Z',
    total_precipitation_in: opts.totalPrecipitationIn,
    is_active: false,
  });
}

// --- Generators ---

/** A single prediction record with associated rain event, for a given trail */
interface PredEntry {
  predId: string;
  rainEventId: string;
  trailId: string;
  precipitationIn: number;
  temperatureF: number;
  actualDryTime: string;
  predictedDryTime: string;
  createdAt: string;
}

/**
 * Generate an array of prediction entries for multiple trails.
 * Each entry has a random precipitation (0-10), temperature (20-120),
 * and a unique createdAt timestamp so ordering is deterministic.
 */
const predEntriesArb = (targetTrailId: string): fc.Arbitrary<PredEntry[]> =>
  fc
    .array(
      fc.record({
        precipitationIn: fc.double({ min: 0, max: 10, noNaN: true }),
        temperatureF: fc.double({ min: 20, max: 120, noNaN: true }),
        // Some entries belong to the target trail, some to other trails
        isTargetTrail: fc.boolean(),
        // Some entries have actual_dry_time, some don't (incomplete)
        hasActualDryTime: fc.boolean(),
        // Unique day offset for createdAt ordering
        dayOffset: fc.integer({ min: 0, max: 364 }),
      }),
      { minLength: 1, maxLength: 25 }
    )
    .map((entries) => {
      // Ensure unique dayOffsets for deterministic ordering
      const usedOffsets = new Set<number>();
      return entries
        .filter((e) => {
          if (usedOffsets.has(e.dayOffset)) return false;
          usedOffsets.add(e.dayOffset);
          return true;
        })
        .map((e, i) => {
          const trailId = e.isTargetTrail ? targetTrailId : `other-trail-${i}`;
          const day = String(1 + (e.dayOffset % 28)).padStart(2, '0');
          const month = String(1 + Math.floor(e.dayOffset / 28) % 12).padStart(2, '0');
          const createdAt = `2024-${month}-${day}T12:00:00Z`;
          const predictedDryTime = `2024-${month}-${day}T18:00:00Z`;
          const actualDryTime = e.hasActualDryTime ? `2024-${month}-${day}T20:00:00Z` : null;
          return {
            predId: `pred-${i}`,
            rainEventId: `re-${i}`,
            trailId,
            precipitationIn: e.precipitationIn,
            temperatureF: e.temperatureF,
            actualDryTime: actualDryTime!,
            predictedDryTime,
            createdAt,
          } as PredEntry;
        });
    });

/** Query parameters: precipitation and temperature to search for */
const queryParamsArb = fc.record({
  precipitationIn: fc.double({ min: 0, max: 10, noNaN: true }),
  temperatureF: fc.double({ min: 20, max: 120, noNaN: true }),
});

// --- Property Test ---

describe('Property 17: Historical correlation query returns similar events', () => {
  beforeEach(() => {
    predictionsStore = new Map();
    rainEventsStore = new Map();
    idCounter = 0;
  });

  it('returns only matching events for the correct trail, within ±0.5 precip and ±10°F temp, ordered by most recent, max 10', async () => {
    const targetTrailId = 'target-trail-1';

    await fc.assert(
      fc.asyncProperty(
        predEntriesArb(targetTrailId),
        queryParamsArb,
        async (entries, queryParams) => {
          // Reset stores
          predictionsStore = new Map();
          rainEventsStore = new Map();

          // Populate stores
          for (const entry of entries) {
            addRainEvent({
              id: entry.rainEventId,
              trailId: entry.trailId,
              totalPrecipitationIn: entry.precipitationIn,
            });
            addPrediction({
              id: entry.predId,
              trailId: entry.trailId,
              rainEventId: entry.rainEventId,
              predictedDryTime: entry.predictedDryTime,
              actualDryTime: entry.actualDryTime,
              inputData: { temperatureF: entry.temperatureF },
              createdAt: entry.createdAt,
            });
          }

          // Query
          const results = await findSimilarHistoricalOutcomes(
            targetTrailId,
            queryParams.precipitationIn,
            queryParams.temperatureF
          );

          // Compute expected matching entries
          const minPrecip = queryParams.precipitationIn - 0.5;
          const maxPrecip = queryParams.precipitationIn + 0.5;
          const minTemp = queryParams.temperatureF - 10;
          const maxTemp = queryParams.temperatureF + 10;

          const expectedMatches = entries
            .filter(
              (e) =>
                e.trailId === targetTrailId &&
                e.actualDryTime !== null &&
                e.precipitationIn >= minPrecip &&
                e.precipitationIn <= maxPrecip &&
                e.temperatureF >= minTemp &&
                e.temperatureF <= maxTemp
            )
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 10);

          // 1. All returned results are for the correct trail (verified via matching count)
          expect(results.length).toBe(expectedMatches.length);

          // 2. Max 10 results
          expect(results.length).toBeLessThanOrEqual(10);

          // 3. All returned results have precipitation within ±0.5 inches
          for (const r of results) {
            expect(r.precipitationIn).toBeGreaterThanOrEqual(minPrecip);
            expect(r.precipitationIn).toBeLessThanOrEqual(maxPrecip);
          }

          // 4. All returned results have temperature within ±10°F
          for (const r of results) {
            if (r.weatherConditions.temperatureF !== undefined) {
              expect(r.weatherConditions.temperatureF).toBeGreaterThanOrEqual(minTemp);
              expect(r.weatherConditions.temperatureF).toBeLessThanOrEqual(maxTemp);
            }
          }

          // 5. Results are ordered by most recent first
          for (let i = 1; i < results.length; i++) {
            const prevPrecip = expectedMatches[i - 1];
            const currPrecip = expectedMatches[i];
            expect(new Date(prevPrecip.createdAt).getTime()).toBeGreaterThanOrEqual(
              new Date(currPrecip.createdAt).getTime()
            );
          }

          // 6. Verify precipitation values match expected entries
          for (let i = 0; i < results.length; i++) {
            expect(results[i].precipitationIn).toBe(expectedMatches[i].precipitationIn);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
