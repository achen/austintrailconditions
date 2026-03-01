-- 002_add_status_url.sql
-- Add optional status_url column to trails for scraping official trail status pages

ALTER TABLE trails ADD COLUMN status_url TEXT;
