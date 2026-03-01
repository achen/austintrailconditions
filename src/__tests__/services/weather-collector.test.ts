import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateDaylightHours, fetchObservations } from '@/services/weather-collector';

describe('WeatherCollector', () => {
  describe('calculateDaylightHours', () => {
    it('returns ~14 hours near summer solstice (June 21)', () => {
      const summerSolstice = new Date(2024, 5, 21); // June 21
      const hours = calculateDaylightHours(summerSolstice);
      expect(hours).toBeGreaterThan(13.5);
      expect(hours).toBeLessThan(14.5);
    });

    it('returns ~10 hours near winter solstice (Dec 21)', () => {
      const winterSolstice = new Date(2024, 11, 21); // Dec 21
      const hours = calculateDaylightHours(winterSolstice);
      expect(hours).toBeGreaterThan(9.5);
      expect(hours).toBeLessThan(10.5);
    });

    it('returns ~12 hours near equinox (March 20)', () => {
      const equinox = new Date(2024, 2, 20); // March 20
      const hours = calculateDaylightHours(equinox);
      expect(hours).toBeGreaterThan(11.5);
      expect(hours).toBeLessThan(12.5);
    });

    it('returns a value rounded to 1 decimal place', () => {
      const date = new Date(2024, 6, 15);
      const hours = calculateDaylightHours(date);
      const decimalPlaces = (hours.toString().split('.')[1] || '').length;
      expect(decimalPlaces).toBeLessThanOrEqual(1);
    });

    it('always returns between 0 and 24', () => {
      for (let month = 0; month < 12; month++) {
        const date = new Date(2024, month, 15);
        const hours = calculateDaylightHours(date);
        expect(hours).toBeGreaterThanOrEqual(0);
        expect(hours).toBeLessThanOrEqual(24);
      }
    });
  });

  describe('fetchObservations', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('parses Weather Underground API response correctly', async () => {
      const mockResponse = {
        observations: [
          {
            stationID: 'KTXAUSTI2479',
            obsTimeUtc: '2024-07-15T14:30:00Z',
            humidity: 65,
            solarRadiation: 800,
            imperial: {
              temp: 95,
              windSpeed: 8,
              precipTotal: 0.1,
            },
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const observations = await fetchObservations('KTXAUSTI2479', 'test-key', 'https://api.weather.com');

      expect(observations).toHaveLength(1);
      expect(observations[0].stationId).toBe('KTXAUSTI2479');
      expect(observations[0].precipitationIn).toBe(0.1);
      expect(observations[0].temperatureF).toBe(95);
      expect(observations[0].humidityPercent).toBe(65);
      expect(observations[0].windSpeedMph).toBe(8);
      expect(observations[0].solarRadiationWm2).toBe(800);
      expect(observations[0].daylightHours).toBeGreaterThan(0);
      expect(observations[0].timestamp).toEqual(new Date('2024-07-15T14:30:00Z'));
    });

    it('returns empty array on API error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const observations = await fetchObservations('KTXAUSTI2479', 'test-key', 'https://api.weather.com');

      expect(observations).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('returns empty array when response has no observations array', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ error: 'no data' }),
      } as Response);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const observations = await fetchObservations('KTXAUSTI2479', 'test-key', 'https://api.weather.com');

      expect(observations).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('defaults missing imperial values to 0', async () => {
      const mockResponse = {
        observations: [
          {
            stationID: 'KTXAUSTI2479',
            obsTimeUtc: '2024-07-15T14:30:00Z',
            humidity: 50,
            solarRadiation: 0,
            imperial: {},
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const observations = await fetchObservations('KTXAUSTI2479', 'test-key', 'https://api.weather.com');

      expect(observations[0].precipitationIn).toBe(0);
      expect(observations[0].temperatureF).toBe(0);
      expect(observations[0].windSpeedMph).toBe(0);
    });

    it('uses stationId parameter as fallback when stationID missing from response', async () => {
      const mockResponse = {
        observations: [
          {
            obsTimeUtc: '2024-07-15T14:30:00Z',
            humidity: 50,
            solarRadiation: 0,
            imperial: { temp: 90, windSpeed: 5, precipTotal: 0 },
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const observations = await fetchObservations('MY_STATION', 'test-key', 'https://api.weather.com');
      expect(observations[0].stationId).toBe('MY_STATION');
    });

    it('constructs the correct API URL', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ observations: [] }),
      } as Response);

      await fetchObservations('KTXAUSTI2479', 'my-api-key', 'https://api.weather.com');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.weather.com/v2/pws/observations/current?stationId=KTXAUSTI2479&format=json&units=e&apiKey=my-api-key'
      );
    });
  });
});
