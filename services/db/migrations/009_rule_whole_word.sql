-- A rule that should match a name but not a longer name starting with it. "bp"
-- wants BP #4021 and not BPOST; there was no way to say so, and the trailing
-- space the seed used to carry never worked, because the matcher trims the
-- needle before it looks (see 008 and contracts/matchesPattern).
--
-- Default FALSE, so every rule that exists keeps matching exactly what it
-- matched yesterday. This is a new thing a rule can opt into, not a new way old
-- rules behave.
ALTER TABLE category_rules
  ADD COLUMN whole_word BOOLEAN NOT NULL DEFAULT FALSE AFTER pattern;

-- The two the seed shipped as 'bp ' and 'amc ', which is the only reason those
-- trailing spaces were ever typed. Nothing else in the table is touched.
UPDATE category_rules SET whole_word = TRUE WHERE pattern IN ('bp', 'amc');
