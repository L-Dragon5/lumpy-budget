import type { LumpyItem } from "@lumpy/contracts";
import { divRound, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISODate, ISOMonth } from "./dates";

export type LumpyPlan = {
  item: LumpyItem;
  /** amount / frequency_months. What it costs to carry once you are caught up. */
  steady_cents: Cents;
  /** Months from `from` until the next time it comes due. 0 means this month. */
  months_until_due: number;
  /** What you must set aside each month to have the full amount by the due date. */
  catch_up_cents: Cents;
  /** The number to actually save this month: the larger of the two. */
  recommended_cents: Cents;
  behind: boolean;
  /** How much of this item is already sitting in the fund. */
  already_covered_cents: Cents;
};

/**
 * Steady state is the honest long-run number. Catch-up is the honest number
 * *right now*: a $1,200 annual bill due in 3 months needs $400/mo, not $100/mo,
 * because you did not start saving for it a year ago.
 *
 * Money already in the fund is claimed by whatever comes due first, so an
 * account with a balance is not told to save as if it were empty.
 */
export function plan(items: LumpyItem[], fromMonth: ISOMonth, balanceCents: Cents = 0): LumpyPlan[] {
  const active = items.filter((i) => i.active);
  const from = d.monthStart(fromMonth);

  const withDue = active.map((item) => ({ item, due: nextDueOnOrAfter(item, from) }));
  // Soonest bills get first claim on the balance: that is the order they will spend it.
  const claimOrder = [...withDue].sort((a, b) => d.compare(a.due, b.due) || a.item.id - b.item.id);
  const covered = new Map<number, Cents>();
  let left = Math.max(0, balanceCents);
  for (const { item } of claimOrder) {
    const take = Math.min(left, item.amount_cents);
    covered.set(item.id, take);
    left -= take;
  }

  return withDue.map(({ item, due }) => {
    const steady = divRound(item.amount_cents, item.frequency_months);
    const monthsUntil = Math.max(0, d.monthsBetween(fromMonth, d.monthOf(due)));
    const needed = Math.max(0, item.amount_cents - (covered.get(item.id) ?? 0));
    const catchUp = monthsUntil <= 0 ? needed : divRound(needed, monthsUntil);
    return {
      item,
      steady_cents: steady,
      months_until_due: monthsUntil,
      catch_up_cents: catchUp,
      recommended_cents: Math.max(steady, catchUp),
      behind: catchUp > steady,
      already_covered_cents: covered.get(item.id) ?? 0,
    };
  });
}

export const steadyMonthlyTotal = (items: LumpyItem[], fromMonth: ISOMonth): Cents =>
  sum(plan(items, fromMonth).map((p) => p.steady_cents));

export const recommendedMonthlyTotal = (items: LumpyItem[], fromMonth: ISOMonth, balanceCents: Cents = 0): Cents =>
  sum(plan(items, fromMonth, balanceCents).map((p) => p.recommended_cents));

export type TimelineRow = {
  month: ISOMonth;
  balance_start_cents: Cents;
  contribution_cents: Cents;
  outflow_cents: Cents;
  balance_end_cents: Cents;
  /** What comes due this month, itemized. */
  due: { id: number; name: string; amount_cents: Cents; date: ISODate }[];
  /** True when the fund cannot cover this month's outflow. */
  short: boolean;
  shortfall_cents: Cents;
};

export type Timeline = {
  rows: TimelineRow[];
  monthly_contribution_cents: Cents;
  total_outflow_cents: Cents;
  worst_balance_cents: Cents;
  first_short_month: ISOMonth | null;
};

/**
 * The 12-month runway: what leaves the account each month, and what has to be
 * sitting in it on the 1st for that to be survivable.
 */
export function timeline(
  items: LumpyItem[],
  startMonth: ISOMonth,
  months: number,
  openingBalanceCents: Cents,
  mode: "steady" | "recommended" = "recommended",
): Timeline {
  const active = items.filter((i) => i.active);
  const contribution = sum(
    plan(active, startMonth, openingBalanceCents).map((p) =>
      mode === "steady" ? p.steady_cents : p.recommended_cents,
    ),
  );

  const monthsList = d.monthRange(startMonth, months);
  const lastMonth = monthsList[monthsList.length - 1]!;
  const dueByMonth = new Map<ISOMonth, TimelineRow["due"]>();
  for (const item of active) {
    for (const date of dueDates(item, d.monthStart(startMonth), d.monthEnd(lastMonth))) {
      const m = d.monthOf(date);
      const list = dueByMonth.get(m) ?? [];
      list.push({ id: item.id, name: item.name, amount_cents: item.amount_cents, date });
      dueByMonth.set(m, list);
    }
  }

  let balance = openingBalanceCents;
  let worst = openingBalanceCents;
  let firstShort: ISOMonth | null = null;
  const rows = monthsList.map((month) => {
    const due = (dueByMonth.get(month) ?? []).sort((a, b) => d.compare(a.date, b.date));
    const outflow = sum(due.map((x) => x.amount_cents));
    const start = balance;
    // Contribute on the 1st, pay the bills during the month.
    const end = start + contribution - outflow;
    const short = start + contribution < outflow;
    if (short && !firstShort) firstShort = month;
    worst = Math.min(worst, end);
    balance = end;
    return {
      month,
      balance_start_cents: start,
      contribution_cents: contribution,
      outflow_cents: outflow,
      balance_end_cents: end,
      due,
      short,
      shortfall_cents: short ? outflow - (start + contribution) : 0,
    };
  });

  return {
    rows,
    monthly_contribution_cents: contribution,
    total_outflow_cents: sum(rows.map((r) => r.outflow_cents)),
    worst_balance_cents: worst,
    first_short_month: firstShort,
  };
}

/** Roll next_due_date forward by frequency_months until it is >= `from`. */
export function nextDueOnOrAfter(item: LumpyItem, from: ISODate): ISODate {
  let cur = item.next_due_date;
  let guard = 0;
  while (d.compare(cur, from) < 0 && guard++ < 2000) cur = d.addMonthsToDate(cur, item.frequency_months);
  return cur;
}

export function dueDates(item: LumpyItem, start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  let cur = nextDueOnOrAfter(item, start);
  let guard = 0;
  while (d.compare(cur, end) <= 0 && guard++ < 2000) {
    out.push(cur);
    cur = d.addMonthsToDate(cur, item.frequency_months);
  }
  return out;
}
