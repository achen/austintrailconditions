import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Trail, RainEvent, WeatherObservation, HistoricalOutcome } from '@/types';

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
    if (query.includes('UPDATE predictions') && query.includes('actual_dry_time')) {
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
          (t.condition_status === 'Predicted Wet' || t.condition_status === 'Predicted Dry') &&
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
        // Determine which status to set based on query content
        if (query.includes('Predicted Dry') && !query.includes('Wet')) {
          trail.condition_status = 'Predicted Dry';
        } else {
          trail.condition_status = 'Predicted Wet';
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

import { fallbackPredict, predict, updatePredictions, recordActualOutcome } from '@/services/prediction-engine';

// --- Helpers ---

function makeTrail(overrides: Partial<Trail> = {}): Trail {
  return {
    id: 'trail-1',
    name: 'Test Trail',
    description: null,
    primaryStationId: 'STATION-A',
    dryingRateInPerDay: 2.5,
    maxDryingDays: 3,
    updatesEnabled: true,
    isArchived: false,
    conditionStatus: 'Predicted Wet',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

function makeRainEvent(overrides: Partial<RainEvent> = {}): RainEvent {
  return {
    id: 'event-1',
    trailId: 'trail-1',
    startTimestamp: new Date('2024-06-01T10:00:00Z'),
    endTimestamp: new Date('2024-06-01T12:00:00Z'),
    totalPrecipitationIn: 1.0,
    isActive: false,
    ...overrides,
  };
}

function makeWeather(overrides: Partial<WeatherObservation> = {}): WeatherObservation {
  return {
    stationId: 'STATION-A',
    timestamp: new Date('2024-06-01T13:00:00Z'),
    precipitationIn: 0,
    temperatureF: 85,
    humidityPercent: 50,
    windSpeedMph: 10,
    solarRadiationWm2: 500,
    daylightHours: 14,
    ...overrides,
  };
}

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

// --- Tests ---

describe('PredictionEngine.fallbackPredict()', () => {
  it('returns a date after the rain event end time', () => {
    const trail = makeTrail();
    const rainEvent = makeRainEvent();
    const weather = makeWeather();

    const result = fallbackPredict(trail, rainEvent, weather);

    expect(result.getTime()).toBeGreaterThan(rainEvent.endTimestamp!.getTime());
  });

  it('returns at least 1 hour after rain event end', () => {
    const trail = makeTrail();
    const rainEvent = makeRainEvent({ totalPrecipitationIn: 0.01 });
    const weather = makeWeather({ humidityPercent: 1, windSpeedMph: 100, solarRadiationWm2: 3000 });

    const result = fallbackPredict(trail, rainEvent, weather);
    const diffHours = (result.getTime() - rainEvent.endTimestamp!.getTime()) / (1000 * 60 * 60);

    expect(diffHours).toBeGreaterThanOrEqual(1);
  });

  it('higher precipitation leads to longer drying time', () => {
    const trail = makeTrail();
    const weather = makeWeather();

    const lowRain = makeRainEvent({ totalPrecipitationIn: 0.5 });
    const highRain = makeRainEvent({ totalPrecipitationIn: 3.0 });

    const lowResult = fallbackPredict(trail, lowRain, weather);
    const highResult = fallbackPredict(trail, highRain, weather);

    expect(highResult.getTime()).toBeGreaterThan(lowResult.getTime());
  });

  it('higher humidity leads to longer drying time', () => {
    const trail = makeTrail();
    const rainEvent = makeRainEvent();

    const dryWeather = makeWeather({ humidityPercent: 20 });
    const humidWeather = makeWeather({ humidityPercent: 90 });

    const dryResult = fallbackPredict(trail, rainEvent, dryWeather);
    const humidResult = fallbackPredict(trail, rainEvent, humidWeather);

    expect(humidResult.getTime()).toBeGreaterThan(dryResult.getTime());
  });

  it('respects maxDryingDays cap', () => {
    const trail = makeTrail({ dryingRateInPerDay: 0.1, maxDryingDays: 2 });
    const rainEvent = makeRainEvent({ totalPrecipitationIn: 10 }); // would be 100 days without cap
    const weather = makeWeather({ humidityPercent: 50, windSpeedMph: 0, solarRadiationWm2: 0 });

    const result = fallbackPredict(trail, rainEvent, weather);
    const diffHours = (result.getTime() - rainEvent.endTimestamp!.getTime()) / (1000 * 60 * 60);

    // maxDryingDays=2 → max 48 hours base, adjusted by weather
    expect(diffHours).toBeLessThanOrEqual(48 + 1); // small tolerance
  });

  it('uses dryingRate=1 when trail has zero drying rate', () => {
    const trail = makeTrail({ dryingRateInPerDay: 0 });
    const rainEvent = makeRainEvent();
    const weather = makeWeather();

    // Should not throw or return Infinity
    const result = fallbackPredict(trail, rainEvent, weather);
    expect(result.getTime()).toBeGreaterThan(rainEvent.endTimestamp!.getTime());
    expect(isFinite(result.getTime())).toBe(true);
  });
});

describe('PredictionEngine.predict()', () => {
  beforeEach(() => {
    predictionsStore = new Map();
    trailsStore = new Map();
    rainEventsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('falls back to rule-based when OpenAI client throws', async () => {
    const trail = makeTrail();
    const rainEvent = makeRainEvent();
    const weather = makeWeather();

    // Create a mock OpenAI client that throws
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('API unavailable')),
        },
      },
    } as unknown as import('openai').default;

    const prediction = await predict(trail, rainEvent, weather, [], mockClient);

    expect(prediction.trailId).toBe('trail-1');
    expect(prediction.rainEventId).toBe('event-1');
    expect(prediction.predictedDryTime.getTime()).toBeGreaterThan(rainEvent.endTimestamp!.getTime());
    expect(prediction.inputData.totalPrecipitationIn).toBe(1.0);
    expect(prediction.inputData.historicalOutcomes).toEqual([]);
  });

  it('stores prediction with complete input data', async () => {
    const trail = makeTrail();
    const rainEvent = makeRainEvent();
    const weather = makeWeather();
    const history: HistoricalOutcome[] = [
      {
        precipitationIn: 0.8,
        predictedDryTime: new Date('2024-05-01T12:00:00Z'),
        actualDryTime: new Date('2024-05-01T14:00:00Z'),
        weatherConditions: { temperatureF: 80 },
      },
    ];

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"estimatedDryHours": 12}' } }],
          }),
        },
      },
    } as unknown as import('openai').default;

    const prediction = await predict(trail, rainEvent, weather, history, mockClient);

    expect(prediction.inputData.totalPrecipitationIn).toBe(1.0);
    expect(prediction.inputData.dryingRateInPerDay).toBe(2.5);
    expect(prediction.inputData.maxDryingDays).toBe(3);
    expect(prediction.inputData.temperatureF).toBe(85);
    expect(prediction.inputData.humidityPercent).toBe(50);
    expect(prediction.inputData.windSpeedMph).toBe(10);
    expect(prediction.inputData.solarRadiationWm2).toBe(500);
    expect(prediction.inputData.daylightHours).toBe(14);
    expect(prediction.inputData.historicalOutcomes).toHaveLength(1);
  });

  it('uses OpenAI response when valid', async () => {
    const trail = makeTrail();
    const rainEvent = makeRainEvent();
    const weather = makeWeather();

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"estimatedDryHours": 24}' } }],
          }),
        },
      },
    } as unknown as import('openai').default;

    const prediction = await predict(trail, rainEvent, weather, [], mockClient);

    // Should be approximately 24 hours from now
    const diffHours = (prediction.predictedDryTime.getTime() - Date.now()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(23);
    expect(diffHours).toBeLessThan(25);
  });

  it('falls back when OpenAI returns invalid JSON', async () => {
    const trail = makeTrail();
    const rainEvent = makeRainEvent();
    const weather = makeWeather();

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'not valid json' } }],
          }),
        },
      },
    } as unknown as import('openai').default;

    const prediction = await predict(trail, rainEvent, weather, [], mockClient);

    // Should still produce a valid prediction via fallback
    expect(prediction.predictedDryTime.getTime()).toBeGreaterThan(rainEvent.endTimestamp!.getTime());
  });
});

