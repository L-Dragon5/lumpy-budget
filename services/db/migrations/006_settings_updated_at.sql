-- When a hand-kept balance was last told the truth. The lumpy fund's balance is
-- typed in by a person, so it goes stale the moment a lumpy bill is actually
-- paid; without a timestamp there is no way to say how much has left the account
-- since. MySQL only bumps ON UPDATE when the row really changes, so re-saving the
-- same number does not reset the window, which is the behaviour we want.
ALTER TABLE settings
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
