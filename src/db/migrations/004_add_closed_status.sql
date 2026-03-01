ALTER TABLE trails DROP CONSTRAINT trails_condition_status_check;
ALTER TABLE trails ADD CONSTRAINT trails_condition_status_check CHECK (condition_status IN ('Verified Rideable', 'Probably Rideable', 'Probably Not Rideable', 'Verified Not Rideable', 'Closed'));
UPDATE trails SET condition_status = 'Closed' WHERE name = 'Flat Creek'