describe('PredictionEngine.recordActualOutcome()', () => {
  beforeEach(() => {
    predictionsStore = new Map();
    trailsStore = new Map();
    rainEventsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('records actual dry time on the prediction', async () => {
    const now = new Date().toISOString();
    predictionsStore.set('pred-1', {
      id: 'pred-1',
      trail_id: 'trail-1',
      rain_event_id: 'event-1',
      predicted_dry_time: now,
      actual_dry_time: null,
      input_data: {},
      created_at: now,
      updated_at: now,
    });

    const actualTime = new Date('2024-06-02T10:00:00Z');
    await recordActualOutcome('trail-1', 'event-1', actualTime);

    const pred = predictionsStore.get('pred-1');
    expect(pred?.actual_dry_time).toBe(actualTime.toISOString());
  });

  it('does not overwrite existing actual dry time', async () => {
    const now = new Date().toISOString();
    predictionsStore.set('pred-1', {
      id: 'pred-1',
      trail_id: 'trail-1',
      rain_event_id: 'event-1',
      predicted_dry_time: now,
      actual_dry_time: '2024-06-01T08:00:00Z', // already set
      input_data: {},
      created_at: now,
      updated_at: now,
    });

    await recordActualOutcome('trail-1', 'event-1', new Date('2024-06-02T10:00:00Z'));

    const pred = predictionsStore.get('pred-1');
    expect(pred?.actual_dry_time).toBe('2024-06-01T08:00:00Z'); // unchanged
  });
});

describe('PredictionEngine.updatePredictions()', () => {
  beforeEach(() => {
    predictionsStore = new Map();
    trailsStore = new Map();
    rainEventsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('updates predictions for drying trails', async () => {
    const trail = makeTrail({ conditionStatus: 'Predicted Wet' });
    addTrailToStore(trail);

    const rainEvent = makeRainEvent();
    addRainEventToStore(rainEvent);

    const weather = makeWeather();
    addWeatherObsToStore(weather);

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('API unavailable')),
        },
      },
    } as unknown as import('openai').default;

    const predictions = await updatePredictions(mockClient);

    expect(predictions).toHaveLength(1);
    expect(predictions[0].trailId).toBe('trail-1');
    expect(predictions[0].predictedDryTime.getTime()).toBeGreaterThan(rainEvent.endTimestamp!.getTime());
  });

  it('skips archived trails', async () => {
    const trail = makeTrail({ isArchived: true, conditionStatus: 'Predicted Wet' });
    addTrailToStore(trail);

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('API unavailable')),
        },
      },
    } as unknown as import('openai').default;

    const predictions = await updatePredictions(mockClient);
    expect(predictions).toHaveLength(0);
  });

  it('skips trails with updates disabled', async () => {
    const trail = makeTrail({ updatesEnabled: false, conditionStatus: 'Predicted Wet' });
    addTrailToStore(trail);

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('API unavailable')),
        },
      },
    } as unknown as import('openai').default;

    const predictions = await updatePredictions(mockClient);
    expect(predictions).toHaveLength(0);
  });
});
