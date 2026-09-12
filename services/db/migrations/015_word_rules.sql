-- Two seeded patterns are whole words that longer words are built out of, and
-- both were plain substrings. On a real statement `rent` claimed NATIONAL CAR
-- RENTAL for Housing, and `hoa` claimed PY *PRIMOHOAGIES DMV for Taxes & Fees:
-- a fixed cost and a lumpy cost appearing out of nowhere, and two discretionary
-- charges going missing in the same two rows. PARENT, CURRENT and WHOA were
-- queued up behind them.
--
-- The whole_word switch from 009 is what says a pattern is a word: a letter on
-- either side of the hit disqualifies it. That leaves "RENT PAYMENT", "BPS*BILT
-- RENT" and "SUNRIDGE HOA" matching, and takes "RENTAL" and "HOAGIES" away.
--
-- Only the seeded patterns are touched, matched exactly. A pattern somebody
-- typed themselves is theirs, and a pattern that merely contains one of these
-- words is a different rule with a different answer.
UPDATE category_rules
   SET whole_word = TRUE
 WHERE LOWER(pattern) IN ('rent', 'hoa');
