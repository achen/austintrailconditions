import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Trail, SeedTrail } from '@/types';

// --- In-memory store simulating the trails table ---
let trailsStore: Map<string, Record<string, unknown>>;
let idCounter: number;

function genId() {
  return `uuid-${++idCounter}`;
}

vi.mock('@/lib/db', () => {
  const sqlMock = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    // --- INSERT INTO trails ... RETURNING * ---
    if (query.includes('INSERT INTO trails') && query.includes('RETURNING')) {
      const [name, description, stationId, rate, maxDays] = values as [string, string | null, string, number, number];
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

    // --- INSERT INTO trails ... ON CONFLICT (name) DO NOTHING (seed) ---
    if (query.includes('INSERT INTO trails') && query.includes('ON CONFLICT')) {
      const [name, stationId, rate, maxDays, updatesEnabled] = values as [string, string, number, number, boolean];
      // Check if name already exists
      const existing = Array.from(trailsStore.values()).find((t) => t.name === name);
      if (existing) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const id = genId();
      const now = new Date().toISOString();
      const record: Record<string, unknown> = {
        id,
        name,
        description: null,
        primary_station_id: stationId,
        drying_rate_in_per_day: rate,
        max_drying_days: maxDays,
        updates_enabled: updatesEnabled,
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

    // --- UPDATE trails SET ... (general update) ---
    if (query.includes('UPDATE trails') && query.includes('RETURNING')) {
      // Values order: hasName, name, hasDesc, desc, hasStation, station, hasRate, rate, hasMaxDays, maxDays, hasUpdates, updates, id
      const [hasName, name, hasDesc, desc, hasStation, station, hasRate, rate, hasMaxDays, maxDays, hasUpdates, updates, id] =
        values as [boolean, string | null, boolean, string | null, boolean, string | null, boolean, number | null, boolean, number | null, boolean, boolean | null, string];
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

import { create, update, archive, listActive, seed } from '@/services/trail-service';

beforeEach(() => {
  trailsStore = new Map();
  idCounter = 0;
});

describe('TrailService.create()', () => {
  it('creates a trail with default condition status "Predicted Dry"', async () => {
    const trail = await create({
      name: 'Test Trail',
      primaryStationId: 'STATION-1',
      dryingRateInPerDay: 2.5,
      maxDryingDays: 3,
    });

    expect(trail.name).toBe('Test Trail');
    expect(trail.primaryStationId).toBe('STATION-1');
    expect(trail.dryingRateInPerDay).toBe(2.5);
    expect(trail.maxDryingDays).toBe(3);
    expect(trail.conditionStatus).toBe('Predicted Dry');
    expect(trail.isArchived).toBe(false);
    expect(trail.updatesEnabled).toBe(true);
    expect(trail.description).toBeNull();
  });

  it('creates a trail with an optional description', async () => {
    const trail = await create({
      name: 'Described Trail',
      primaryStationId: 'STATION-2',
      dryingRateInPerDay: 1.0,
      maxDryingDays: 2,
      description: 'A nice trail',
    });

    expect(trail.description).toBe('A nice trail');
  });
});

describe('TrailService.update()', () => {
  it('updates the name of an existing trail', async () => {
    const trail = await create({
      name: 'Original',
      primaryStationId: 'STATION-1',
      dryingRateInPerDay: 2.5,
      maxDryingDays: 3,
    });

    const updated = await update(trail.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
  });

  it('updates multiple fields at once', async () => {
    const trail = await create({
      name: 'Multi',
      primaryStationId: 'STATION-1',
      dryingRateInPerDay: 2.5,
      maxDryingDays: 3,
    });

    const updated = await update(trail.id, {
      description: 'Updated desc',
      dryingRateInPerDay: 1.0,
      maxDryingDays: 5,
    });

    expect(updated.description).toBe('Updated desc');
    expect(updated.dryingRateInPerDay).toBe(1.0);
    expect(updated.maxDryingDays).toBe(5);
  });

  it('throws when trail not found', async () => {
    await expect(update('nonexistent-id', { name: 'Nope' })).rejects.toThrow('Trail not found');
  });

  it('can set updatesEnabled to false', async () => {
    const trail = await create({
      name: 'Toggle',
      primaryStationId: 'STATION-1',
      dryingRateInPerDay: 2.5,
      maxDryingDays: 3,
    });

    const updated = await update(trail.id, { updatesEnabled: false });
    expect(updated.updatesEnabled).toBe(false);
  });
});

describe('TrailService.archive()', () => {
  it('sets is_archived to true', async () => {
    const trail = await create({
      name: 'Archivable',
      primaryStationId: 'STATION-1',
      dryingRateInPerDay: 2.5,
      maxDryingDays: 3,
    });

    const archived = await archive(trail.id);
    expect(archived.isArchived).toBe(true);
  });

  it('throws when trail not found', async () => {
    await expect(archive('nonexistent-id')).rejects.toThrow('Trail not found');
  });
});

describe('TrailService.listActive()', () => {
  it('returns only non-archived trails', async () => {
    await create({ name: 'Active Trail', primaryStationId: 'S1', dryingRateInPerDay: 2, maxDryingDays: 3 });
    const toArchive = await create({ name: 'Archived Trail', primaryStationId: 'S2', dryingRateInPerDay: 1, maxDryingDays: 2 });
    await archive(toArchive.id);

    const active = await listActive();
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('Active Trail');
  });

  it('returns empty array when no trails exist', async () => {
    const active = await listActive();
    expect(active).toEqual([]);
  });

  it('returns trails sorted by name', async () => {
    await create({ name: 'Zebra Trail', primaryStationId: 'S1', dryingRateInPerDay: 2, maxDryingDays: 3 });
    await create({ name: 'Alpha Trail', primaryStationId: 'S2', dryingRateInPerDay: 1, maxDryingDays: 2 });

    const active = await listActive();
    expect(active[0].name).toBe('Alpha Trail');
    expect(active[1].name).toBe('Zebra Trail');
  });
});

describe('TrailService.seed()', () => {
  it('inserts trails that do not exist', async () => {
    const seedData: SeedTrail[] = [
      { name: 'Trail A', primaryStationId: 'S1', dryingRateInPerDay: 2, maxDryingDays: 3, updatesEnabled: true },
      { name: 'Trail B', primaryStationId: 'S2', dryingRateInPerDay: 1, maxDryingDays: 2, updatesEnabled: false },
    ];

    await seed(seedData);

    const active = await listActive();
    expect(active).toHaveLength(2);
  });

  it('is idempotent — does not duplicate on second call', async () => {
    const seedData: SeedTrail[] = [
      { name: 'Trail A', primaryStationId: 'S1', dryingRateInPerDay: 2, maxDryingDays: 3, updatesEnabled: true },
    ];

    await seed(seedData);
    await seed(seedData);

    const active = await listActive();
    expect(active).toHaveLength(1);
  });
});
