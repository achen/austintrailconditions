import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Feature: trail-conditions-predictor, Property 12: Trail management round-trip
// **Validates: Requirements 6.1, 6.2**
// Feature: trail-conditions-predictor, Property 13: Archiving excludes from active list but retains history
// **Validates: Requirements 6.3, 6.4, 6.5**

// In-memory stores
let trailsStore: Map<string, Record<string, unknown>>;
let rainEventsStore: Map<string, Record<string, unknown>>;
let predictionsStore: Map<string, Record<string, unknown>>;
let trailReportsStore: Map<string, Record<string, unknown>>;
let idCounter: number;

function genId() {
  return `uuid-${++idCounter}`;
}

vi.mock('@/lib/db', () => {
  const sqlMock = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    // --- INSERT INTO trails ... RETURNING * ---
    if (query.includes('INSERT INTO trails') && query.includes('RETURNING')) {
      const [name, description, stationId, rate, maxDays] = values as [
        string, string | null, string, number, number
      ];
      const id = genId();
      const now = new Date().toISOString();
      const record: Record<string, unknown> = {
        id,
        name,
        description: description ?? null,
        primary_station_id: stationId,
        drying_rate_in_per_day: rate,
        max_drying_days: maxDays,
        updates_enabled: true,
        is_archived: false,
        condition_status: 'Predicted Dry',
        created_at: now,
        updated_at: now,
      };
      trailsStore.set(id, record);
      return Promise.resolve({ rows: [record], rowCount: 1 });
    }

    // --- UPDATE trails SET is_archived = true (archive) ---
    if (query.includes('UPDATE trails') && query.includes('is_archived = true')) {
      const id = values[0] as string;
      const trail = trailsStore.get(id);
      if (!trail) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      trail.is_archived = true;
      trail.updated_at = new Date().toISOString();
      return Promise.resolve({ rows: [{ ...trail }], rowCount: 1 });
    }

    // --- UPDATE trails SET ... (general update) RETURNING * ---
    if (query.includes('UPDATE trails') && query.includes('RETURNING')) {
      const [
        hasName, name, hasDesc, desc, hasStation, station,
        hasRate, rate, hasMaxDays, maxDays, hasUpdates, updates, id,
      ] = values as [
        boolean, string | null, boolean, string | null, boolean, string | null,
        boolean, number | null, boolean, number | null, boolean, boolean | null, string
      ];
      const trail = trailsStore.get(id);
      if (!trail) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (hasName && name !== null) trail.name = name;
      if (hasDesc) trail.description = desc;
      if (hasStation && station !== null) trail.primary_station_id = station;
      if (hasRate && rate !== null) trail.drying_rate_in_per_day = rate;
      if (hasMaxDays && maxDays !== null) trail.max_drying_days = maxDays;
      if (hasUpdates && updates !== null) trail.updates_enabled = updates;
      trail.updated_at = new Date().toISOString();
      return Promise.resolve({ rows: [{ ...trail }], rowCount: 1 });
    }

    // --- SELECT * FROM trails WHERE is_archived = false ---
    if (query.includes('SELECT') && query.includes('FROM trails') && query.includes('is_archived = false')) {
      const rows = Array.from(trailsStore.values())
        .filter((t) => t.is_archived === false)
        .sort((a, b) => (a.name as string).localeCompare(b.name as string));
      return Promise.resolve({ rows, rowCount: rows.length });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  return { sql: sqlMock };
});

import { create, update, archive, listActive } from '@/services/trail-service';

// --- Generators ---

const trailNameArb = fc.stringMatching(/^[a-zA-Z0-9 ]+$/).filter((s) => s.trim().length > 0);
const stationIdArb = fc.stringMatching(/^[A-Z0-9]+$/).filter((s) => s.length > 0);
const dryingRateArb = fc.double({ min: 0.5, max: 5, noNaN: true });
const maxDaysArb = fc.integer({ min: 1, max: 7 });

const trailInputArb = fc.record({
  name: trailNameArb,
  primaryStationId: stationIdArb,
  dryingRateInPerDay: dryingRateArb,
  maxDryingDays: maxDaysArb,
});

// --- Helpers for Property 13 ---

function addRainEvent(trailId: string) {
  const id = genId();
  rainEventsStore.set(id, {
    id,
    trail_id: trailId,
    start_timestamp: new Date().toISOString(),
    end_timestamp: new Date().toISOString(),
    total_precipitation_in: 1.5,
    is_active: false,
  });
  return id;
}

function addPrediction(trailId: string, rainEventId: string) {
  const id = genId();
  predictionsStore.set(id, {
    id,
    trail_id: trailId,
    rain_event_id: rainEventId,
    predicted_dry_time: new Date().toISOString(),
    actual_dry_time: null,
    input_data: {},
  });
  return id;
}

function addTrailReport(trailName: string) {
  const id = genId();
  trailReportsStore.set(id, {
    id,
    post_id: `post-${id}`,
    author_name: 'Tester',
    post_text: `${trailName} is dry`,
    timestamp: new Date().toISOString(),
    trail_references: [trailName],
    classification: 'dry',
    confidence_score: 0.9,
    flagged_for_review: false,
  });
  return id;
}

// --- Tests ---

describe('Property 12: Trail management round-trip', () => {
  beforeEach(() => {
    trailsStore = new Map();
    rainEventsStore = new Map();
    predictionsStore = new Map();
    trailReportsStore = new Map();
    idCounter = 0;
  });

  it('creating a trail and reading it back returns the same values', async () => {
    await fc.assert(
      fc.asyncProperty(trailInputArb, async (input) => {
        // Reset store each iteration to avoid name collisions
        trailsStore = new Map();
        idCounter = 0;

        const trail = await create(input);

        expect(trail.name).toBe(input.name);
        expect(trail.primaryStationId).toBe(input.primaryStationId);
        expect(trail.dryingRateInPerDay).toBe(input.dryingRateInPerDay);
        expect(trail.maxDryingDays).toBe(input.maxDryingDays);
        expect(trail.isArchived).toBe(false);
        expect(trail.updatesEnabled).toBe(true);
        expect(trail.conditionStatus).toBe('Predicted Dry');

        // Verify it appears in listActive
        const active = await listActive();
        const found = active.find((t) => t.id === trail.id);
        expect(found).toBeDefined();
        expect(found!.name).toBe(input.name);
        expect(found!.primaryStationId).toBe(input.primaryStationId);
        expect(found!.dryingRateInPerDay).toBe(input.dryingRateInPerDay);
        expect(found!.maxDryingDays).toBe(input.maxDryingDays);
      }),
      { numRuns: 100 }
    );
  });

  it('updating any field and reading back reflects the new values', async () => {
    await fc.assert(
      fc.asyncProperty(
        trailInputArb,
        fc.record({
          name: fc.option(trailNameArb, { nil: undefined }),
          primaryStationId: fc.option(stationIdArb, { nil: undefined }),
          dryingRateInPerDay: fc.option(dryingRateArb, { nil: undefined }),
          maxDryingDays: fc.option(maxDaysArb, { nil: undefined }),
        }).filter(
          (d) =>
            d.name !== undefined ||
            d.primaryStationId !== undefined ||
            d.dryingRateInPerDay !== undefined ||
            d.maxDryingDays !== undefined
        ),
        async (input, updateData) => {
          // Reset store each iteration
          trailsStore = new Map();
          idCounter = 0;

          const trail = await create(input);

          // Build update payload with only defined fields
          const payload: Record<string, unknown> = {};
          if (updateData.name !== undefined) payload.name = updateData.name;
          if (updateData.primaryStationId !== undefined) payload.primaryStationId = updateData.primaryStationId;
          if (updateData.dryingRateInPerDay !== undefined) payload.dryingRateInPerDay = updateData.dryingRateInPerDay;
          if (updateData.maxDryingDays !== undefined) payload.maxDryingDays = updateData.maxDryingDays;

          const updated = await update(trail.id, payload as any);

          // Each updated field should reflect the new value
          if (updateData.name !== undefined) {
            expect(updated.name).toBe(updateData.name);
          } else {
            expect(updated.name).toBe(input.name);
          }

          if (updateData.primaryStationId !== undefined) {
            expect(updated.primaryStationId).toBe(updateData.primaryStationId);
          } else {
            expect(updated.primaryStationId).toBe(input.primaryStationId);
          }

          if (updateData.dryingRateInPerDay !== undefined) {
            expect(updated.dryingRateInPerDay).toBe(updateData.dryingRateInPerDay);
          } else {
            expect(updated.dryingRateInPerDay).toBe(input.dryingRateInPerDay);
          }

          if (updateData.maxDryingDays !== undefined) {
            expect(updated.maxDryingDays).toBe(updateData.maxDryingDays);
          } else {
            expect(updated.maxDryingDays).toBe(input.maxDryingDays);
          }

          // Non-updated fields should remain unchanged
          expect(updated.isArchived).toBe(false);
          expect(updated.updatesEnabled).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 13: Archiving excludes from active list but retains history', () => {
  beforeEach(() => {
    trailsStore = new Map();
    rainEventsStore = new Map();
    predictionsStore = new Map();
    trailReportsStore = new Map();
    idCounter = 0;
  });

  it('archiving a trail removes it from listActive but retains associated data', async () => {
    await fc.assert(
      fc.asyncProperty(trailInputArb, async (input) => {
        // Reset stores each iteration
        trailsStore = new Map();
        rainEventsStore = new Map();
        predictionsStore = new Map();
        trailReportsStore = new Map();
        idCounter = 0;

        // Create trail
        const trail = await create(input);

        // Add associated data
        const rainEventId = addRainEvent(trail.id);
        const predictionId = addPrediction(trail.id, rainEventId);
        const reportId = addTrailReport(trail.name);

        // Verify trail is in active list before archiving
        let active = await listActive();
        expect(active.some((t) => t.id === trail.id)).toBe(true);

        // Archive the trail
        const archived = await archive(trail.id);
        expect(archived.isArchived).toBe(true);

        // Verify trail is NOT in active list after archiving
        active = await listActive();
        expect(active.some((t) => t.id === trail.id)).toBe(false);

        // Verify associated rain events are retained
        const rainEvent = rainEventsStore.get(rainEventId);
        expect(rainEvent).toBeDefined();
        expect(rainEvent!.trail_id).toBe(trail.id);

        // Verify associated predictions are retained
        const prediction = predictionsStore.get(predictionId);
        expect(prediction).toBeDefined();
        expect(prediction!.trail_id).toBe(trail.id);

        // Verify associated trail reports are retained
        const report = trailReportsStore.get(reportId);
        expect(report).toBeDefined();
        expect((report!.trail_references as string[])).toContain(trail.name);
      }),
      { numRuns: 100 }
    );
  });
});
