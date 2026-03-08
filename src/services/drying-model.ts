import { sql } from '@/lib/db';

/**
 * When a trail is verified dry via Facebook, compute the weather features
 * during the drying period and store them as a training sample.
 *
 * Called from trail-verifier.ts after recordActualOutcome.
 */
export async function storeDryingConditions(
  trailId: string,
  rainEventId: string,
  actualDryTime: Date
): Promise<void> {
  // Get the rain event
  const eventResult = await sql`
    SELECT start_timestamp, end_timestamp, total_precipitation_in
    FROM rain_events WHERE id = ${rainEventId}
  `;
  if (eventResult.rows.length === 0) return;

  const event = eventResult.rows[0];
  const rainEnd = new Date(event.end_timestamp as string);
  const totalPrecip = Number(event.total_precipitation_in);
  const rainStart = new Date(event.start_timestamp as string);
  const rainDurationHours = (rainEnd.getTime() - rainStart.getTime()) / (1000 * 60 * 60);
  const actualDryingHours = (actualDryTime.getTime() - rainEnd.getTime()) / (1000 * 60 * 60);

  if (actualDryingHours <= 0) return; // Bad data

  // Aggregate weather observations during the drying period
  const weatherResult = await sql`
    SELECT
      AVG(temperature_f) as avg_temp,
      MAX(temperature_f) as max_temp,
      MIN(temperature_f) as min_temp,
      AVG(humidity_percent) as avg_humidity,
      MIN(humidity_percent) as min_humidity,
      AVG(wind_speed_mph) as avg_wind,
      MAX(wind_speed_mph) as max_wind,
      AVG(solar_radiation_wm2) as avg_solar,
      MAX(solar_radiation_wm2) as max_solar,
      SUM(daylight_hours) as total_daylight
    FROM weather_observations
    WHERE trail_id = ${trailId}
      AND timestamp >= ${rainEnd.toISOString()}
      AND timestamp <= ${actualDryTime.toISOString()}
  `;

  const w = weatherResult.rows[0] || {};

  // Count hours of meaningful solar radiation (> 50 W/m²) during daytime
  // (8am–6pm CT). Each observation represents ~5 min, so we count distinct
  // observation timestamps and convert to hours.
  const solarResult = await sql`
    SELECT COUNT(*) as solar_obs_count
    FROM weather_observations
    WHERE trail_id = ${trailId}
      AND timestamp >= ${rainEnd.toISOString()}
      AND timestamp <= ${actualDryTime.toISOString()}
      AND solar_radiation_wm2 > 50
      AND EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Chicago') >= 8
      AND EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Chicago') < 18
  `;
  // Weather observations come every ~5 minutes, so each obs ≈ 5 min of sun
  const solarObsCount = Number(solarResult.rows[0]?.solar_obs_count ?? 0);
  const totalSolarHours = Math.round((solarObsCount * 5 / 60) * 10) / 10;

  // Antecedent moisture: precipitation in the 7 days before this rain event
  const antecedentResult = await sql`
    SELECT COALESCE(SUM(total_precipitation_in), 0) as precip_7d
    FROM rain_events
    WHERE trail_id = ${trailId}
      AND id != ${rainEventId}
      AND end_timestamp >= ${new Date(rainStart.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()}
      AND end_timestamp < ${rainStart.toISOString()}
  `;
  const precip7d = Number(antecedentResult.rows[0]?.precip_7d ?? 0);

  // Days since last rain ended (before this event)
  const lastRainResult = await sql`
    SELECT end_timestamp FROM rain_events
    WHERE trail_id = ${trailId}
      AND id != ${rainEventId}
      AND end_timestamp < ${rainStart.toISOString()}
    ORDER BY end_timestamp DESC
    LIMIT 1
  `;
  const daysSinceLastRain = lastRainResult.rows.length > 0
    ? (rainStart.getTime() - new Date(lastRainResult.rows[0].end_timestamp as string).getTime()) / (1000 * 60 * 60 * 24)
    : null;

  // Store the training sample
  await sql`
    INSERT INTO drying_conditions (
      trail_id, rain_event_id,
      total_precipitation_in, rain_duration_hours,
      avg_temperature_f, max_temperature_f, min_temperature_f,
      avg_humidity_percent, min_humidity_percent,
      avg_wind_speed_mph, max_wind_speed_mph,
      avg_solar_radiation_wm2, max_solar_radiation_wm2,
      total_daylight_hours, total_solar_hours,
      precip_7d_before_in, days_since_last_rain,
      actual_drying_hours
    ) VALUES (
      ${trailId}, ${rainEventId},
      ${totalPrecip}, ${rainDurationHours},
      ${w.avg_temp ?? null}, ${w.max_temp ?? null}, ${w.min_temp ?? null},
      ${w.avg_humidity ?? null}, ${w.min_humidity ?? null},
      ${w.avg_wind ?? null}, ${w.max_wind ?? null},
      ${w.avg_solar ?? null}, ${w.max_solar ?? null},
      ${w.total_daylight ?? null}, ${totalSolarHours},
      ${precip7d}, ${daysSinceLastRain},
      ${actualDryingHours}
    )
    ON CONFLICT (trail_id, rain_event_id) DO NOTHING
  `;

  console.log(
    `Stored drying conditions for trail ${trailId}: ${actualDryingHours.toFixed(1)}h to dry after ${totalPrecip}" rain, ${totalSolarHours}h sun`
  );
}
