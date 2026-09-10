import type { Category, Expense, IncomeStream } from "@lumpy/contracts";
import { PER_YEAR } from "@lumpy/contracts";
import { divRound, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISOMonth } from "./dates";
import { occurrences, occurrencesInMonth, extraPaycheckMonths, type Occurrence } from "./schedule";
import { bucketOf, categoryIndex, inWindow } from "./reports";

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

// ------------------------------------------------- the plan against the bank

/**
 * What really landed in `month`, as a positive number.
 *
 * A deposit is stored the way the importer writes it: a credit, so a negative
 * expense. It is reported here the way a person says it out loud, so the sign
 * is flipped exactly once, here, and nowhere else in the stack.
 */
export function depositedInMonth(
  expenses: Expense[],
  categories: Category[],
  month: ISOMonth,
): { cents: Cents; count: number } {
  const byId = categoryIndex(categories);
  const start = d.monthStart(month);
  const end = d.monthEnd(month);
  const rows = expenses.filter((e) => inWindow(e, start, end) && bucketOf(e, byId) === "income");
  // `0 -`, not unary minus: `-sum([])` is -0, which JSON hides and toEqual does
  // not, and a month with no deposits has deposited zero, not minus zero.
  return { cents: 0 - sum(rows.map((e) => e.amount_cents)), count: rows.length };
}

export type MonthDeposits = {
  month: ISOMonth;
  /** What the pay schedules say should have arrived. */
  planned_cents: Cents;
  /** What the statements say did. */
  deposited_cents: Cents;
  /** Deposited minus planned. Negative is a paycheck that did not land. */
  delta_cents: Cents;
  count: number;
  /** Whether any statement covers this month at all. */
  imported: boolean;
};

/**
 * The plan against the bank, month by month.
 *
 * Every other number in this app is derived from the pay schedules somebody
 * typed in once. This is the only one that asks whether they were right, which
 * matters because the whole allocation -- every bill parked on a paycheck, every
 * lumpy contribution carved out before it -- rests on them.
 *
 * A month with no transactions at all is reported as `imported: false` and a
 * delta of zero, not as a month you were not paid. It is the same rule
 * `fixedCostVariance` and `categoryPace` follow, and for the same reason: a
 * missing statement and a missing paycheck read identically in a red number and
 * need opposite responses.
 */
export function incomeReconciliation(
  streams: IncomeStream[],
  expenses: Expense[],
  categories: Category[],
  months: ISOMonth[],
): MonthDeposits[] {
  // Decided by every transaction, not only the deposits: a month whose statement
  // holds nothing but spending was still imported, and its missing paycheck is
  // a real finding.
  const importedMonths = new Set(expenses.map((e) => d.monthOf(e.txn_date)));
  return months.map((month) => {
    const planned = monthlyActual(streams, month);
    const imported = importedMonths.has(month);
    const { cents, count } = depositedInMonth(expenses, categories, month);
    return {
      month,
      planned_cents: planned,
      deposited_cents: cents,
      delta_cents: imported ? cents - planned : 0,
      count,
      imported,
    };
  });
}
