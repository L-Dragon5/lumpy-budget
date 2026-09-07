import type { IncomeStream } from "@lumpy/contracts";
import { PER_YEAR } from "@lumpy/contracts";
import { divRound, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISOMonth } from "./dates";
import { occurrences, occurrencesInMonth, extraPaycheckMonths, type Occurrence } from "./schedule";

/** What actually lands in the account during `month`. */
export function monthlyActual(streams: IncomeStream[], month: ISOMonth): Cents {
  return sum(occurrencesInMonth(streams, month).map((o) => o.amount_cents));
}

/**
 * The flat monthly average (biweekly x 26/12, semimonthly x 24/12, ...).
 * Budget against this and the extra-paycheck months become surplus instead of
 * a number you quietly spend.
 */
export function monthlyNormalized(streams: IncomeStream[]): Cents {
  return sum(
    streams.filter((s) => s.active).map((s) => divRound(s.amount_cents * PER_YEAR[s.frequency], 12)),
  );
}

export type MonthIncome = {
  month: ISOMonth;
  occurrences: Occurrence[];
  total_cents: Cents;
  normalized_cents: Cents;
  surplus_cents: Cents;
  extra_paycheck: boolean;
};

/** Twelve months of a year, flagged where an extra paycheck lands. */
export function incomeCalendar(streams: IncomeStream[], year: number): MonthIncome[] {
  const active = streams.filter((s) => s.active);
  const extras = new Set(active.flatMap((s) => extraPaycheckMonths(s, year)));
  const normalized = monthlyNormalized(active);
  return d.monthRange(`${year}-01`, 12).map((month) => {
    const occ = occurrencesInMonth(active, month);
    const total = sum(occ.map((o) => o.amount_cents));
    return {
      month,
      occurrences: occ,
      total_cents: total,
      normalized_cents: normalized,
      surplus_cents: total - normalized,
      extra_paycheck: extras.has(month),
    };
  });
}

/** Next pay date on or after `from`, across all streams. */
export function nextPaycheck(streams: IncomeStream[], from: string): Occurrence | null {
  const horizon = d.addDays(from, 45);
  const all = streams
    .filter((s) => s.active)
    .flatMap((s) => occurrences(s, from, horizon))
    .sort((a, b) => d.compare(a.date, b.date));
  return all[0] ?? null;
}
