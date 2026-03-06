-- Rename all condition statuses to match display labels
ALTER TABLE trails DROP CONSTRAINT trails_condition_status_check;

UPDATE trails SET condition_status = 'Observed Dry' WHERE condition_status = 'Verified Rideable';
UPDATE trails SET condition_status = 'Observed Wet' WHERE condition_status = 'Verified Not Rideable';
UPDATE trails SET condition_status = 'Predicted Dry' WHERE condition_status = 'Predicted Rideable';
UPDATE trails SET condition_status = 'Predicted Wet' WHERE condition_status = 'Predicted Not Rideable';

ALTER TABLE trails ADD CONSTRAINT trails_condition_status_check CHECK (condition_status IN ('Observed Dry', 'Predicted Dry', 'Predicted Wet', 'Observed Wet', 'Closed'));
ALTER TABLE trails ALTER COLUMN condition_status SET DEFAULT 'Predicted Dry';
