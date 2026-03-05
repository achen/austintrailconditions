import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { WeatherObservation } from '@/types';

// Feature: trail-conditions-predictor, Property 5: Precipitation creates rain event with Wet status
// **Validates: Requirements 3.1, 3.4**
// Feature: trail-conditions-predictor, Property 6: Dry gap ends rain event
// **Validates: Requirements 3.2, 3.3**

// --- In-memory stores simulating database tables ---
let rainEventsStore: Map<string, Record<string, unknown>>;
let trailsStore: Map<string, Record<string, unknown>>;
let weatherObsStore: Map<string, Record<string, unknown>>;
let idCounter: number;

function genId() {
  return `uuid-${++idCounter}`;
}

vi.mock('@/lib/db', () => {
  const sqlMock = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    // --- trails queries ---
    if (query.includes('SELECT') && query.includes('FROM trails') && query.includes('primary_station_id')) {
      const stationId = values[0] as string;
      const rows = Array.from(trailsStore.values()).filter(
        (t) => t.primary_station_id === stationId && !t.is_archived
      );
      return Promise.resolve({ rows, rowCount: rows.length });
    }

    // --- rain_events: get active for trail ---
    if (query.includes('SELECT') && query.includes('FROM rain_events') && query.includes('is_active') && !query.includes('JOIN')) {
      const trailId = values[0] as string;
      const rows = Array.from(rainEventsStore.values()).filter(
        (re) => re.trail_id === trailId && re.is_active === true
      );
      return Promise.resolve({ rows: rows.slice(0, 1), rowCount: rows.length > 0 ? 1 : 0 });
    }

    // --- rain_events: UPDATE end event (is_active = false) ---
    if (query.includes('UPDATE rain_events') && query.includes('is_active = false')) {
      const endTs = values[0] as string;
      const eventId = values[1] as string;
      const event = rainEventsStore.get(eventId);
      if (event) {
        event.is_active = false;
        event.end_timestamp = endTs;
      }
      return Promise.resolve({ rows: event ? [{ ...event }] : [], rowCount: event ? 1 : 0 });
    }

    // --- rain_events: UPDATE extend (add precipitation) ---
    if (query.includes('UPDATE rain_events') && query.includes('total_precipitation_in = total_precipitation_in')) {
      const precip = Number(values[0]);
      const eventId = values[1] as string;
      const event = rainEventsStore.get(eventId);
      if (event) {
        event.total_precipitation_in = Number(event.total_precipitation_in) + precip;
        return Promise.resolve({ rows: [{ ...event }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // --- rain_events: INSERT ---
    if (query.includes('INSERT INTO rain_events')) {
      const [trailId, startTs, precip] = values as [string, string, number];
      const id = genId();
      const event: Record<string, unknown> = {
        id,
        trail_id: trailId,
        start_timestamp: startTs,
        end_timestamp: null,
        total_precipitation_in: Number(precip),
        is_active: true,
      };
      rainEventsStore.set(id, event);
      return Promise.resolve({ rows: [event], rowCount: 1 });
    }

    // --- trails: UPDATE condition_status ---
    if (query.includes('UPDATE trails') && query.includes('condition_status')) {
      const trailId = values[0] as string;
      const trail = trailsStore.get(trailId);
      if (trail) {
        trail.condition_status = 'Predicted Not Rideable';
        trail.updated_at = new Date().toISOString();
      }
      return Promise.resolve({ rows: [], rowCount: trail ? 1 : 0 });
    }

    // --- active rain events with JOIN ---
    if (query.includes('SELECT') && query.includes('rain_events') && query.includes('JOIN trails')) {
      const rows = Array.from(rainEventsStore.values())
        .filter((re) => re.is_active === true)
        .map((re) => {
          const trail = trailsStore.get(re.trail_id as string);
          return { ...re, primary_station_id: trail?.primary_station_id };
        });
      return Promise.resolve({ rows, rowCount: rows.length });
    }

    // --- weather_observations: latest by station ---
    if (query.includes('SELECT') && query.includes('weather_observations') && query.includes('ORDER BY timestamp DESC') && !query.includes('precipitation_in > 0')) {
      const stationId = values[0] as string;
      const rows = Array.from(weatherObsStore.values())
        .filter((o) => o.station_id === stationId)
        .sort((a, b) => new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime());
      return Promise.resolve({ rows: rows.slice(0, 1), rowCount: rows.length > 0 ? 1 : 0 });
    }

    // --- weather_observations: latest with precipitation > 0 ---
    if (query.includes('SELECT') && query.includes('weather_observations') && query.includes('precipitation_in > 0')) {
      const stationId = values[0] as string;
      const rows = Array.from(weatherObsStore.values())
        .filter((o) => o.station_id === stationId && Number(o.precipitation_in) > 0)
        .sort((a, b) => new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime());
      return Promise.resolve({ rows: rows.slice(0, 1), rowCount: rows.length > 0 ? 1 : 0 });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  return { sql: sqlMock };
});

import { evaluate, checkForRainEnd } from '@/services/rain-detector';

// --- Helpers ---

function addTrail(id: string, stationId: string) {
  trailsStore.set(id, {
    id,
    primary_station_id: stationId,
    is_archived: false,
    condition_status: 'Predicted Rideable',
    updated_at: new Date().toISOString(),
  });
}

function addWeatherObs(stationId: string, timestamp: string, precipIn: number) {
  const id = genId();
  weatherObsStore.set(id, {
    id,
    station_id: stationId,
    timestamp,
    precipitation_in: precipIn,
  });
}

function addActiveRainEvent(id: string, trailId: string, startTs: string, totalPrecip: number) {
  rainEventsStore.set(id, {
    id,
    trail_id: trailId,
    start_timestamp: startTs,
    end_timestamp: null,
    total_precipitation_in: totalPrecip,
    is_active: true,
  });
}

// --- Generators ---

/** Random station ID: alphanumeric, non-empty */
const stationIdArb = fc.stringMatching(/^[A-Z]{4}[A-Z0-9]{4,12}$/).filter((s) => s.length >= 5);

/** Random trail ID: uuid-like */
const trailIdArb = fc.uuid();

/** Random precipitation amount > 0 (inches), realistic range */
const precipitationArb = fc.double({ min: 0.001, max: 10, noNaN: true });

/** Random time gap >= 60 minutes (in milliseconds) */
const dryGapMinutesArb = fc.integer({ min: 60, max: 1440 });

/** Base timestamp for observations */
const baseTimestampArb = fc.date({
  min: new Date('2020-01-01T00:00:00Z'),
  max: new Date('2030-01-01T00:00:00Z'),
  noInvalidDate: true,
});

// --- Property Tests ---

describe('Property 5: Precipitation creates rain event with Wet status', () => {
  beforeEach(() => {
    rainEventsStore = new Map();
    trailsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('for any observation with precipitation > 0 associated with a trail, evaluate() creates an active rain event and sets trail status to "Predicted Not Rideable"', async () => {
    await fc.assert(
      fc.asyncProperty(
        trailIdArb,
        stationIdArb,
        precipitationArb,
        baseTimestampArb,
        async (trailId, stationId, precip, timestamp) => {
          // Reset stores for each iteration
          rainEventsStore = new Map();
          trailsStore = new Map();
          weatherObsStore = new Map();
          idCounter = 0;

          // Set up a trail with the given station
          addTrail(trailId, stationId);

          const obs: WeatherObservation = {
            stationId,
            timestamp,
            precipitationIn: precip,
            temperatureF: 75,
            humidityPercent: 60,
            windSpeedMph: 5,
            solarRadiationWm2: 400,
            daylightHours: 14,
          };

          const events = await evaluate([obs]);

          // There should be at least one active rain event for this trail
          expect(events.length).toBeGreaterThanOrEqual(1);
          const trailEvent = events.find((e) => e.trailId === trailId);
          expect(trailEvent).toBeDefined();
          expect(trailEvent!.isActive).toBe(true);
          expect(trailEvent!.totalPrecipitationIn).toBeCloseTo(precip, 5);

          // Trail condition_status should be "Verified Not Rideable"
          const trail = trailsStore.get(trailId);
          expect(trail).toBeDefined();
          expect(trail!.condition_status).toBe('Verified Not Rideable');
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 6: Dry gap ends rain event', () => {
  beforeEach(() => {
    rainEventsStore = new Map();
    trailsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('for any sequence where the last 60+ minutes have zero precipitation, checkForRainEnd() ends the active rain event with correct total precipitation', async () => {
    await fc.assert(
      fc.asyncProperty(
        trailIdArb,
        stationIdArb,
        // Generate 1-5 rainy observations with random precipitation
        fc.array(precipitationArb, { minLength: 1, maxLength: 5 }),
        dryGapMinutesArb,
        baseTimestampArb,
        async (trailId, stationId, precipAmounts, dryGapMinutes, baseTime) => {
          // Reset stores for each iteration
          rainEventsStore = new Map();
          trailsStore = new Map();
          weatherObsStore = new Map();
          idCounter = 0;

          // Set up trail
          addTrail(trailId, stationId);

          // Calculate total precipitation from the rainy observations
          const totalPrecip = precipAmounts.reduce((sum, p) => sum + p, 0);

          // Create an active rain event with the total precipitation
          const eventId = `rain-event-${trailId}`;
          const rainStartTime = new Date(baseTime.getTime());
          addActiveRainEvent(eventId, trailId, rainStartTime.toISOString(), totalPrecip);

          // Add rainy weather observations spaced 10 minutes apart
          let currentTime = new Date(baseTime.getTime());
          for (const precip of precipAmounts) {
            addWeatherObs(stationId, currentTime.toISOString(), precip);
            currentTime = new Date(currentTime.getTime() + 10 * 60 * 1000); // +10 min
          }

          // The last rainy observation time
          const lastRainTime = new Date(currentTime.getTime() - 10 * 60 * 1000);

          // Add a dry observation at lastRainTime + dryGapMinutes (>= 60 min)
          const dryObsTime = new Date(lastRainTime.getTime() + dryGapMinutes * 60 * 1000);
          addWeatherObs(stationId, dryObsTime.toISOString(), 0);

          const ended = await checkForRainEnd();

          // The rain event should be ended
          expect(ended.length).toBeGreaterThanOrEqual(1);
          const endedEvent = ended.find((e) => e.trailId === trailId);
          expect(endedEvent).toBeDefined();
          expect(endedEvent!.isActive).toBe(false);
          expect(endedEvent!.endTimestamp).not.toBeNull();
          // Total precipitation should match the sum of all rainy observations
          expect(endedEvent!.totalPrecipitationIn).toBeCloseTo(totalPrecip, 5);
        }
      ),
      { numRuns: 100 }
    );
  });
});
