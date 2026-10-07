import type { Category, Expense, FixedCost, IncomeStream, LumpyItem, SavingsGoal } from "@lumpy/contracts";
import { divRound, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISODate, ISOMonth } from "./dates";
import { allOccurrences } from "./schedule";
import { monthlyActual, monthlyNormalized } from "./income";
import { recommendedMonthlyTotal, steadyMonthlyTotal } from "./lumpy";
import { monthlySavings, savingsMonthlyTotal } from "./savings";
import { allocateMonth, type PaycheckPlan } from "./fixed";
import { bucketOf, categoryIndex, inWindow, totalsByBucket, type BucketTotals } from "./reports";

export type BudgetInputs = {
  streams: IncomeStream[];
  fixedCosts: FixedCost[];
  lumpyItems: LumpyItem[];
  savingsGoals: SavingsGoal[];
  expenses: Expense[];
  categories: Category[];
  month: ISOMonth;
  /** Use steady-state lumpy contributions instead of catch-up. */
  lumpyMode?: "steady" | "recommended";
  /** What is already sitting in the lumpy-fund savings account. */
  lumpyOpeningBalanceCents?: number;
};

export type PeriodSummary = {
  label: string;
  start: ISODate;
  end: ISODate;
  stream_name: string;
  income_cents: Cents;
  fixed_cents: Cents;
  lumpy_cents: Cents;
  savings_cents: Cents;
  planned_free_cents: Cents;
  spent_discretionary_cents: Cents;
  /** Last month's overspend, on the month's first paycheck only. Zero or negative. */
  carryover_cents: Cents;
  available_cents: Cents;
  holds: PaycheckPlan["holds"];
  over_committed: boolean;
};

export type MonthSummary = {
  month: ISOMonth;
  income_cents: Cents;
  income_normalized_cents: Cents;
  surplus_cents: Cents;
  extra_paycheck: boolean;
  fixed_cents: Cents;
  lumpy_cents: Cents;
  lumpy_steady_cents: Cents;
  savings_cents: Cents;
  planned_free_cents: Cents;
  spent: BucketTotals;
  /** Last month's own overspend, carried one month and no further. Zero or negative. */
  carryover_cents: Cents;
  carryover_from: ISOMonth;
  available_cents: Cents;
  paychecks: PaycheckPlan[];
  periods: PeriodSummary[];
  savings_breakdown: { name: string; amount_cents: Cents }[];
  unfunded: { name: string; amount_cents: Cents }[];
  /**
   * Why the paycheck periods do not sum to the month. The month asks what this
   * calendar month costs; a period asks what one paycheck has to cover until the
   * next. They differ by exactly these, and the scenario lane checks that:
   * sum(periods.available) = available + held_last_month + unfunded
   *   - held_for_next_month + spent_outside_periods. Zero-sum when there are no periods.
   */
  periods_vs_month: {
    /** This month's bills set aside from last month's paychecks: in the month, in no period. */
    held_last_month_cents: Cents;
    /** Next month's bills these paychecks set aside: in a period, not in the month. */
    held_for_next_month_cents: Cents;
    /** Bills no paycheck can reach: in the month, in no period. */
    unfunded_cents: Cents;
    /** The month's discretionary spending minus the periods'. Before the first payday, or past month end. */
    spent_outside_periods_cents: Cents;
  };
};

/** How far past month end the last period may run, and so how far `expenses` has to reach. */
export const PERIOD_HORIZON_DAYS = 45;

/**
 * The whole month in one object. Only discretionary spending is subtracted from
 * what is available: a mortgage payment that shows up in an imported statement is
 * the fixed cost being *paid*, not a second, extra expense.
 *
 * A month that ended below zero is carried into the next one, once. The carry is
 * the previous month's *own* result (`ownMonth`, which never looks back), so a
 * deficit reaches one month and stops there instead of chaining forever; a
 * surplus is never carried. A previous month with no transactions at all was
 * never imported, and its "result" is just the plan with nothing spent against
 * it, so it carries nothing -- the same reason `monthsWithoutStatements` exists.
 * `expenses` has to include the previous month for any of this to fire.
 */
export function monthSummary(input: BudgetInputs): MonthSummary {
  const prev = d.addMonths(input.month, -1);
  const imported = input.expenses.some((e) => inWindow(e, d.monthStart(prev), d.monthEnd(prev)));
  const prevAvailable = imported ? ownMonth({ ...input, month: prev }, 0).available_cents : 0;
  // A ternary, not Math.min: Math.min(0, -0) is -0, which JSON hides and toBe does not.
  return ownMonth(input, prevAvailable < 0 ? prevAvailable : 0);
}

