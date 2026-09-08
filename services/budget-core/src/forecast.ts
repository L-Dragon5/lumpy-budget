import type { FixedCost, IncomeStream, LumpyItem, SavingsGoal } from "@lumpy/contracts";
import { sum, type Cents } from "./money";
import type { ISOMonth } from "./dates";
import { monthlyActual, monthlyNormalized } from "./income";
import { savingsMonthlyTotal } from "./savings";
import { timeline } from "./lumpy";

/**
 * The same arithmetic `monthSummary` does for one month, run forward over
 * twelve. "Can I afford the trip in March" is a question the engine can already
 * answer and the app could not ask: every input is a schedule, so every month
 * between here and there is knowable.
 *
 * What it is not is a spend forecast. There are no transactions in a month that
 * has not happened, so every row is *planned* free cash: income, less the bills,
 * less what the lumpy fund and the savings goals take. What you then spend out
 * of it is the part nobody can project, and pretending otherwise would make the
 * only honest number on the page a guess.
 */

export type ForecastRow = {
  month: ISOMonth;
  income_cents: Cents;
  /** The normalized average, so an extra-paycheck month reads as surplus. */
  income_normalized_cents: Cents;
  extra_paycheck: boolean;
  fixed_cents: Cents;
  lumpy_cents: Cents;
  savings_cents: Cents;
  planned_free_cents: Cents;
  /** What actually leaves the lumpy fund that month, itemized. */
  lumpy_due_cents: Cents;
  lumpy_due: { name: string; amount_cents: Cents }[];
  lumpy_balance_end_cents: Cents;
  /** The fund cannot cover that month's outflow. */
  lumpy_short: boolean;
  /** The plan does not balance: the commitments outrun the income. */
  tight: boolean;
};

export type Forecast = {
  rows: ForecastRow[];
  total_free_cents: Cents;
  average_free_cents: Cents;
  /** The leanest month in the window, which is the one worth knowing about. */
  tightest_month: ISOMonth | null;
  first_tight_month: ISOMonth | null;
  first_short_month: ISOMonth | null;
};

export type ForecastInputs = {
  streams: IncomeStream[];
  fixedCosts: FixedCost[];
  lumpyItems: LumpyItem[];
  savingsGoals: SavingsGoal[];
  start: ISOMonth;
  months: number;
  lumpyMode?: "steady" | "recommended";
  lumpyOpeningBalanceCents?: Cents;
};

export function forecast(input: ForecastInputs): Forecast {
  const months = Math.max(1, input.months);
  const mode = input.lumpyMode ?? "recommended";
  const opening = input.lumpyOpeningBalanceCents ?? 0;

  // One timeline for the whole window rather than a plan per month: the
  // contribution is decided once, from where the fund stands today, which is
  // exactly what the dashboard and the lumpy page already show.
  const fund = timeline(input.lumpyItems, input.start, months, opening, mode);
  const fixed = sum(input.fixedCosts.filter((c) => c.active).map((c) => c.amount_cents));
  const normalized = monthlyNormalized(input.streams);

  const rows = fund.rows.map((f): ForecastRow => {
    const income = monthlyActual(input.streams, f.month);
    // Percent goals move with the month's income, so this cannot be hoisted.
    const savings = savingsMonthlyTotal(input.savingsGoals, income);
    const free = income - fixed - f.contribution_cents - savings;
    return {
      month: f.month,
      income_cents: income,
      income_normalized_cents: normalized,
      extra_paycheck: income > normalized,
      fixed_cents: fixed,
      lumpy_cents: f.contribution_cents,
      savings_cents: savings,
      planned_free_cents: free,
      lumpy_due_cents: f.outflow_cents,
      lumpy_due: f.due.map((x) => ({ name: x.name, amount_cents: x.amount_cents })),
      lumpy_balance_end_cents: f.balance_end_cents,
      lumpy_short: f.short,
      tight: free < 0,
    };
  });

  const leanest = rows.reduce<ForecastRow | null>(
    (worst, r) => (worst === null || r.planned_free_cents < worst.planned_free_cents ? r : worst),
    null,
  );

  return {
    rows,
    total_free_cents: sum(rows.map((r) => r.planned_free_cents)),
    average_free_cents: rows.length === 0 ? 0 : Math.round(sum(rows.map((r) => r.planned_free_cents)) / rows.length),
    tightest_month: leanest?.month ?? null,
    first_tight_month: rows.find((r) => r.tight)?.month ?? null,
    first_short_month: fund.first_short_month,
  };
}

/**
 * What a one-off purchase would do to the window: the months it would leave
 * short if you paid for it out of a single month's free cash.
 *
 * ponytail: no scenario builder, no saved what-ifs. One number in, the months
 * that could absorb it out. Add persistence the day somebody wants to compare
 * two of them side by side.
 */
export const monthsThatCanAfford = (f: Forecast, costCents: Cents): ISOMonth[] =>
  f.rows.filter((r) => r.planned_free_cents >= costCents).map((r) => r.month);

/** Months from `start` until the free cash adds up to `costCents`, or null if it never does. */
export function monthsToAfford(f: Forecast, costCents: Cents): number | null {
  let running = 0;
  for (let i = 0; i < f.rows.length; i++) {
    running += Math.max(0, f.rows[i]!.planned_free_cents);
    if (running >= costCents) return i + 1;
  }
  return null;
}
