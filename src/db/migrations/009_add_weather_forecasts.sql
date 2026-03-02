-- Cache daily forecast checks to avoid repeated API calls.
-- One row per day, stores whether rain is expected.
CREATE TABLE IF NOT EXISTS weather_forecasts (
  forecast_date DATE PRIMARY KEY,
  rain_expected BOOLEAN NOT NULL,
  max_chance INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
