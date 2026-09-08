-- A gift, a bonus, a savings withdrawal: money that lands once, on a date, and
-- never repeats. It rides the income_streams table because everything downstream
-- (occurrences, allocation, the calendar) already works off one anchor date.
ALTER TABLE income_streams
  MODIFY frequency ENUM('weekly','biweekly','semimonthly','monthly','annual','one_time') NOT NULL;
