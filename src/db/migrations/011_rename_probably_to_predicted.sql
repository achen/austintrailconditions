-- Rename "Probably Rideable" → "Predicted Rideable" and "Probably Not Rideable" → "Predicted Not Rideable"
ALTER TABLE trails DROP CONSTRAINT trails_condition_status_check;

UPDATE trails SET condition_status = 'Predicted Rideable' WHERE condition_status = 'Probably Rideable';
UPDATE trails SET condition_status = 'Predicted Not Rideable' WHERE condition_status = 'Probably Not Rideable';

ALTER TABLE trails ADD CONSTRAINT trails_condition_status_check CHECK (condition_status IN ('Verified Rideable', 'Predicted Rideable', 'Predicted Not Rideable', 'Verified Not Rideable', 'Closed'));
ALTER TABLE trails ALTER COLUMN condition_status SET DEFAULT 'Predicted Rideable';
