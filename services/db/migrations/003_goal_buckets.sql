-- Each savings goal becomes its own bucket: what it holds now, and what it is
-- aiming at. A target is optional -- an open-ended fund like "keep adding to
-- the emergency account" has a balance worth tracking and nothing to reach.
ALTER TABLE savings_goals
  ADD COLUMN target_cents  BIGINT NULL AFTER percent,
  ADD COLUMN balance_cents BIGINT NOT NULL DEFAULT 0 AFTER target_cents;

-- Superseded by the per-goal balances above; the total is their sum.
DELETE FROM settings WHERE name = 'savings_balance_cents';
