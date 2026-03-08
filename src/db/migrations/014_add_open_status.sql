-- Add "Open" as a valid condition_status for scraped trails that report open.
ALTER TABLE trails DROP CONSTRAINT trails_condition_status_check;
ALTER TABLE trails ADD CONSTRAINT trails_condition_status_check CHECK (condition_status IN ('Observed Dry', 'Predicted Dry', 'Predicted Wet', 'Observed Wet', 'Open', 'Closed'));