/** The month's paycheck allocation, with the same lumpy and savings figures its own summary uses. */
function planMonth(input: BudgetInputs, month: ISOMonth) {
  const { streams, fixedCosts, lumpyItems, savingsGoals } = input;
  const income = monthlyActual(streams, month);
  const lumpy = (input.lumpyMode ?? "recommended") === "steady"
    ? steadyMonthlyTotal(lumpyItems, month)
    : recommendedMonthlyTotal(lumpyItems, month, input.lumpyOpeningBalanceCents ?? 0);
  const savings = savingsMonthlyTotal(savingsGoals, income);
  const alloc = allocateMonth({ streams, fixedCosts, month, lumpyMonthlyCents: lumpy, savingsMonthlyCents: savings });
  return { income, lumpy, savings, alloc };
}

/** Same date and stream can be two paychecks (a clamp onto Feb 28), so the key counts them. */
function paycheckKeys(paychecks: PaycheckPlan[]): string[] {
  const seen = new Map<string, number>();
  return paychecks.map((p) => {
    const k = `${p.date}|${p.stream_id}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${k}|${n}`;
  });
}

function ownMonth(input: BudgetInputs, carry: Cents): MonthSummary {
  const { streams, fixedCosts, lumpyItems, savingsGoals, expenses, categories, month } = input;

  const normalized = monthlyNormalized(streams, month);
  const { income, lumpy, savings, alloc } = planMonth(input, month);
  // A late-month paycheck is what pays next month's early bills, and next month's
  // allocation is the one that says so. Without these its period reads as free money.
  const nextPlan = planMonth(input, d.addMonths(month, 1)).alloc.paychecks.filter((p) => p.prior_month);
  const nextKeys = paycheckKeys(nextPlan);
  const heldForNext = new Map(nextPlan.map((p, i) => [nextKeys[i]!, p.holds]));

  // Only bills actually due this month count against this month.
  const fixedDue = sum(fixedCosts.filter((f) => f.active).map((f) => f.amount_cents));

  const start = d.monthStart(month);
  const end = d.monthEnd(month);
  const monthExpenses = expenses.filter((e) => inWindow(e, start, end));
  const spent = totalsByBucket(monthExpenses, categories);

  const plannedFree = income - fixedDue - lumpy - savings;
  const periods = periodSummaries(input, alloc.paychecks, carry, heldForNext);
  const total = (k: keyof PeriodSummary) => sum(periods.map((p) => p[k] as number));
  const holdsIn = (ps: PaycheckPlan[]) => sum(ps.map((p) => p.hold_total_cents));
  const periodsVsMonth = periods.length === 0
    ? { held_last_month_cents: 0, held_for_next_month_cents: 0, unfunded_cents: 0, spent_outside_periods_cents: 0 }
    : {
        held_last_month_cents: holdsIn(alloc.paychecks.filter((p) => p.prior_month)),
        held_for_next_month_cents: total("fixed_cents") - holdsIn(alloc.paychecks.filter((p) => !p.prior_month)),
        unfunded_cents: sum(alloc.unfunded.map((h) => h.amount_cents)),
        spent_outside_periods_cents: spent.discretionary - total("spent_discretionary_cents"),
      };

  return {
    month,
    income_cents: income,
    income_normalized_cents: normalized,
    surplus_cents: income - normalized,
    extra_paycheck: income > normalized,
    fixed_cents: fixedDue,
    lumpy_cents: lumpy,
    lumpy_steady_cents: steadyMonthlyTotal(lumpyItems, month),
    savings_cents: savings,
    planned_free_cents: plannedFree,
    spent,
    carryover_cents: carry,
    carryover_from: d.addMonths(month, -1),
    available_cents: plannedFree + carry - spent.discretionary,
    paychecks: alloc.paychecks,
    periods,
    savings_breakdown: monthlySavings(savingsGoals, income).map((g) => ({
      name: g.goal.name,
      amount_cents: g.amount_cents,
    })),
    unfunded: alloc.unfunded.map((h) => ({ name: h.name, amount_cents: h.amount_cents })),
    periods_vs_month: periodsVsMonth,
  };
}

/**
 * One row per paycheck in the month. A period runs from the day the money lands
 * until the day before the next paycheck, which is how the money is really spent,
 * and it holds every bill that paycheck sets aside, next month's included
 * (`heldForNext`, keyed by `paycheckKeys`). That is cash flow, not the calendar
 * month, so the periods do not sum to the month: `periods_vs_month` says by how
 * much. The first period takes the month's carryover.
 */
