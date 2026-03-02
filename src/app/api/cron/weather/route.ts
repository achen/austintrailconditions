import { NextResponse } from 'next/server';
import { validateConfig } from '@/services/config-validator';
import {
  fetchObservations,
  storeObservations,
  getActiveStationIds,
  shouldPollFrequently,
  isRainForecast,
} from '@/services/weather-collector';
import { evaluate, checkForRainEnd } from '@/services/rain-detector';
import { notifyStationsDown, notifyCronFailure, notifyRainDetected, notifyForecastCheck } from '@/services/notification-service';
import { sql } from '@/lib/db';
import { WeatherObservation } from '@/types';

/**
 * GET /api/cron/weather
 *
 * Vercel Cron endpoint for weather data collection.
 *
 * Polling strategy (conserves WU API calls):
 * 1. If active rain or trails drying → poll all stations hourly
 * 2. Otherwise → check forecast (1 API call). If rain expected → poll stations
 * 3. If no rain expected → poll stations once at midday for data points
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const config = validateConfig();
    const frequentPolling = await shouldPollFrequently();

    if (!frequentPolling) {
      // No active rain or drying trails — check forecast once per day
      // to decide whether to start hourly station polling.
      const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      // Check if we already have today's forecast cached
      const cachedForecast = await sql`
        SELECT rain_expected FROM weather_forecasts
        WHERE forecast_date = ${todayStr}
        LIMIT 1
      `;

      let rainExpected: boolean;

      if (cachedForecast.rows.length > 0) {
        // Use cached forecast — no API call
        rainExpected = cachedForecast.rows[0].rain_expected as boolean;
      } else {
        // Fetch forecast (1 API call per day)
        const forecast = await isRainForecast(config.weatherUnderground.apiKey);
        rainExpected = forecast.rainExpected;
        console.log(`Forecast check: ${forecast.details}`);

        // Cache it
        await sql`
          INSERT INTO weather_forecasts (forecast_date, rain_expected, max_chance, details)
          VALUES (${todayStr}, ${rainExpected}, ${forecast.maxChance}, ${forecast.details})
          ON CONFLICT (forecast_date) DO NOTHING
        `;

        // Send daily forecast email
        const trailStatusResult = await sql`
          SELECT name, condition_status FROM trails
          WHERE is_archived = false ORDER BY name ASC
        `;
        const trailStatuses = trailStatusResult.rows.map(r => ({
          name: r.name as string,
          status: r.condition_status as string,
        }));
        await notifyForecastCheck(
          rainExpected, forecast.maxChance, forecast.details, trailStatuses,
          rainExpected ? 'hourly' : 'midday-only'
        );
      }

      if (rainExpected) {
        // Rain in forecast — poll stations this hour
        console.log('Rain forecast for today/tomorrow, polling stations');
      } else {
        // No rain expected — skip station polling entirely, forecast is enough
        return NextResponse.json({
          skipped: true,
          reason: 'No rain forecast; station polling not needed',
        });
      }
    }

    // Poll individual stations
    const stationIds = await getActiveStationIds();
    if (stationIds.length === 0) {
      return NextResponse.json({ skipped: true, reason: 'No active stations found' });
    }

    const allObservations: WeatherObservation[] = [];
    let totalStored = 0;
    const errors: string[] = [];

    for (const stationId of stationIds) {
      try {
        const observations = await fetchObservations(stationId, config.weatherUnderground.apiKey);
        allObservations.push(...observations);
        const stored = await storeObservations(observations);
        totalStored += stored;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to fetch/store for ${stationId}: ${message}`);
        errors.push(`${stationId}: ${message}`);
      }
    }

    const offlineStations = stationIds.filter(
      (sid) => !allObservations.some((o) => o.stationId === sid)
    );

    // Run rain detection
    const rainEvents = await evaluate(allObservations);
    const endedEvents = await checkForRainEnd();

    // Notify on any offline stations
    if (offlineStations.length > 0) {
      await notifyStationsDown(offlineStations, stationIds.length);
    }

    if (rainEvents.length > 0) {
      const totalPrecip = allObservations.reduce((sum, o) => sum + o.precipitationIn, 0);
      const trailStatusResult = await sql`
        SELECT name, condition_status FROM trails
        WHERE is_archived = false ORDER BY name ASC
      `;
      const trailStatuses = trailStatusResult.rows.map(r => ({
        name: r.name as string,
        status: r.condition_status as string,
      }));
      await notifyRainDetected(rainEvents.length, totalPrecip, trailStatuses);
    }

    return NextResponse.json({
      success: true,
      stationsPolled: stationIds.length,
      observationsFetched: allObservations.length,
      observationsStored: totalStored,
      offlineStations: offlineStations.length > 0 ? offlineStations : undefined,
      rainEventsCreatedOrUpdated: rainEvents.length,
      rainEventsEnded: endedEvents.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Weather cron failed: ${message}`);
    await notifyCronFailure('weather', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
