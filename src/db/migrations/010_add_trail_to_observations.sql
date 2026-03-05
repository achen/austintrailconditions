-- 010_add_trail_to_observations.sql
-- Add trail_id to weather_observations so observations remain traceable
-- even when a trail's primary station changes.

ALTER TABLE weather_observations
  ADD COLUMN trail_id UUID REFERENCES trails(id);

-- Backfill existing observations where possible (match current station assignments)
UPDATE weather_observations wo
SET trail_id = t.id
FROM trails t
WHERE t.primary_station_id = wo.station_id
  AND t.is_archived = false;

-- Index for querying observations by trail
CREATE INDEX idx_weather_obs_trail ON weather_observations(trail_id, timestamp DESC)
  WHERE trail_id IS NOT NULL;

-- Drop the old unique constraint and replace with one that includes trail_id
ALTER TABLE weather_observations DROP CONSTRAINT weather_observations_station_id_timestamp_key;
ALTER TABLE weather_observations ADD CONSTRAINT weather_observations_station_trail_ts_key
  UNIQUE (station_id, trail_id, timestamp);
