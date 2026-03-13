-- Store per-daypart forecast conditions for drying predictions.
-- JSONB array of {dayOffset, name, solarRadiationWm2, windSpeedMph, temperatureF, precipChance, phrase}
ALTER TABLE weather_forecasts ADD COLUMN IF NOT EXISTS dayparts JSONB;
