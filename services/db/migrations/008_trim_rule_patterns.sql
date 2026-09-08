-- Patterns are stored trimmed from here on (contracts/types.ts), because
-- applyRules has always matched on the trimmed needle. This brings the rows
-- already in the table into line, so no read has to trim on your behalf.
--
-- Compared by length, not by value: MySQL ignores trailing spaces when it
-- compares strings, so `pattern <> TRIM(pattern)` is false for 'bp ' and the
-- one row that most needs fixing is the one that slips through.
UPDATE category_rules
   SET pattern = TRIM(pattern)
 WHERE CHAR_LENGTH(pattern) <> CHAR_LENGTH(TRIM(pattern))
   AND CHAR_LENGTH(TRIM(pattern)) >= 2;

-- What is left is a rule whose pattern is padding around one character or less.
-- The API would not accept one today and cannot produce one after this; the
-- needle it leaves behind matches nearly every merchant, so the rule was doing
-- harm rather than nothing.
DELETE FROM category_rules WHERE CHAR_LENGTH(TRIM(pattern)) < 2;
