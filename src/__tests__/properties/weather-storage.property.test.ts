import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { WeatherObservation } from '@/types';

// Feature: trail-conditions-predictor, Property 1: Weather observation storage round-trip
// **Validates: Requirements 1.2**
// Feature: trail-conditions-predictor, Property 2: Weather observation idempotency
// **Validates: Requirements 1.5**

// In-memory store simulating the weather_observations table
let store: Map<string, Record<string, unknown>>;

// Mock @/lib/db before importing the service
vi.mock('@/lib/db', () => {
  const sqlMock = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    if (query.includes('INSERT INTO weather_observations')) {
      const [
        stationId,
        timestamp,
        precipitationIn,
        temperatureF,
        humidityPercent,
        windSpeedMph,
        solarRadiationWm2,
        daylightHours,
      ] = values;

      const key = `${stationId}::${timestamp}`;

      // ON CONFLICT DO NOTHING behavior
      if (store.has(key)) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      store.set(key, {
        station_id: stationId,
        timestamp,
        precipitation_in: Number(precipitationIn),
        temperature_f: Number(temperatureF),
        humidity_percent: Number(humidityPercent),
        wind_speed_mph: Number(windSpeedMph),
        solar_radiation_wm2: Number(solarRadiationWm2),
        daylight_hours: Number(daylightHours),
      });

      return Promise.resolve({ rowCount: 1, rows: [] });
    }

    if (query.includes('SELECT') && query.includes('weather_observations')) {
      const [stationId, timestamp] = values;
      const key = `${stationId}::${timestamp}`;
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
import { storeObservations } from '@/services/weather-collector';

/**
 * Helper to query the in-memory store by station ID and timestamp.
 */
function queryByStationAndTimestamp(
  stationId: string,
  timestamp: string
): Record<string, unknown> | undefined {
  const key = `${stationId}::${timestamp}`;
  return store.get(key);
}

/**
 * Generator for valid WeatherObservation objects with realistic ranges.
 */
const weatherObservationArb: fc.Arbitrary<WeatherObservation> = fc.record({
  stationId: fc.stringMatching(/^[a-zA-Z0-9]+$/).filter((s) => s.length > 0),
  timestamp: fc.date({
    min: new Date('2020-01-01T00:00:00Z'),
    max: new Date('2030-12-31T23:59:59Z'),
    noInvalidDate: true,
  }),
  precipitationIn: fc.double({ min: 0, max: 20, noNaN: true }),
  temperatureF: fc.double({ min: -20, max: 120, noNaN: true }),
  humidityPercent: fc.double({ min: 0, max: 100, noNaN: true }),
  windSpeedMph: fc.double({ min: 0, max: 100, noNaN: true }),
  solarRadiationWm2: fc.double({ min: 0, max: 1500, noNaN: true }),
  daylightHours: fc.double({ min: 0, max: 24, noNaN: true }),
});

describe('Property 1: Weather observation storage round-trip', () => {
  beforeEach(() => {
    store = new Map();
  });

  it('storing a weather observation and querying by station ID and timestamp returns all original field values', async () => {
    await fc.assert(
      fc.asyncProperty(weatherObservationArb, async (obs) => {
        const tsIso = obs.timestamp.toISOString();
        const key = `${obs.stationId}::${tsIso}`;

        // Skip if this key was already used in a prior iteration (avoids false negatives)
        if (store.has(key)) return;

        // Store the observation
        const count = await storeObservations([obs]);
        expect(count).toBe(1);

        // Query back by station ID and timestamp
        const row = queryByStationAndTimestamp(obs.stationId, tsIso);

        expect(row).toBeDefined();
        expect(row!.station_id).toBe(obs.stationId);
        expect(row!.timestamp).toBe(tsIso);
        expect(row!.precipitation_in).toBe(obs.precipitationIn);
        expect(row!.temperature_f).toBe(obs.temperatureF);
        expect(row!.humidity_percent).toBe(obs.humidityPercent);
        expect(row!.wind_speed_mph).toBe(obs.windSpeedMph);
        expect(row!.solar_radiation_wm2).toBe(obs.solarRadiationWm2);
        expect(row!.daylight_hours).toBe(obs.daylightHours);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 2: Weather observation idempotency', () => {
  beforeEach(() => {
    store = new Map();
  });

  it('calling storeObservations twice with the same observation results in exactly one record and no error on the second call', async () => {
    await fc.assert(
      fc.asyncProperty(weatherObservationArb, async (obs) => {
        const tsIso = obs.timestamp.toISOString();
        const key = `${obs.stationId}::${tsIso}`;

        // Skip if this key was already used in a prior iteration
        if (store.has(key)) return;

        // First call — should insert one record
        const firstCount = await storeObservations([obs]);
        expect(firstCount).toBe(1);

        // Second call with the same observation — should insert zero (ON CONFLICT DO NOTHING)
        const secondCount = await storeObservations([obs]);
        expect(secondCount).toBe(0);

        // Verify exactly one record exists for this key
        expect(store.has(key)).toBe(true);

        // Count entries for this specific stationId+timestamp to verify no duplicates were created
        let countForKey = 0;
        store.forEach((_value, k) => {
          if (k === key) {
            countForKey++;
          }
        });
        expect(countForKey).toBe(1);
      }),
      { numRuns: 100 }
    );
  });
});
