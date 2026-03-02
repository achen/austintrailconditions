import { NextResponse } from 'next/server';
import { validateConfig } from '@/services/config-validator';
import {
  fetchObservations,
  storeObservations,
  getActiveStationIds,
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
 * Polling algorithm:
 * 1. Active rain or trails still wet → poll stations hourly
 * 2. No active rain, all trails dry → check 5-day forecast (1 API call/day)
 *    a. Rain in forecast → wait until 3-4 hours before forecasted start, then poll hourly
 *    b. No rain in forecast → done, no station polls
 * 3. If hourly polling started due to forecast but no rain actually fell after
 *    the forecast window passes → stop polling (false alarm)
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const config = validateConfig();
    const now = new Date();

    // --- Priority 1: Active rain or wet trails → always poll ---
    const activeRainResult = await sql`
      SELECT EXISTS (SELECT 1 FROM rain_events WHERE is_active = true) AS active
    `;
    const hasActiveRain = !!activeRainResult.rows[0]?.active;

    const wetTrailsResult = await sql`
      SELECT EXISTS (
        SELECT 1 FROM trails
        WHERE is_archived = false AND updates_enabled = true
          AND condition_status IN ('Probably Not Rideable', 'Verified Not Rideable')
      ) AS wet
    `;
    const hasWetTrails = !!wetTrailsResult.rows[0]?.wet;

    if (hasActiveRain || hasWetTrails) {
      return await pollStations(config, now, hasActiveRain ? 'active-rain' : 'trails-drying');
    }

    // --- Priority 2: Check forecast ---
    const todayStr = now.toISOString().slice(0, 10);

    const cachedForecast = await sql`
      SELECT rain_expected, poll_after_utc, poll_until_utc FROM weather_forecasts
      WHERE forecast_date = ${todayStr}
      LIMIT 1
    `;

    let rainExpected: boolean;
    let pollAfterUtc: Date | null = null;
    let pollUntilUtc: Date | null = null;

    if (cachedForecast.rows.length > 0) {
      rainExpected = cachedForecast.rows[0].rain_expected as boolean;
      const cachedAfter = cachedForecast.rows[0].poll_after_utc as string | null;
      const cachedUntil = cachedForecast.rows[0].poll_until_utc as string | null;
      pollAfterUtc = cachedAfter ? new Date(cachedAfter) : null;
      pollUntilUtc = cachedUntil ? new Date(cachedUntil) : null;
    } else {
      // 1 API call per day (5-day daily forecast, daypart granularity)
      const forecast = await isRainForecast(config.weatherUnderground.apiKey);
      rainExpected = forecast.rainExpected;
      pollAfterUtc = forecast.pollAfterUtc;
      pollUntilUtc = forecast.pollUntilUtc;
      console.log(`Forecast check: ${forecast.details}`);

      await sql`
        INSERT INTO weather_forecasts (forecast_date, rain_expected, max_chance, details, poll_after_utc, poll_until_utc)
        VALUES (${todayStr}, ${rainExpected}, ${forecast.maxChance}, ${forecast.details}, ${pollAfterUtc?.toISOString() ?? null}, ${pollUntilUtc?.toISOString() ?? null})
        ON CONFLICT (forecast_date) DO NOTHING
      `;

      // Daily forecast email
      const trailStatusResult = await sql`
        SELECT name, condition_status FROM trails
        WHERE is_archived = false ORDER BY name ASC
      `;
      const trailStatuses = trailStatusResult.rows.map(r => ({
        name: r.name as string,
        status: r.condition_status as string,
      }));
      const hoursUntilPoll = pollAfterUtc
        ? (pollAfterUtc.getTime() - new Date().getTime()) / (1000 * 60 * 60)
        : 0;
      const modeLabel = !rainExpected
        ? 'forecast-only'
        : hoursUntilPoll > 20
          ? `deferred (rain ~${Math.round(hoursUntilPoll + 4)}h away)`
          : 'hourly (rain window open)';
      await notifyForecastCheck(
        rainExpected, forecast.maxChance, forecast.details, trailStatuses,
        modeLabel
      );
    }

    if (!rainExpected) {
      return NextResponse.json({ skipped: true, reason: 'No rain in 5-day forecast' });
    }

    // Rain is forecast — are we within the polling window?
    if (pollAfterUtc && now < pollAfterUtc) {
      return NextResponse.json({
        skipped: true,
        reason: `Rain forecast but polling starts ${pollAfterUtc.toISOString()} (${Math.round((pollAfterUtc.getTime() - now.getTime()) / 3600000)}h from now)`,
      });
    }

    // We're in the rain window — poll stations
    // Stop if we're past the forecast rain window + 3 hours and no rain actually fell
    if (pollUntilUtc && now > pollUntilUtc) {
      // Check if any actual rain was detected
      const recentPrecipResult = await sql`
        SELECT COALESCE(SUM(precipitation_in), 0) AS total_precip
        FROM weather_observations
        WHERE timestamp > ${pollAfterUtc?.toISOString() ?? now.toISOString()}
      `;
      const recentPrecip = Number(recentPrecipResult.rows[0]?.total_precip ?? 0);

      if (recentPrecip === 0) {
        return NextResponse.json({
          skipped: true,
          reason: `Past rain window (until ${pollUntilUtc.toISOString()}) with no precip — false alarm`,
        });
      }
      // If rain DID fall, active rain / wet trails check at top will handle continued polling
    }

    return await pollStations(config, now, 'rain-forecast');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Weather cron failed: ${message}`);
    await notifyCronFailure('weather', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Poll all active weather stations, run rain detection, send notifications.
 */
async function pollStations(
  config: ReturnType<typeof validateConfig>,
  now: Date,
  reason: string
) {
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

  const rainEvents = await evaluate(allObservations);
  const endedEvents = await checkForRainEnd();

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
    reason,
    stationsPolled: stationIds.length,
    observationsFetched: allObservations.length,
    observationsStored: totalStored,
    offlineStations: offlineStations.length > 0 ? offlineStations : undefined,
    rainEventsCreatedOrUpdated: rainEvents.length,
    rainEventsEnded: endedEvents.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
