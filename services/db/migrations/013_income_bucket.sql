-- Deposits get a bucket of their own.
--
-- An imported checking statement writes every credit as a negative expense.
-- With no bucket for it, `bucketOf` fell through to its default and a paycheck
-- counted as negative discretionary spending: available to spend went up by the
-- size of the paycheck, the categoryPace median was computed against a category
-- nobody spends in, and the cash position credited a balance the money had
-- already been counted into.
--
-- Separate from `transfer` on purpose. Both are neutral against what you can
-- spend, but only `income` is the number `monthlyActual` predicts, and a report
-- that matches on the bucket survives somebody renaming the category.
--
-- The UPDATE heals what the seed always meant: `Income` shipped under
-- `transfer` because that was the only neutral bucket there was. Scoped to that
-- exact name and that exact bucket, so a category a person built themselves is
-- left alone -- the same shape as migration 009 turning on the whole-word switch
-- for the two rules whose trailing space was reaching for it.
--
-- Both statements are safe to run twice: the MODIFY names the whole list, and
-- the UPDATE finds nothing the second time. A test runs them again on purpose.

ALTER TABLE categories
  MODIFY COLUMN bucket
    ENUM('discretionary','fixed','lumpy','savings','transfer','income')
    NOT NULL DEFAULT 'discretionary';

UPDATE categories SET bucket = 'income' WHERE name = 'Income' AND bucket = 'transfer';
