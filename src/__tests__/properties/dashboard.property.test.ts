import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { ConditionStatus } from '@/types';

// Feature: trail-conditions-predictor, Property 11: Dashboard data includes status and predicted dry time for drying trails
// **Validates: Requirements 5.1, 5.2, 5.3, 5.6**

// In-memory stores
let trailsStore: Map<string, Record<string, unknown>>;
let predictionsStore: Map<string, Record<string, unknown>>;
let idCounter: number;

function genId() {
  return `uuid-${++idCounter}`;
}

const CONDITION_STATUSES: ConditionStatus[] = [
  'Verified Rideable',
  'Predicted Rideable',
  'Predicted Not Rideable',
  'Verified Not Rideable',
];

const DRYING_STATUSES: ConditionStatus[] = [
  'Predicted Not Rideable',
  'Predicted Rideable',
];

vi.mock('@/lib/db', () => {
  const sqlMock = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    // Dashboard query: SELECT trails LEFT JOIN predictions WHERE is_archived = false
    if (
      query.includes('SELECT') &&
      query.includes('FROM trails') &&
      query.includes('predictions') &&
      query.includes('is_archived = false')
    ) {
      const activeTrails = Array.from(trailsStore.values())
        .filter((t) => t.is_archived === false)
        .sort((a, b) => (a.name as string).localeCompare(b.name as string));

      const rows = activeTrails.map((trail) => {
        const status = trail.condition_status as ConditionStatus;
        const isDrying = DRYING_STATUSES.includes(status);

        // Find the most recent prediction for this trail
        let predictedDryTime: string | null = null;
        if (isDrying) {
          const trailPredictions = Array.from(predictionsStore.values())
            .filter((p) => p.trail_id === trail.id)
            .sort(
              (a, b) =>
                new Date(b.created_at as string).getTime() -
                new Date(a.created_at as string).getTime()
            );
          if (trailPredictions.length > 0) {
            predictedDryTime = trailPredictions[0].predicted_dry_time as string;
          }
        }

        return {
          id: trail.id,
          name: trail.name,
          condition_status: trail.condition_status,
          updated_at: trail.updated_at,
          predicted_dry_time: predictedDryTime,
        };
      });

      return Promise.resolve({ rows, rowCount: rows.length });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  return { sql: sqlMock };
});

import { getTrailsWithConditions } from '@/services/dashboard-service';

// --- Generators ---

const conditionStatusArb = fc.constantFrom(...CONDITION_STATUSES);

const trailNameArb = fc
  .stringMatching(/^[a-zA-Z0-9 ]+$/)
  .filter((s) => s.trim().length > 0);

const trailArb = fc.record({
  name: trailNameArb,
  conditionStatus: conditionStatusArb,
  isArchived: fc.boolean(),
});

// Generate a set of trails with unique names
const trailSetArb = fc
  .array(trailArb, { minLength: 1, maxLength: 20 })
  .map((trails) => {
    // Deduplicate by name
    const seen = new Set<string>();
    return trails.filter((t) => {
      const key = t.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })
  .filter((trails) => trails.length > 0);

// --- Helpers ---

function seedTrails(
  trails: Array<{
    name: string;
    conditionStatus: ConditionStatus;
    isArchived: boolean;
  }>
): string[] {
  const ids: string[] = [];
  for (const t of trails) {
    const id = genId();
    const now = new Date().toISOString();
    trailsStore.set(id, {
      id,
      name: t.name,
      condition_status: t.conditionStatus,
      is_archived: t.isArchived,
      updated_at: now,
      primary_station_id: 'STATION1',
      drying_rate_in_per_day: 2.5,
      max_drying_days: 3,
      updates_enabled: true,
    });
    ids.push(id);
  }
  return ids;
}

function addPrediction(trailId: string): string {
  const id = genId();
  const futureTime = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  predictionsStore.set(id, {
    id,
    trail_id: trailId,
    rain_event_id: genId(),
    predicted_dry_time: futureTime,
    actual_dry_time: null,
    input_data: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

// --- Tests ---

describe('Property 11: Dashboard data includes status and predicted dry time for drying trails', () => {
  beforeEach(() => {
    trailsStore = new Map();
    predictionsStore = new Map();
    idCounter = 0;
  });

  it('all non-archived trails appear in dashboard results with condition_status and updated_at', async () => {
    await fc.assert(
      fc.asyncProperty(trailSetArb, async (trailInputs) => {
        // Reset stores each iteration
        trailsStore = new Map();
        predictionsStore = new Map();
        idCounter = 0;

        const ids = seedTrails(trailInputs);

        // Add predictions for drying trails
        for (let i = 0; i < trailInputs.length; i++) {
          if (DRYING_STATUSES.includes(trailInputs[i].conditionStatus)) {
            addPrediction(ids[i]);
          }
        }

        const results = await getTrailsWithConditions();

        // Count expected non-archived trails
        const expectedNonArchived = trailInputs.filter((t) => !t.isArchived);

        // All non-archived trails should appear
        expect(results.length).toBe(expectedNonArchived.length);

        // No archived trails should appear
        const archivedNames = new Set(
          trailInputs.filter((t) => t.isArchived).map((t) => t.name)
        );
        for (const row of results) {
          expect(archivedNames.has(row.name)).toBe(false);
        }

        // Every result has condition_status and updated_at
        for (const row of results) {
          expect(row.condition_status).toBeDefined();
          expect(CONDITION_STATUSES).toContain(row.condition_status);
          expect(row.updated_at).toBeDefined();
          expect(typeof row.updated_at).toBe('string');
          expect(row.updated_at.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('drying trails include predicted_dry_time, non-drying trails do not', async () => {
    await fc.assert(
      fc.asyncProperty(trailSetArb, async (trailInputs) => {
        // Reset stores each iteration
        trailsStore = new Map();
        predictionsStore = new Map();
        idCounter = 0;

        const ids = seedTrails(trailInputs);

        // Add predictions for drying trails
        for (let i = 0; i < trailInputs.length; i++) {
          if (DRYING_STATUSES.includes(trailInputs[i].conditionStatus)) {
            addPrediction(ids[i]);
          }
        }

        const results = await getTrailsWithConditions();

        for (const row of results) {
          const isDrying = DRYING_STATUSES.includes(row.condition_status);

          if (isDrying) {
            // Drying trails should have a predicted_dry_time
            expect(row.predicted_dry_time).not.toBeNull();
            expect(typeof row.predicted_dry_time).toBe('string');
          } else {
            // Non-drying trails should NOT have a predicted_dry_time
            expect(row.predicted_dry_time).toBeNull();
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
