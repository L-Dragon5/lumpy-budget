-- An income stream had one date and it was the anchor: the day the schedule
-- counts from, forward *and* back. A job started in June therefore paid all the
-- way back through January, and every month before it was hired read as a
-- paycheck that never landed -- a red delta on /income-calendar, a surplus of
-- minus the whole normalized figure, and a forecast that never happened.
--
-- `active` is not the answer to that: it is the manual off switch, and
-- switching an old job off takes its past deposits with it, which is the same
-- lie pointing the other way. So the window is its own pair of dates, both
-- NULL by default -- every stream that already exists keeps paying forever in
-- both directions, which is what it did yesterday.
ALTER TABLE income_streams
  ADD COLUMN starts_on DATE NULL AFTER anchor_date,
  ADD COLUMN ends_on   DATE NULL AFTER starts_on;
