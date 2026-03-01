-- 001_initial_schema.sql
-- Trail Conditions Predictor - Initial Database Schema
-- Requirements: 1.2, 2.2, 3.3, 9.1

-- Trails
CREATE TABLE trails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  primary_station_id TEXT NOT NULL,
  drying_rate_in_per_day NUMERIC(4,2) NOT NULL DEFAULT 2.5,
  max_drying_days INTEGER NOT NULL DEFAULT 3,
  updates_enabled BOOLEAN NOT NULL DEFAULT true,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  condition_status TEXT NOT NULL DEFAULT 'Probably Rideable' CHECK (condition_status IN ('Verified Rideable', 'Probably Rideable', 'Probably Not Rideable', 'Verified Not Rideable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Weather Observations (imperial units to match Weather Underground)
CREATE TABLE weather_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  precipitation_in NUMERIC(6,3) NOT NULL DEFAULT 0,
  temperature_f NUMERIC(5,1) NOT NULL,
  humidity_percent NUMERIC(5,1) NOT NULL,
  wind_speed_mph NUMERIC(6,1) NOT NULL,
  solar_radiation_wm2 NUMERIC(7,1) NOT NULL,
  daylight_hours NUMERIC(4,1) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(station_id, timestamp)
);

-- Rain Events
CREATE TABLE rain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id UUID NOT NULL REFERENCES trails(id),
  start_timestamp TIMESTAMPTZ NOT NULL,
  end_timestamp TIMESTAMPTZ,
  total_precipitation_in NUMERIC(6,3) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trail Reports (Facebook posts)
CREATE TABLE trail_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id TEXT NOT NULL UNIQUE,
  author_name TEXT NOT NULL,
  post_text TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  trail_references TEXT[] DEFAULT '{}',
  classification TEXT CHECK (classification IN ('dry', 'wet', 'inquiry', 'unrelated')),
  confidence_score NUMERIC(3,2),
  flagged_for_review BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Predictions
CREATE TABLE predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id UUID NOT NULL REFERENCES trails(id),
  rain_event_id UUID NOT NULL REFERENCES rain_events(id),
  predicted_dry_time TIMESTAMPTZ NOT NULL,
  actual_dry_time TIMESTAMPTZ,
  input_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for query performance
CREATE INDEX idx_weather_obs_timestamp ON weather_observations(timestamp DESC);
CREATE INDEX idx_weather_obs_station_ts ON weather_observations(station_id, timestamp DESC);
CREATE INDEX idx_rain_events_trail ON rain_events(trail_id, is_active);
CREATE INDEX idx_rain_events_active ON rain_events(is_active) WHERE is_active = true;
CREATE INDEX idx_trail_reports_timestamp ON trail_reports(timestamp DESC);
CREATE INDEX idx_trail_reports_classification ON trail_reports(classification) WHERE classification IS NOT NULL;
CREATE INDEX idx_predictions_trail ON predictions(trail_id, created_at DESC);
CREATE INDEX idx_trails_station ON trails(primary_station_id) WHERE is_archived = false;
