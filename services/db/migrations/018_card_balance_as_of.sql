-- A card's balance is typed in as of a day, not carried forward from an opening.
--
-- `card_opening_balance_cents:<id>` meant "what the card owed before the first
-- statement I ever imported", and every row imported since was added to it. That
-- is only as current as the last import, and it is unfixable by hand: the one
-- number a person can actually read off the issuer's site is today's balance,
-- and there was nowhere to put it.
--
-- `card_balance_cents:<id>` is that number, and `settings.updated_at` is the day
-- it was read. Only rows dated on or after that day are added on top.
--
-- The old keys are deleted rather than renamed. Renaming would keep the value
-- and give it a new as-of of today, which excludes every charge already
-- imported: an opening balance would be shown as the whole balance. Deleted, the
-- tile says nothing is set and asks for the number, which is honest and is one
-- minute of typing.
--
-- LEFT rather than LIKE: an underscore in a LIKE pattern is a wildcard, and this
-- prefix has four of them.

DELETE FROM settings
 WHERE LEFT(name, CHAR_LENGTH('card_opening_balance_cents:')) = 'card_opening_balance_cents:';
