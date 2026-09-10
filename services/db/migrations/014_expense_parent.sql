-- One charge, more than one category.
--
-- A Costco run is half groceries and half household, and until now the row could
-- only be one of them. A split keeps the imported row exactly where it is and
-- gives it children: ordinary expenses that carry `parent_id`. The parent is
-- filtered out of every expense read, so `breakdown`, `categoryPace`,
-- `totalsByBucket` and the variance report see two ordinary rows and needed no
-- change at all.
--
-- The parent is kept rather than deleted because it holds the `dedupe_hash`.
-- Delete it and the next overlapping statement re-inserts the charge whole,
-- beside the halves somebody already split it into, and the month is counted
-- twice. Keeping it is the entire reason a re-import is still a no-op.
--
-- There is no `split` boolean. "Has children" is the question, and asking the
-- rows directly is one column instead of two and an invariant that cannot drift.
--
-- ON DELETE CASCADE, so deleting the charge deletes its parts, and deleting the
-- import batch still takes everything that came in with it. The self-reference
-- is why `restore()` inserts expenses in ascending id order: a child is always
-- created after its parent, so ascending id is parents-first.

ALTER TABLE expenses
  ADD COLUMN parent_id INT UNSIGNED NULL,
  ADD KEY idx_expenses_parent (parent_id),
  ADD CONSTRAINT fk_expense_parent FOREIGN KEY (parent_id) REFERENCES expenses(id) ON DELETE CASCADE;
