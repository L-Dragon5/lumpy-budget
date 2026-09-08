-- A lumpy item can say how it posts on a statement, the same way a fixed cost can.
--
-- The fund's schedule heals itself and its balance cannot: nextDueOnOrAfter rolls
-- a passed due date forward, while the balance still claims the money is sitting
-- there, so the app quietly recommends saving less. Naming the charge closes that
-- loop -- the payment can be found in the expenses that are already imported, and
-- recording it becomes one button instead of a remembered chore.
--
-- Both columns are exactly `fixed_costs.merchant_pattern` and
-- `fixed_costs.merchant_whole_word`, matched by the same `matchesPattern`, because
-- a bill that reconciles has to be a transaction the importer would have
-- categorised the same way.

ALTER TABLE lumpy_items
  ADD COLUMN merchant_pattern    VARCHAR(160) NULL,
  ADD COLUMN merchant_whole_word BOOLEAN NOT NULL DEFAULT FALSE;
