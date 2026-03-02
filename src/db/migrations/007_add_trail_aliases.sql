-- Trail aliases: segment names, nicknames, and alternate spellings
-- that should map to the parent trail for classification.
-- e.g. "Brushy - West" has aliases ["Snail Trail", "Rim Job", "Bob Ross", "Deception"]

ALTER TABLE trails ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}';
