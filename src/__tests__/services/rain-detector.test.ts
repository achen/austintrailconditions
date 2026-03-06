import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeatherObservation } from '@/types';

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
    // Must check before the extend query since both contain total_precipitation_in in RETURNING
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
        trail.condition_status = 'Predicted Wet';
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
    condition_status: 'Predicted Dry',
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

// --- Tests ---

describe('RainDetector.evaluate()', () => {
  beforeEach(() => {
    rainEventsStore = new Map();
    trailsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('creates a new rain event when precipitation > 0 for a trail station', async () => {
    addTrail('trail-1', 'STATION-A');

    const obs: WeatherObservation = {
      stationId: 'STATION-A',
      timestamp: new Date('2024-06-01T12:00:00Z'),
      precipitationIn: 0.5,
      temperatureF: 75,
      humidityPercent: 60,
      windSpeedMph: 5,
      solarRadiationWm2: 400,
      daylightHours: 14,
    };

    const events = await evaluate([obs]);

    expect(events).toHaveLength(1);
    expect(events[0].trailId).toBe('trail-1');
    expect(events[0].totalPrecipitationIn).toBe(0.5);
    expect(events[0].isActive).toBe(true);
  });

  it('extends an existing active rain event with additional precipitation', async () => {
    addTrail('trail-1', 'STATION-A');
    addActiveRainEvent('event-1', 'trail-1', '2024-06-01T11:00:00Z', 0.3);

    const obs: WeatherObservation = {
      stationId: 'STATION-A',
      timestamp: new Date('2024-06-01T12:00:00Z'),
      precipitationIn: 0.2,
      temperatureF: 75,
      humidityPercent: 60,
      windSpeedMph: 5,
      solarRadiationWm2: 400,
      daylightHours: 14,
    };

    const events = await evaluate([obs]);

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('event-1');
    expect(events[0].totalPrecipitationIn).toBe(0.5); // 0.3 + 0.2
  });

  it('sets trail condition_status to "Predicted Wet" during rain', async () => {
    addTrail('trail-1', 'STATION-A');

    const obs: WeatherObservation = {
      stationId: 'STATION-A',
      timestamp: new Date('2024-06-01T12:00:00Z'),
      precipitationIn: 0.1,
      temperatureF: 75,
      humidityPercent: 60,
      windSpeedMph: 5,
      solarRadiationWm2: 400,
      daylightHours: 14,
    };

    await evaluate([obs]);

    const trail = trailsStore.get('trail-1');
    expect(trail?.condition_status).toBe('Predicted Wet');
  });

  it('ignores observations with zero precipitation', async () => {
    addTrail('trail-1', 'STATION-A');

    const obs: WeatherObservation = {
      stationId: 'STATION-A',
      timestamp: new Date('2024-06-01T12:00:00Z'),
      precipitationIn: 0,
      temperatureF: 75,
      humidityPercent: 60,
      windSpeedMph: 5,
      solarRadiationWm2: 400,
      daylightHours: 14,
    };

    const events = await evaluate([obs]);
    expect(events).toHaveLength(0);
  });

  it('creates rain events for multiple trails sharing the same station', async () => {
    addTrail('trail-1', 'STATION-A');
    addTrail('trail-2', 'STATION-A');

    const obs: WeatherObservation = {
      stationId: 'STATION-A',
      timestamp: new Date('2024-06-01T12:00:00Z'),
      precipitationIn: 0.4,
      temperatureF: 75,
      humidityPercent: 60,
      windSpeedMph: 5,
      solarRadiationWm2: 400,
      daylightHours: 14,
    };

    const events = await evaluate([obs]);
    expect(events).toHaveLength(2);
    const trailIds = events.map((e) => e.trailId).sort();
    expect(trailIds).toEqual(['trail-1', 'trail-2']);
  });
});

describe('RainDetector.checkForRainEnd()', () => {
  beforeEach(() => {
    rainEventsStore = new Map();
    trailsStore = new Map();
    weatherObsStore = new Map();
    idCounter = 0;
  });

  it('ends a rain event when 60+ minutes of zero precipitation have elapsed', async () => {
    addTrail('trail-1', 'STATION-A');
    addActiveRainEvent('event-1', 'trail-1', '2024-06-01T10:00:00Z', 1.0);

    // Last rainy observation at 11:00
    addWeatherObs('STATION-A', '2024-06-01T11:00:00Z', 0.2);
    // Dry observation at 12:01 (61 minutes later)
    addWeatherObs('STATION-A', '2024-06-01T12:01:00Z', 0);

    const ended = await checkForRainEnd();

    expect(ended).toHaveLength(1);
    expect(ended[0].id).toBe('event-1');
    expect(ended[0].isActive).toBe(false);
    expect(ended[0].endTimestamp).not.toBeNull();
  });

  it('does NOT end a rain event when less than 60 minutes of dry time', async () => {
    addTrail('trail-1', 'STATION-A');
    addActiveRainEvent('event-1', 'trail-1', '2024-06-01T10:00:00Z', 1.0);

    // Last rainy observation at 11:00
    addWeatherObs('STATION-A', '2024-06-01T11:00:00Z', 0.2);
    // Dry observation at 11:30 (only 30 minutes later)
    addWeatherObs('STATION-A', '2024-06-01T11:30:00Z', 0);

    const ended = await checkForRainEnd();
    expect(ended).toHaveLength(0);
  });

  it('ends a rain event at exactly 60 minutes of dry time', async () => {
    addTrail('trail-1', 'STATION-A');
    addActiveRainEvent('event-1', 'trail-1', '2024-06-01T10:00:00Z', 0.5);

    addWeatherObs('STATION-A', '2024-06-01T11:00:00Z', 0.1);
    addWeatherObs('STATION-A', '2024-06-01T12:00:00Z', 0); // exactly 60 min

    const ended = await checkForRainEnd();
    expect(ended).toHaveLength(1);
    expect(ended[0].isActive).toBe(false);
  });

  it('records total precipitation when ending a rain event', async () => {
    addTrail('trail-1', 'STATION-A');
    addActiveRainEvent('event-1', 'trail-1', '2024-06-01T10:00:00Z', 1.5);

    addWeatherObs('STATION-A', '2024-06-01T11:00:00Z', 0.3);
    addWeatherObs('STATION-A', '2024-06-01T12:01:00Z', 0);

    const ended = await checkForRainEnd();
    expect(ended).toHaveLength(1);
    // Total precipitation should be preserved from the event (1.5)
    expect(ended[0].totalPrecipitationIn).toBe(1.5);
  });
});
