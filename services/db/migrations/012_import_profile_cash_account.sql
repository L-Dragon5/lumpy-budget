-- Does spending on this statement leave the checking account when it posts?
--
-- The cash position subtracts everything recorded since the balance was typed in,
-- on the stated grounds that "all of it leaves the same account". That holds only
-- while every import is a bank statement. Import a credit card and the tile
-- charges purchases against a balance they have not touched yet, so it reads
-- short when the account is fine.
--
-- TRUE by default: every profile that predates this column was being treated as
-- checking already, so the default changes nothing until a card is marked.
-- One boolean, deliberately, not an accounts table: this app is one household on
-- one checking account, and the only question it has to answer is whether a row
-- has left that account yet.

ALTER TABLE import_profiles
  ADD COLUMN cash_account BOOLEAN NOT NULL DEFAULT TRUE;
