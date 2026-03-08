-- Add total_solar_hours to drying_conditions.
-- Tracks cumulative hours of meaningful solar radiation (> 50 W/m²)
-- during the drying period (8am–6pm CT only). This is the key feature
-- for correlating sun exposure with actual drying time.

ALTER TABLE drying_conditions
  ADD COLUMN IF NOT EXISTS total_solar_hours NUMERIC(6,1);
