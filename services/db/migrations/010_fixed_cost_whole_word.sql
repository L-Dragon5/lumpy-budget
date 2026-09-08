-- The same switch category rules got in 009, for the pattern that answers
-- "budgeted versus actual" for one bill. "BP" as a fuel bill should not be
-- reconciled by a BPOST charge.
--
-- Default FALSE, so every bill that exists keeps matching what it matched
-- yesterday. Nothing is turned on here: unlike the seed's 'bp ', no bill was
-- ever written with a trailing space reaching for this.
ALTER TABLE fixed_costs
  ADD COLUMN merchant_whole_word BOOLEAN NOT NULL DEFAULT FALSE AFTER merchant_pattern;

-- Patterns are stored trimmed from here on, the same as rule patterns, because
-- the matcher has always trimmed the needle before looking. Compared by length:
-- MySQL ignores trailing spaces when it compares strings, so
-- `merchant_pattern <> TRIM(merchant_pattern)` is false for 'bp '.
UPDATE fixed_costs
   SET merchant_pattern = TRIM(merchant_pattern)
 WHERE merchant_pattern IS NOT NULL
   AND CHAR_LENGTH(merchant_pattern) <> CHAR_LENGTH(TRIM(merchant_pattern))
   AND CHAR_LENGTH(TRIM(merchant_pattern)) >= 2;

-- A pattern that is padding around one character or less is not a pattern; it
-- would claim nearly every transaction in the window. Cleared rather than
-- deleted, because the bill itself is real and only its pattern is junk: it
-- falls back to being compared alongside its category, which is what a bill
-- without a pattern has always done.
UPDATE fixed_costs
   SET merchant_pattern = NULL
 WHERE merchant_pattern IS NOT NULL
   AND CHAR_LENGTH(TRIM(merchant_pattern)) < 2;
