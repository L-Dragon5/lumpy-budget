-- Which merchant a bill actually posts as, so "budgeted vs actual" can answer per
-- bill instead of per category. Four bills sharing a Utilities category can only
-- ever be compared as a lump; "NATIONAL GRID" names exactly one of them.
-- Same matching the importer already does for category_rules: a case-insensitive
-- substring of "merchant description".
ALTER TABLE fixed_costs
  ADD COLUMN merchant_pattern VARCHAR(160) NULL;
