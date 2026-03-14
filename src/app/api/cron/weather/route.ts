import { NextResponse } from 'next/server';
import { validateConfig } from '@/services/config-validator';
import {
  fetchObservations,
  storeObservations,
  getTrailStationMappings,
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
          AND condition_status IN ('Predicted Wet', 'Observed Wet')
      ) AS wet
    `;
    const hasWetTrails = !!wetTrailsResult.rows[0]?.wet;

    if (hasActiveRain || hasWetTrails) {
      // Refresh forecast dayparts once per day even while polling —
      // the prediction engine needs current forecast data to estimate
      // remaining drying time.
      const todayStr = now.toISOString().slice(0, 10);
      const hasTodayForecast = await sql`
        SELECT 1 FROM weather_forecasts
        WHERE forecast_date = ${todayStr} AND dayparts IS NOT NULL
        LIMIT 1
      `;
      if (hasTodayForecast.rows.length === 0) {
        try {
          const forecast = await isRainForecast(config.weatherUnderground.apiKey);
          await sql`
            INSERT INTO weather_forecasts (forecast_date, rain_expected, max_chance, details, poll_after_utc, poll_until_utc, dayparts)
            VALUES (${todayStr}, ${forecast.rainExpected}, ${forecast.maxChance}, ${forecast.details}, ${forecast.pollAfterUtc?.toISOString() ?? null}, ${forecast.pollUntilUtc?.toISOString() ?? null}, ${JSON.stringify(forecast.dayparts)})
            ON CONFLICT (forecast_date) DO UPDATE SET dayparts = ${JSON.stringify(forecast.dayparts)}
          `;
        } catch (err) {
          console.error('Forecast refresh failed:', err instanceof Error ? err.message : err);
        }
      }

      return await pollStations(config, now, hasActiveRain ? 'active-rain' : 'trails-drying');
    }

    // --- Priority 1.5: Previous day's polling window still active → keep polling ---
    const prevWindowResult = await sql`
      SELECT poll_after_utc, poll_until_utc FROM weather_forecasts
      WHERE rain_expected = true
        AND poll_after_utc <= ${now.toISOString()}
        AND poll_until_utc >= ${now.toISOString()}
      ORDER BY forecast_date DESC
      LIMIT 1
    `;
    if (prevWindowResult.rows.length > 0) {
      return await pollStations(config, now, 'prior-forecast-window');
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
        INSERT INTO weather_forecasts (forecast_date, rain_expected, max_chance, details, poll_after_utc, poll_until_utc, dayparts)
        VALUES (${todayStr}, ${rainExpected}, ${forecast.maxChance}, ${forecast.details}, ${pollAfterUtc?.toISOString() ?? null}, ${pollUntilUtc?.toISOString() ?? null}, ${JSON.stringify(forecast.dayparts)})
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
  const mappings = await getTrailStationMappings();
  if (mappings.length === 0) {
    return NextResponse.json({ skipped: true, reason: 'No active stations found' });
  }

  // Deduplicate stations — multiple trails can share a station
  const uniqueStations = Array.from(new Set(mappings.map(m => m.stationId)));
  // Build station → trailIds lookup
  const stationToTrails = new Map<string, string[]>();
  for (const m of mappings) {
    const list = stationToTrails.get(m.stationId) ?? [];
    list.push(m.trailId);
    stationToTrails.set(m.stationId, list);
  }

  const allObservations: WeatherObservation[] = [];
  let totalStored = 0;
  const errors: string[] = [];

  for (const stationId of uniqueStations) {
    try {
      const rawObs = await fetchObservations(stationId, config.weatherUnderground.apiKey);
      const trailIds = stationToTrails.get(stationId) ?? [];

      // Create one observation per trail for this station
      for (const obs of rawObs) {
        for (const trailId of trailIds) {
          allObservations.push({ ...obs, trailId });
        }
      }

      // Store with trail context
      const taggedObs = rawObs.flatMap(obs =>
        trailIds.map(trailId => ({ ...obs, trailId }))
      );
      const stored = await storeObservations(taggedObs);
      totalStored += stored;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to fetch/store for ${stationId}: ${message}`);
      errors.push(`${stationId}: ${message}`);
    }
  }

  const offlineStations = uniqueStations.filter(
    (sid) => !allObservations.some((o) => o.stationId === sid)
  );

  const rainEvents = await evaluate(allObservations);
  const endedEvents = await checkForRainEnd();

  if (offlineStations.length > 0) {
    await notifyStationsDown(offlineStations, uniqueStations.length);
  }

  if (rainEvents.length > 0) {
    const totalPrecip = allObservations.reduce((sum, o) => sum + o.precipitationIn, 0);
    // Get active rain event totals per trail for the email
    const rainAccumResult = await sql`
      SELECT t.name, re.total_precipitation_in
      FROM rain_events re
      JOIN trails t ON t.id = re.trail_id
      WHERE re.is_active = true
    `;
    const rainAccumMap = new Map<string, number>();
    for (const r of rainAccumResult.rows) {
      rainAccumMap.set(r.name as string, Number(r.total_precipitation_in));
    }
    const trailStatusResult = await sql`
      SELECT name, condition_status FROM trails
      WHERE is_archived = false ORDER BY name ASC
    `;
    const trailStatuses = trailStatusResult.rows.map(r => ({
      name: r.name as string,
      status: r.condition_status as string,
      rainAccum: rainAccumMap.get(r.name as string) ?? undefined,
    }));
    await notifyRainDetected(rainEvents.length, totalPrecip, trailStatuses);
  }

  return NextResponse.json({
    success: true,
    reason,
    stationsPolled: uniqueStations.length,
    observationsFetched: allObservations.length,
    observationsStored: totalStored,
    offlineStations: offlineStations.length > 0 ? offlineStations : undefined,
    rainEventsCreatedOrUpdated: rainEvents.length,
    rainEventsEnded: endedEvents.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
