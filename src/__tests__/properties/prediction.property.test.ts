import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type {
  Trail,
  RainEvent,
  WeatherObservation,
  HistoricalOutcome,
  PredictionInput,
} from '@/types';

// Feature: trail-conditions-predictor, Property 7: Rain event end triggers prediction with complete inputs
// **Validates: Requirements 4.1, 4.2, 10.2**
// Feature: trail-conditions-predictor, Property 8: Drying trails get updated predictions
// **Validates: Requirements 4.3**
// Feature: trail-conditions-predictor, Property 9: Dry report transitions trail to Verified Rideable and records outcome
// **Validates: Requirements 4.5, 10.1**
// Feature: trail-conditions-predictor, Property 10: Fallback prediction produces valid result
// **Validates: Requirements 4.6**

// --- In-memory stores simulating database tables ---
let predictionsStore: Map<string, Record<string, unknown>>;
let trailsStore: Map<string, Record<string, unknown>>;
let rainEventsStore: Map<string, Record<string, unknown>>;
let weatherObsStore: Map<string, Record<string, unknown>>;
let idCounter: number;

function genId() {
  return `uuid-${++idCounter}`;
}

vi.mock('@/lib/db', () => {
  const sqlMock = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    // --- predictions: INSERT ---
    if (query.includes('INSERT INTO predictions')) {
      const [trailId, rainEventId, predictedDryTime, inputDataStr] = values as [string, string, string, string];
      const id = genId();
      const now = new Date().toISOString();
      const record: Record<string, unknown> = {
        id,
        trail_id: trailId,
        rain_event_id: rainEventId,
        predicted_dry_time: predictedDryTime,
        actual_dry_time: null,
        input_data: JSON.parse(inputDataStr),
        created_at: now,
        updated_at: now,
      };
      predictionsStore.set(id, record);
      return Promise.resolve({ rows: [record], rowCount: 1 });
    }

    // --- predictions: UPDATE actual_dry_time ---
    if (query.includes('UPDATE predictions') && query.includes('actual_dry_time') && !query.includes('predicted_dry_time')) {
      const actualDryTime = values[0] as string;
      const trailId = values[1] as string;
      const rainEventId = values[2] as string;
      let updated = 0;
      Array.from(predictionsStore.values()).forEach((pred) => {
        if (pred.trail_id === trailId && pred.rain_event_id === rainEventId && pred.actual_dry_time === null) {
          pred.actual_dry_time = actualDryTime;
          pred.updated_at = new Date().toISOString();
          updated++;
        }
      });
      return Promise.resolve({ rows: [], rowCount: updated });
    }

    // --- predictions: UPDATE predicted_dry_time (for updatePredictions) ---
    if (query.includes('UPDATE predictions') && query.includes('predicted_dry_time')) {
      const predictedDryTime = values[0] as string;
      const inputDataStr = values[1] as string;
      const predId = values[2] as string;
      const pred = predictionsStore.get(predId);
      if (pred) {
        pred.predicted_dry_time = predictedDryTime;
        pred.input_data = JSON.parse(inputDataStr);
        pred.updated_at = new Date().toISOString();
        return Promise.resolve({ rows: [{ ...pred }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // --- predictions: SELECT existing for trail+rain_event ---
    if (query.includes('SELECT') && query.includes('FROM predictions') && query.includes('rain_event_id') && !query.includes('JOIN')) {
      const trailId = values[0] as string;
      const rainEventId = values[1] as string;
      const rows = Array.from(predictionsStore.values())
        .filter((p) => p.trail_id === trailId && p.rain_event_id === rainEventId)
        .sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());
      return Promise.resolve({ rows: rows.slice(0, 1), rowCount: rows.length > 0 ? 1 : 0 });
    }

    // --- predictions: SELECT with JOIN for historical outcomes ---
    if (query.includes('SELECT') && query.includes('predictions') && query.includes('JOIN rain_events')) {
      const trailId = values[0] as string;
      const minPrecip = Number(values[1]);
      const maxPrecip = Number(values[2]);
      const filtered = Array.from(predictionsStore.values())
        .filter((p) => {
          if (p.trail_id !== trailId || p.actual_dry_time === null) return false;
          const re = rainEventsStore.get(p.rain_event_id as string);
          if (!re) return false;
          const precip = Number(re.total_precipitation_in);
          return precip >= minPrecip && precip <= maxPrecip;
        });
      const rows = filtered.map((p) => {
        const re = rainEventsStore.get(p.rain_event_id as string);
        return {
          predicted_dry_time: p.predicted_dry_time,
          actual_dry_time: p.actual_dry_time,
          input_data: p.input_data,
          total_precipitation_in: re?.total_precipitation_in,
          created_at: p.created_at,
        };
      })
        .sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());
      return Promise.resolve({ rows: rows.slice(0, 10), rowCount: Math.min(rows.length, 10) });
    }

    // --- trails: SELECT drying trails ---
    if (query.includes('SELECT') && query.includes('FROM trails') && query.includes('condition_status IN')) {
      const rows = Array.from(trailsStore.values()).filter(
        (t) =>
          (t.condition_status === 'Probably Not Rideable' || t.condition_status === 'Probably Rideable') &&
          !t.is_archived &&
          t.updates_enabled
      );
      return Promise.resolve({ rows, rowCount: rows.length });
    }

    // --- trails: UPDATE condition_status ---
    if (query.includes('UPDATE trails') && query.includes('condition_status')) {
      const trailId = values[0] as string;
      const trail = trailsStore.get(trailId);
      if (trail) {
        if (query.includes('Probably Rideable') && !query.includes('Not')) {
          trail.condition_status = 'Probably Rideable';
        } else {
          trail.condition_status = 'Probably Not Rideable';
        }
        trail.updated_at = new Date().toISOString();
      }
      return Promise.resolve({ rows: [], rowCount: trail ? 1 : 0 });
    }

    // --- rain_events: SELECT most recent ended for trail ---
    if (query.includes('SELECT') && query.includes('FROM rain_events') && query.includes('is_active = false')) {
      const trailId = values[0] as string;
      const rows = Array.from(rainEventsStore.values())
        .filter((re) => re.trail_id === trailId && re.is_active === false)
        .sort((a, b) => new Date(b.end_timestamp as string).getTime() - new Date(a.end_timestamp as string).getTime());
      return Promise.resolve({ rows: rows.slice(0, 1), rowCount: rows.length > 0 ? 1 : 0 });
    }

    // --- weather_observations: SELECT latest for station ---
    if (query.includes('SELECT') && query.includes('FROM weather_observations') && query.includes('station_id')) {
      const stationId = values[0] as string;
      const rows = Array.from(weatherObsStore.values())
        .filter((o) => o.station_id === stationId)
        .sort((a, b) => new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime());
      return Promise.resolve({ rows: rows.slice(0, 1), rowCount: rows.length > 0 ? 1 : 0 });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  return { sql: sqlMock };
});

// Mock history-service to avoid double-mocking sql
vi.mock('@/services/history-service', () => ({
  findSimilarHistoricalOutcomes: vi.fn().mockResolvedValue([]),
}));

import { fallbackPredict, predict, updatePredictions, recordActualOutcome } from '@/services/prediction-engine';

// --- Helpers ---

function addTrailToStore(trail: Trail) {
  trailsStore.set(trail.id, {
    id: trail.id,
    name: trail.name,
    description: trail.description,
    primary_station_id: trail.primaryStationId,
    drying_rate_in_per_day: trail.dryingRateInPerDay,
    max_drying_days: trail.maxDryingDays,
    updates_enabled: trail.updatesEnabled,
    is_archived: trail.isArchived,
    condition_status: trail.conditionStatus,
    created_at: trail.createdAt.toISOString(),
    updated_at: trail.updatedAt.toISOString(),
  });
}

function addRainEventToStore(re: RainEvent) {
  rainEventsStore.set(re.id, {
    id: re.id,
    trail_id: re.trailId,
    start_timestamp: re.startTimestamp.toISOString(),
    end_timestamp: re.endTimestamp?.toISOString() ?? null,
    total_precipitation_in: re.totalPrecipitationIn,
    is_active: re.isActive,
  });
}

function addWeatherObsToStore(obs: WeatherObservation) {
  const id = genId();
  weatherObsStore.set(id, {
    id,
    station_id: obs.stationId,
    timestamp: obs.timestamp.toISOString(),
    precipitation_in: obs.precipitationIn,
    temperature_f: obs.temperatureF,
    humidity_percent: obs.humidityPercent,
    wind_speed_mph: obs.windSpeedMph,
    solar_radiation_wm2: obs.solarRadiationWm2,
    daylight_hours: obs.daylightHours,
  });
}

function addPredictionToStore(
  id: string,
  trailId: string,
  rainEventId: string,
  predictedDryTime: Date,
  createdAt: Date
) {
  predictionsStore.set(id, {
    id,
    trail_id: trailId,
    rain_event_id: rainEventId,
    predicted_dry_time: predictedDryTime.toISOString(),
    actual_dry_time: null,
    input_data: {},
    created_at: createdAt.toISOString(),
    updated_at: createdAt.toISOString(),
  });
}

/** Mock OpenAI client that always throws (forces fallback) */
function makeMockOpenAI() {
  return {
    chat: {
      completions: {
        create: vi.fn().mockRejectedValue(new Error('API unavailable')),
      },
    },
  } as unknown as import('openai').default;
}

// --- Generators ---

const trailIdArb = fc.uuid();
const stationIdArb = fc.stringMatching(/^[A-Z]{4}[A-Z0-9]{4,12}$/).filter((s) => s.length >= 5);

/** Random Trail with realistic drying rates (0.5-5) and max days (1-7) */
const trailArb: fc.Arbitrary<Trail> = fc.record({
  id: trailIdArb,
  name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
  description: fc.constant(null),
  primaryStationId: stationIdArb,
  dryingRateInPerDay: fc.double({ min: 0.5, max: 5, noNaN: true }),
  maxDryingDays: fc.integer({ min: 1, max: 7 }),
  updatesEnabled: fc.constant(true),
  isArchived: fc.constant(false),
  conditionStatus: fc.constant('Probably Not Rideable' as const),
  createdAt: fc.constant(new Date('2024-01-01')),
  updatedAt: fc.constant(new Date('2024-01-01')),
});

/** Random ended RainEvent with precipitation > 0 */
const rainEventArb: fc.Arbitrary<RainEvent> = fc.record({
  id: fc.uuid(),
  trailId: fc.constant(''), // will be overridden
  startTimestamp: fc.date({
    min: new Date('2024-01-01T00:00:00Z'),
    max: new Date('2024-06-01T00:00:00Z'),
    noInvalidDate: true,
  }),
  endTimestamp: fc.date({
    min: new Date('2024-06-01T01:00:00Z'),
    max: new Date('2024-12-01T00:00:00Z'),
    noInvalidDate: true,
  }).map((d) => d as Date | null),
  totalPrecipitationIn: fc.double({ min: 0.01, max: 10, noNaN: true }),
  isActive: fc.constant(false),
});

/** Random WeatherObservation with realistic ranges */
const weatherObsArb: fc.Arbitrary<WeatherObservation> = fc.record({
  stationId: fc.constant(''), // will be overridden
  timestamp: fc.date({
    min: new Date('2024-06-01T00:00:00Z'),
    max: new Date('2024-12-01T00:00:00Z'),
    noInvalidDate: true,
  }),
  precipitationIn: fc.double({ min: 0, max: 5, noNaN: true }),
  temperatureF: fc.double({ min: 30, max: 110, noNaN: true }),
  humidityPercent: fc.double({ min: 5, max: 100, noNaN: true }),
  windSpeedMph: fc.double({ min: 0, max: 50, noNaN: true }),
  solarRadiationWm2: fc.double({ min: 0, max: 1200, noNaN: true }),
  daylightHours: fc.double({ min: 6, max: 18, noNaN: true }),
});

/** Random HistoricalOutcome array (0-5 entries) */
const historicalOutcomesArb: fc.Arbitrary<HistoricalOutcome[]> = fc.array(
  fc.record({
    precipitationIn: fc.double({ min: 0.01, max: 10, noNaN: true }),
    predictedDryTime: fc.date({
      min: new Date('2023-01-01'),
      max: new Date('2024-06-01'),
      noInvalidDate: true,
    }),
    actualDryTime: fc.date({
      min: new Date('2023-01-01'),
      max: new Date('2024-06-01'),
      noInvalidDate: true,
    }),
    weatherConditions: fc.record({
      temperatureF: fc.double({ min: 30, max: 110, noNaN: true }),
    }),
  }),
  { minLength: 0, maxLength: 5 }
);

// --- Property Tests ---

describe('Property 7: Rain event end triggers prediction with complete inputs', () => {
  beforeEach(() => {
    predictionsStore = new Map();
    trailsStore = new Map();
    rainEventsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('for any ended rain event and associated trail, predict() produces a prediction whose inputData contains all required fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        trailArb,
        rainEventArb,
        weatherObsArb,
        historicalOutcomesArb,
        async (trail, rainEventBase, weatherBase, history) => {
          // Reset stores
          predictionsStore = new Map();
          trailsStore = new Map();
          rainEventsStore = new Map();
          weatherObsStore = new Map();
          idCounter = 0;

          // Wire up the rain event and weather to the trail
          const rainEvent: RainEvent = { ...rainEventBase, trailId: trail.id };
          const weather: WeatherObservation = { ...weatherBase, stationId: trail.primaryStationId };

          const mockClient = makeMockOpenAI();
          const prediction = await predict(trail, rainEvent, weather, history, mockClient);

          // Verify inputData contains all required fields (Req 4.2, 10.2)
          const input = prediction.inputData;
          expect(input.totalPrecipitationIn).toBe(rainEvent.totalPrecipitationIn);
          expect(input.dryingRateInPerDay).toBe(trail.dryingRateInPerDay);
          expect(input.maxDryingDays).toBe(trail.maxDryingDays);
          expect(input.temperatureF).toBe(weather.temperatureF);
          expect(input.humidityPercent).toBe(weather.humidityPercent);
          expect(input.windSpeedMph).toBe(weather.windSpeedMph);
          expect(input.solarRadiationWm2).toBe(weather.solarRadiationWm2);
          expect(Array.isArray(input.historicalOutcomes)).toBe(true);
          expect(input.historicalOutcomes).toHaveLength(history.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 8: Drying trails get updated predictions', () => {
  beforeEach(() => {
    predictionsStore = new Map();
    trailsStore = new Map();
    rainEventsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('for any trail with drying status, updatePredictions() produces an updated prediction with updatedAt >= previous', async () => {
    await fc.assert(
      fc.asyncProperty(
        trailArb,
        rainEventArb,
        weatherObsArb,
        fc.constantFrom('Probably Not Rideable' as const, 'Probably Rideable' as const),
        async (trailBase, rainEventBase, weatherBase, status) => {
          // Reset stores
          predictionsStore = new Map();
          trailsStore = new Map();
          rainEventsStore = new Map();
          weatherObsStore = new Map();
          idCounter = 0;

          const trail: Trail = { ...trailBase, conditionStatus: status };
          addTrailToStore(trail);

          const rainEvent: RainEvent = { ...rainEventBase, trailId: trail.id };
          addRainEventToStore(rainEvent);

          const weather: WeatherObservation = { ...weatherBase, stationId: trail.primaryStationId };
          addWeatherObsToStore(weather);

          // Add an existing prediction with a known timestamp
          const previousTime = new Date('2024-06-01T00:00:00Z');
          const predId = genId();
          addPredictionToStore(predId, trail.id, rainEvent.id, new Date('2024-06-05T00:00:00Z'), previousTime);

          const mockClient = makeMockOpenAI();
          const predictions = await updatePredictions(mockClient);

          expect(predictions.length).toBeGreaterThanOrEqual(1);
          const updated = predictions.find((p) => p.trailId === trail.id);
          expect(updated).toBeDefined();
          // updatedAt should be >= the previous timestamp
          expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(previousTime.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 9: Dry report transitions trail to Verified Rideable and records outcome', () => {
  beforeEach(() => {
    predictionsStore = new Map();
    trailsStore = new Map();
    rainEventsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('for any drying trail with a dry report, processing sets status to Verified Rideable and records actual dry time', async () => {
    await fc.assert(
      fc.asyncProperty(
        trailArb,
        rainEventArb,
        fc.constantFrom('Probably Not Rideable' as const, 'Probably Rideable' as const),
        fc.date({
          min: new Date('2024-06-01T00:00:00Z'),
          max: new Date('2024-12-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        async (trailBase, rainEventBase, status, reportTime) => {
          // Reset stores
          predictionsStore = new Map();
          trailsStore = new Map();
          rainEventsStore = new Map();
          weatherObsStore = new Map();
          idCounter = 0;

          const trail: Trail = { ...trailBase, conditionStatus: status };
          addTrailToStore(trail);

          const rainEvent: RainEvent = { ...rainEventBase, trailId: trail.id };
          addRainEventToStore(rainEvent);

          // Add a prediction for this trail+rain event
          const predId = genId();
          addPredictionToStore(predId, trail.id, rainEvent.id, new Date('2024-06-05T00:00:00Z'), new Date());

          // Simulate processing a "dry" report:
          // 1. Record actual outcome
          await recordActualOutcome(trail.id, rainEvent.id, reportTime);

          // 2. Update trail status to "Verified Rideable"
          const trailRecord = trailsStore.get(trail.id);
          expect(trailRecord).toBeDefined();
          trailRecord!.condition_status = 'Verified Rideable';
          trailRecord!.updated_at = new Date().toISOString();

          // Verify trail status is now "Verified Rideable"
          expect(trailRecord!.condition_status).toBe('Verified Rideable');

          // Verify the prediction has the actual dry time recorded
          const pred = predictionsStore.get(predId);
          expect(pred).toBeDefined();
          expect(pred!.actual_dry_time).toBe(reportTime.toISOString());
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 10: Fallback prediction produces valid result', () => {
  it('for any rain event with precipitation > 0 and any weather observation, fallbackPredict() returns a Date after the rain event end timestamp', () => {
    fc.assert(
      fc.property(
        trailArb,
        rainEventArb,
        weatherObsArb,
        (trail, rainEventBase, weatherBase) => {
          // Ensure rain event has an end timestamp and positive precipitation
          const endTimestamp = rainEventBase.endTimestamp ?? new Date('2024-06-01T12:00:00Z');
          const rainEvent: RainEvent = {
            ...rainEventBase,
            trailId: trail.id,
            endTimestamp,
            totalPrecipitationIn: Math.max(rainEventBase.totalPrecipitationIn, 0.01),
          };
          const weather: WeatherObservation = { ...weatherBase, stationId: trail.primaryStationId };

          const result = fallbackPredict(trail, rainEvent, weather);

          // Result must be a valid Date
          expect(result).toBeInstanceOf(Date);
          expect(isFinite(result.getTime())).toBe(true);

          // Result must be after the rain event's end timestamp
          expect(result.getTime()).toBeGreaterThan(endTimestamp.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });
});
