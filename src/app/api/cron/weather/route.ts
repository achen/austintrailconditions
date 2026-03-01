import { NextResponse } from 'next/server';
import { validateConfig } from '@/services/config-validator';
import {
  fetchObservations,
  storeObservations,
  getActiveStationIds,
  shouldPollFrequently,
} from '@/services/weather-collector';
import { evaluate, checkForRainEnd } from '@/services/rain-detector';
import { notifyStationsDown, notifyCronFailure, notifyRainDetected } from '@/services/notification-service';
import { sql } from '@/lib/db';
import { WeatherObservation } from '@/types';

/**
 * GET /api/cron/weather
 *
 * Vercel Cron endpoint for weather data collection.
 * - Validates CRON_SECRET authorization
 * - Adaptive polling: skips if no active rain/drying and last poll < 24h ago
 * - Fetches observations for each active station
 * - Stores observations and runs rain detection
 *
 * Requirements: 1.1, 1.3, 1.4, 1.6, 3.1
 */
export async function GET(request: Request) {
  // 1. Cron authorization check
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 2. Validate configuration
    const config = validateConfig();

    // 3. Adaptive polling check (Req 1.4)
    const frequentPolling = await shouldPollFrequently();

    if (!frequentPolling) {
      // Check if last poll was < 24 hours ago — skip if so
      const lastPollResult = await sql`
        SELECT MAX(created_at) AS last_poll
        FROM weather_observations
      `;
      const lastPoll = lastPollResult.rows[0]?.last_poll;

      if (lastPoll) {
        const hoursSinceLastPoll =
          (Date.now() - new Date(lastPoll as string).getTime()) / (1000 * 60 * 60);

        if (hoursSinceLastPoll < 24) {
          return NextResponse.json({
            skipped: true,
            reason: 'No active rain events or drying trails; last poll was less than 24 hours ago',
            hoursSinceLastPoll: Math.round(hoursSinceLastPoll * 10) / 10,
          });
        }
      }
    }

    // 4. Get unique active station IDs (Req 1.6)
    const stationIds = await getActiveStationIds();

    if (stationIds.length === 0) {
      return NextResponse.json({
        skipped: true,
        reason: 'No active stations found',
      });
    }

    // 5. Fetch and store observations for each station (Req 1.1, 1.3)
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
        // Log and continue — retry on next cron run (Req 1.3)
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to fetch/store observations for station ${stationId}: ${message}`);
        errors.push(`${stationId}: ${message}`);
      }
    }

    // 6. Run rain detection on all new observations (Req 3.1)
    const rainEvents = await evaluate(allObservations);

    // 7. Check for rain end (60-min dry gap)
    const endedEvents = await checkForRainEnd();

    // 8. Send notifications
    const offlineStations = stationIds.filter(
      (sid) => !allObservations.some((o) => o.stationId === sid)
    );
    if (offlineStations.length > stationIds.length * 0.5) {
      await notifyStationsDown(offlineStations, stationIds.length);
    }

    if (rainEvents.length > 0) {
      const totalPrecip = allObservations.reduce((sum, o) => sum + o.precipitationIn, 0);
      await notifyRainDetected(rainEvents.length, totalPrecip);
    }

    return NextResponse.json({
      success: true,
      stationsPolled: stationIds.length,
      observationsFetched: allObservations.length,
      observationsStored: totalStored,
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
