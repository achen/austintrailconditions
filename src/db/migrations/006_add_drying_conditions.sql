-- Drying conditions: aggregated weather features during the drying period
-- between rain end and actual dry time (reported via Facebook).
-- This is the training dataset for the ML drying prediction model.

CREATE TABLE IF NOT EXISTS drying_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id UUID NOT NULL REFERENCES trails(id),
  rain_event_id UUID NOT NULL REFERENCES rain_events(id),

  -- Rain event summary
  total_precipitation_in NUMERIC(6,3) NOT NULL,
  rain_duration_hours NUMERIC(8,2),

  -- Aggregated weather during drying period (rain end → actual dry)
  avg_temperature_f NUMERIC(5,1),
  max_temperature_f NUMERIC(5,1),
  min_temperature_f NUMERIC(5,1),
  avg_humidity_percent NUMERIC(5,1),
  min_humidity_percent NUMERIC(5,1),
  avg_wind_speed_mph NUMERIC(6,1),
  max_wind_speed_mph NUMERIC(6,1),
  avg_solar_radiation_wm2 NUMERIC(7,1),
  max_solar_radiation_wm2 NUMERIC(7,1),
  total_daylight_hours NUMERIC(6,1),

  -- Antecedent conditions (was it already wet?)
  precip_7d_before_in NUMERIC(6,3),
  days_since_last_rain NUMERIC(6,2),

  -- Outcome (label for ML)
  actual_drying_hours NUMERIC(8,2) NOT NULL,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(trail_id, rain_event_id)
);

CREATE INDEX IF NOT EXISTS idx_drying_conditions_trail ON drying_conditions(trail_id);