export function periodSummaries(
  input: BudgetInputs,
  paychecks: PaycheckPlan[],
  carry: Cents = 0,
  heldForNext: Map<string, PaycheckPlan["holds"]> = new Map(),
): PeriodSummary[] {
  const { streams, expenses, categories, month } = input;
  const byId = categoryIndex(categories);
  const inMonth = paychecks.filter((p) => !p.prior_month);
  const keys = paycheckKeys(inMonth);

  // Look ahead so the last period of the month ends at the next real paycheck.
  const horizon = d.addDays(d.monthEnd(month), PERIOD_HORIZON_DAYS);
  const future = allOccurrences(streams.filter((s) => s.active), d.monthStart(month), horizon);

  return inMonth.map((p, i) => {
    const next = future.find((o) => d.compare(o.date, p.date) > 0);
    const end = next ? d.addDays(next.date, -1) : d.monthEnd(month);
    const spentDiscretionary = sum(
      expenses
        .filter((e) => inWindow(e, p.date, end) && bucketOf(e, byId) === "discretionary")
        .map((e) => e.amount_cents),
    );
    const nextHolds = heldForNext.get(keys[i]!) ?? [];
    const nextTotal = sum(nextHolds.map((h) => h.amount_cents));
    const plannedFree = p.free_cents - nextTotal;
    const carryover = i === 0 ? carry : 0;
    return {
      label: `${p.stream_name} ${p.date}`,
      start: p.date,
      end,
      stream_name: p.stream_name,
      income_cents: p.amount_cents,
      fixed_cents: p.hold_total_cents + nextTotal,
      lumpy_cents: p.lumpy_cents,
      savings_cents: p.savings_cents,
      planned_free_cents: plannedFree,
      spent_discretionary_cents: spentDiscretionary,
      carryover_cents: carryover,
      available_cents: plannedFree + carryover - spentDiscretionary,
      holds: [...p.holds, ...nextHolds],
      over_committed: plannedFree < 0,
    };
  });
}

export type PeriodPace = {
  /** 1-based day of the period. Day 1 is payday itself. */
  day: number;
  days: number;
  days_left: number;
  /** How far through the period you are, 0..1. */
  day_share: number;
  /** How much of the plan is already spent. Past 1 when the plan is blown. */
  spent_share: number;
  /** What would have been spent by now at an even burn. */
  on_track_cents: Cents;
  /** Spent minus on-track. Positive is spending faster than the days are passing. */
  delta_cents: Cents;
  /** What is left, spread over the days left. Negative when there is nothing left. */
  daily_left_cents: Cents;
  status: "under" | "on_track" | "over";
};

/**
 * Am I okay *right now*.
 *
 * Every other number in this app compares a plan to a month that is over or a
 * month that has not started. This one compares the plan to the day it is: four
 * days into a fourteen-day period with 70% of the money gone is the only signal
 * that arrives while there is still something to do about it.
 *
 * Null outside the period, which is what makes "the current one" a filter rather
 * than an argument the caller has to work out. `today` is passed in because
 * budget-core does not read a clock.
 */
export function periodPace(
  period: Pick<PeriodSummary, "start" | "end" | "planned_free_cents" | "spent_discretionary_cents">
    & Partial<Pick<PeriodSummary, "carryover_cents">>,
  today: ISODate,
): PeriodPace | null {
  if (d.compare(today, period.start) < 0 || d.compare(today, period.end) > 0) return null;

  const days = d.diffDays(period.start, period.end) + 1;
  const day = d.diffDays(period.start, today) + 1;
  const daysLeft = days - day + 1;
  // Last month's overspend is money this period no longer has to spend.
  const planned = period.planned_free_cents + (period.carryover_cents ?? 0);
  const spent = period.spent_discretionary_cents;
  const dayShare = day / days;
  const onTrack = Math.round(planned * dayShare);
  const delta = spent - onTrack;
  // A tolerance rather than a knife edge: $12 either side of pace on day three is
  // noise, and a tile that flips colour every afternoon stops being read.
  const slack = Math.max(2000, Math.round(Math.abs(planned) * 0.05));

  return {
    day,
    days,
    days_left: daysLeft,
    day_share: dayShare,
    spent_share: planned === 0 ? (spent === 0 ? 0 : 1) : spent / planned,
    on_track_cents: onTrack,
    delta_cents: delta,
    daily_left_cents: divRound(planned - spent, daysLeft),
    status: delta > slack ? "over" : delta < -slack ? "under" : "on_track",
  };
}

/** The period `today` falls in, if any. The dashboard's "this paycheck" row. */
export const currentPeriod = (periods: PeriodSummary[], today: ISODate): PeriodSummary | null =>
  periods.find((p) => d.compare(today, p.start) >= 0 && d.compare(today, p.end) <= 0) ?? null;
