import type { Category, Expense, FixedCost, IncomeStream, LumpyItem, SavingsGoal } from "@lumpy/contracts";
import { sum, type Cents } from "./money";
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
  available_cents: Cents;
  paychecks: PaycheckPlan[];
  periods: PeriodSummary[];
  savings_breakdown: { name: string; amount_cents: Cents }[];
  unfunded: { name: string; amount_cents: Cents }[];
};

/**
 * The whole month in one object. Only discretionary spending is subtracted from
 * what is available: a mortgage payment that shows up in an imported statement is
 * the fixed cost being *paid*, not a second, extra expense.
 */
export function monthSummary(input: BudgetInputs): MonthSummary {
  const { streams, fixedCosts, lumpyItems, savingsGoals, expenses, categories, month } = input;
  const mode = input.lumpyMode ?? "recommended";

  const income = monthlyActual(streams, month);
  const normalized = monthlyNormalized(streams);
  const lumpy = mode === "steady"
    ? steadyMonthlyTotal(lumpyItems, month)
    : recommendedMonthlyTotal(lumpyItems, month, input.lumpyOpeningBalanceCents ?? 0);
  const savings = savingsMonthlyTotal(savingsGoals, income);

  const alloc = allocateMonth({
    streams,
    fixedCosts,
    month,
    lumpyMonthlyCents: lumpy,
    savingsMonthlyCents: savings,
  });

  // Only bills actually due this month count against this month.
  const fixedDue = sum(fixedCosts.filter((f) => f.active).map((f) => f.amount_cents));

  const start = d.monthStart(month);
  const end = d.monthEnd(month);
  const monthExpenses = expenses.filter((e) => inWindow(e, start, end));
  const spent = totalsByBucket(monthExpenses, categories);

  const plannedFree = income - fixedDue - lumpy - savings;

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
    available_cents: plannedFree - spent.discretionary,
    paychecks: alloc.paychecks,
    periods: periodSummaries(input, alloc.paychecks),
    savings_breakdown: monthlySavings(savingsGoals, income).map((g) => ({
      name: g.goal.name,
      amount_cents: g.amount_cents,
    })),
    unfunded: alloc.unfunded.map((h) => ({ name: h.name, amount_cents: h.amount_cents })),
  };
}

/**
 * One row per paycheck in the month. A period runs from the day the money lands
 * until the day before the next paycheck, which is how the money is really spent.
 */
export function periodSummaries(input: BudgetInputs, paychecks: PaycheckPlan[]): PeriodSummary[] {
  const { streams, expenses, categories, month } = input;
  const byId = categoryIndex(categories);
  const inMonth = paychecks.filter((p) => !p.prior_month);

  // Look ahead so the last period of the month ends at the next real paycheck.
  const horizon = d.addDays(d.monthEnd(month), 45);
  const future = allOccurrences(streams.filter((s) => s.active), d.monthStart(month), horizon);

  return inMonth.map((p) => {
    const next = future.find((o) => d.compare(o.date, p.date) > 0);
    const end = next ? d.addDays(next.date, -1) : d.monthEnd(month);
    const spentDiscretionary = sum(
      expenses
        .filter((e) => inWindow(e, p.date, end) && bucketOf(e, byId) === "discretionary")
        .map((e) => e.amount_cents),
    );
    const plannedFree = p.free_cents;
    return {
      label: `${p.stream_name} ${p.date}`,
      start: p.date,
      end,
      stream_name: p.stream_name,
      income_cents: p.amount_cents,
      fixed_cents: p.hold_total_cents,
      lumpy_cents: p.lumpy_cents,
      savings_cents: p.savings_cents,
      planned_free_cents: plannedFree,
      spent_discretionary_cents: spentDiscretionary,
      available_cents: plannedFree - spentDiscretionary,
      holds: p.holds,
      over_committed: p.over_committed,
    };
  });
}
