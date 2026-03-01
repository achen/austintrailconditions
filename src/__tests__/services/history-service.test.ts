import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PredictionInput } from '@/types';

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
          // Temperature filter from input_data
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

// --- Tests ---

describe('findSimilarHistoricalOutcomes', () => {
  beforeEach(() => {
    predictionsStore = new Map();
    rainEventsStore = new Map();
  });

  it('returns empty array when no historical data exists', async () => {
    const results = await findSimilarHistoricalOutcomes('trail-1', 1.0, 85);
    expect(results).toEqual([]);
  });

  it('returns matching outcomes within precipitation and temperature range', async () => {
    addRainEvent({ id: 're-1', trailId: 'trail-1', totalPrecipitationIn: 1.2 });
    addPrediction({
      id: 'pred-1',
      trailId: 'trail-1',
      rainEventId: 're-1',
      predictedDryTime: '2024-06-02T12:00:00Z',
      actualDryTime: '2024-06-02T14:00:00Z',
      inputData: { temperatureF: 82, humidityPercent: 55, windSpeedMph: 8 },
      createdAt: '2024-06-01T12:00:00Z',
    });

    const results = await findSimilarHistoricalOutcomes('trail-1', 1.0, 85);

    expect(results).toHaveLength(1);
    expect(results[0].precipitationIn).toBe(1.2);
    expect(results[0].predictedDryTime).toEqual(new Date('2024-06-02T12:00:00Z'));
    expect(results[0].actualDryTime).toEqual(new Date('2024-06-02T14:00:00Z'));
    expect(results[0].weatherConditions.temperatureF).toBe(82);
  });

  it('excludes predictions without actual_dry_time', async () => {
    addRainEvent({ id: 're-1', trailId: 'trail-1', totalPrecipitationIn: 1.0 });
    addPrediction({
      id: 'pred-1',
      trailId: 'trail-1',
      rainEventId: 're-1',
      predictedDryTime: '2024-06-02T12:00:00Z',
      actualDryTime: null, // not completed
      inputData: { temperatureF: 85 },
      createdAt: '2024-06-01T12:00:00Z',
    });

    const results = await findSimilarHistoricalOutcomes('trail-1', 1.0, 85);
    expect(results).toHaveLength(0);
  });

  it('excludes events outside precipitation range (±0.5 in)', async () => {
    addRainEvent({ id: 're-1', trailId: 'trail-1', totalPrecipitationIn: 3.0 });
    addPrediction({
      id: 'pred-1',
      trailId: 'trail-1',
      rainEventId: 're-1',
      predictedDryTime: '2024-06-02T12:00:00Z',
      actualDryTime: '2024-06-02T14:00:00Z',
      inputData: { temperatureF: 85 },
      createdAt: '2024-06-01T12:00:00Z',
    });

    // Querying for 1.0 in — 3.0 is outside ±0.5
    const results = await findSimilarHistoricalOutcomes('trail-1', 1.0, 85);
    expect(results).toHaveLength(0);
  });

  it('excludes events outside temperature range (±10°F)', async () => {
    addRainEvent({ id: 're-1', trailId: 'trail-1', totalPrecipitationIn: 1.0 });
    addPrediction({
      id: 'pred-1',
      trailId: 'trail-1',
      rainEventId: 're-1',
      predictedDryTime: '2024-06-02T12:00:00Z',
      actualDryTime: '2024-06-02T14:00:00Z',
      inputData: { temperatureF: 60 }, // 85 - 60 = 25, outside ±10
      createdAt: '2024-06-01T12:00:00Z',
    });

    const results = await findSimilarHistoricalOutcomes('trail-1', 1.0, 85);
    expect(results).toHaveLength(0);
  });

  it('excludes events for different trails', async () => {
    addRainEvent({ id: 're-1', trailId: 'trail-2', totalPrecipitationIn: 1.0 });
    addPrediction({
      id: 'pred-1',
      trailId: 'trail-2',
      rainEventId: 're-1',
      predictedDryTime: '2024-06-02T12:00:00Z',
      actualDryTime: '2024-06-02T14:00:00Z',
      inputData: { temperatureF: 85 },
      createdAt: '2024-06-01T12:00:00Z',
    });

    const results = await findSimilarHistoricalOutcomes('trail-1', 1.0, 85);
    expect(results).toHaveLength(0);
  });

  it('returns results ordered by most recent first', async () => {
    addRainEvent({ id: 're-1', trailId: 'trail-1', totalPrecipitationIn: 1.0 });
    addRainEvent({ id: 're-2', trailId: 'trail-1', totalPrecipitationIn: 1.1 });

    addPrediction({
      id: 'pred-1',
      trailId: 'trail-1',
      rainEventId: 're-1',
      predictedDryTime: '2024-05-01T12:00:00Z',
      actualDryTime: '2024-05-01T14:00:00Z',
      inputData: { temperatureF: 83 },
      createdAt: '2024-05-01T12:00:00Z', // older
    });
    addPrediction({
      id: 'pred-2',
      trailId: 'trail-1',
      rainEventId: 're-2',
      predictedDryTime: '2024-06-01T12:00:00Z',
      actualDryTime: '2024-06-01T15:00:00Z',
      inputData: { temperatureF: 87 },
      createdAt: '2024-06-01T12:00:00Z', // newer
    });

    const results = await findSimilarHistoricalOutcomes('trail-1', 1.0, 85);

    expect(results).toHaveLength(2);
    // Most recent first
    expect(results[0].predictedDryTime).toEqual(new Date('2024-06-01T12:00:00Z'));
    expect(results[1].predictedDryTime).toEqual(new Date('2024-05-01T12:00:00Z'));
  });

  it('limits results to 10', async () => {
    // Create 15 matching events
    for (let i = 0; i < 15; i++) {
      addRainEvent({ id: `re-${i}`, trailId: 'trail-1', totalPrecipitationIn: 1.0 + i * 0.03 });
      addPrediction({
        id: `pred-${i}`,
        trailId: 'trail-1',
        rainEventId: `re-${i}`,
        predictedDryTime: `2024-06-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
        actualDryTime: `2024-06-${String(i + 1).padStart(2, '0')}T14:00:00Z`,
        inputData: { temperatureF: 85 },
        createdAt: `2024-06-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
      });
    }

    const results = await findSimilarHistoricalOutcomes('trail-1', 1.0, 85);
    expect(results).toHaveLength(10);
  });

  it('extracts weather conditions from input_data', async () => {
    addRainEvent({ id: 're-1', trailId: 'trail-1', totalPrecipitationIn: 1.0 });
    addPrediction({
      id: 'pred-1',
      trailId: 'trail-1',
      rainEventId: 're-1',
      predictedDryTime: '2024-06-02T12:00:00Z',
      actualDryTime: '2024-06-02T14:00:00Z',
      inputData: {
        temperatureF: 85,
        humidityPercent: 55,
        windSpeedMph: 10,
        solarRadiationWm2: 500,
        daylightHours: 14,
      },
      createdAt: '2024-06-01T12:00:00Z',
    });

    const results = await findSimilarHistoricalOutcomes('trail-1', 1.0, 85);

    expect(results[0].weatherConditions).toEqual({
      temperatureF: 85,
      humidityPercent: 55,
      windSpeedMph: 10,
      solarRadiationWm2: 500,
      daylightHours: 14,
    });
  });
});
