-- Which checking account does this statement come off?
--
-- One household, two checking accounts: the bills come out of one and everything
-- else out of the other. Both are cash accounts -- `cash_account` already says a
-- row has left the bank the day it posts, and that stays true for both -- but
-- they hold different money, and pooling them answers the wrong question. The
-- balance that matters for "can I spend this" is the one the bills are not
-- waiting on.
--
-- FALSE by default: every profile that predates this column is the everyday
-- account, which is what a one-account household has and what the single
-- `checking_balance_cents` setting has always meant. A household that never
-- marks one keeps exactly the behaviour it had.
--
-- A card is neither: `cash_account = FALSE` wins, and this column is ignored for
-- it. Two booleans rather than a role enum because `cash_account` is read by
-- four places that would all have to change to learn a third value.

ALTER TABLE import_profiles
  ADD COLUMN fixed_account BOOLEAN NOT NULL DEFAULT FALSE;
