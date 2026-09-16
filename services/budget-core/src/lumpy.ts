import { matchesPattern, needleOf } from "@lumpy/contracts";
import type { Expense, LumpyItem } from "@lumpy/contracts";
import { divRound, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISODate, ISOMonth } from "./dates";

export type LumpyPlan = {
  item: LumpyItem;
  /** amount / frequency_months. What it costs to carry once you are caught up. */
  steady_cents: Cents;
  /** Months from `from` until the next time it comes due. 0 means this month. */
  months_until_due: number;
};

/** What each item costs to carry, and when it next comes due. */
export function plan(items: LumpyItem[], fromMonth: ISOMonth): LumpyPlan[] {
  const from = d.monthStart(fromMonth);
  return items
    .filter((i) => i.active)
    .map((item) => ({
      item,
      steady_cents: divRound(item.amount_cents, item.frequency_months),
      months_until_due: Math.max(0, d.monthsBetween(fromMonth, d.monthOf(nextDueOnOrAfter(item, from)))),
    }));
}

export type FundPlan = {
  /** The flat long-run cost: every item's amount over its cycle, added up. */
  steady_cents: Cents;
  /** What to actually save each month, flat, so the fund never runs dry. */
  required_cents: Cents;
  /** `required - steady`. Zero whenever the flat amount is already enough. */
  catch_up_cents: Cents;
  /** The hole: the deepest the flat amount alone would put the fund below zero. */
  short_by_cents: Cents;
  /** The month it would run dry on the flat amount. Null when it never does. */
  short_month: ISOMonth | null;
  /** How far the check ran: the month the last item first comes due. */
  through_month: ISOMonth;
};

/**
 * What the fund has to be paid each month, as one flat number.
 *
 * The question is cash flow, not bookkeeping: walk every occurrence in due
 * order and ask what constant monthly contribution keeps the balance from ever
 * going negative. For a contribution C on the 1st of month k, the fund has
 * `balance + C * (k + 1)` to have paid `cumulative outflow through month k`, so
 * every month sets a floor of `(cumulative - balance) / (k + 1)` and the answer
 * is the largest of those floors, or the flat cost if none of them is bigger.
 *
 * Doing it per item and adding the results up -- which is what this used to do --
 * over-collects, and keeps over-collecting forever. Each item was told to fund
 * itself from scratch by its own due date, so a bill 10 months out ignored the
 * ten contributions that arrive before it, and the balance could only be claimed
 * once, by whatever came due first. On a real fund that ran about $1,200 a year
 * above the bills and settled into a balance that never came back down. The
 * timeline dipping to nearly zero at the tightest month is the point: that is
 * what a fund with nothing spare in it looks like.
 *
 * The window runs to the last of every item's *next* occurrence, which is as far
 * as being behind can reach -- past that, steady state is the whole story.
 */
export function fundPlan(items: LumpyItem[], fromMonth: ISOMonth, balanceCents: Cents = 0): FundPlan {
  const active = items.filter((i) => i.active);
  const steady = sum(active.map((i) => divRound(i.amount_cents, i.frequency_months)));
  const flat: FundPlan = {
    steady_cents: steady,
    required_cents: steady,
    catch_up_cents: 0,
    short_by_cents: 0,
    short_month: null,
    through_month: fromMonth,
  };
  if (active.length === 0) return flat;

  const from = d.monthStart(fromMonth);
  const through = d.monthOf(active.map((i) => nextDueOnOrAfter(i, from)).sort(d.compare).at(-1)!);
  const outflow = new Map<ISOMonth, Cents>();
  for (const item of active) {
    for (const date of dueDates(item, from, d.monthEnd(through))) {
      const m = d.monthOf(date);
      outflow.set(m, (outflow.get(m) ?? 0) + item.amount_cents);
    }
  }

  // A negative balance is not money the fund can spend, and an overdrawn savings
  // account is somebody else's problem; treat it as empty, the way plan always has.
  const balance = Math.max(0, balanceCents);
  let cumulative = 0;
  let required = steady;
  let shortBy = 0;
  let shortMonth: ISOMonth | null = null;
  d.monthRange(fromMonth, d.monthsBetween(fromMonth, through) + 1).forEach((month, k) => {
    cumulative += outflow.get(month) ?? 0;
    // Ceiling, not round: a contribution half a cent light is a fund that is short.
    required = Math.max(required, Math.ceil((cumulative - balance) / (k + 1)));
    const short = cumulative - balance - steady * (k + 1);
    if (short > shortBy) {
      shortBy = short;
      shortMonth = month;
    }
  });

  return {
    ...flat,
    required_cents: required,
    catch_up_cents: required - steady,
    short_by_cents: shortBy,
    short_month: shortMonth,
    through_month: through,
  };
}

export const steadyMonthlyTotal = (items: LumpyItem[], fromMonth: ISOMonth): Cents =>
  sum(plan(items, fromMonth).map((p) => p.steady_cents));

export const recommendedMonthlyTotal = (items: LumpyItem[], fromMonth: ISOMonth, balanceCents: Cents = 0): Cents =>
  fundPlan(items, fromMonth, balanceCents).required_cents;

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
  const fund = fundPlan(active, startMonth, openingBalanceCents);
  const contribution = mode === "steady" ? fund.steady_cents : fund.required_cents;

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

// ------------------------------------------------- payments already imported

export type LumpyPayment = {
  item: LumpyItem;
  /** The occurrence this charge answers for: the item's stored next_due_date. */
  due_date: ISODate;
  /** What next_due_date becomes once the payment is recorded. */
  rolls_to: ISODate;
  expense: { id: number; txn_date: ISODate; merchant: string; amount_cents: Cents };
  /** Days between the due date and the charge. Negative means it posted early. */
  days_off: number;
  /** Charged minus planned. Positive means the bill went up. */
  delta_cents: Cents;
};

/** The same haystack the importer matches category_rules against. */
const hay = (e: Pick<Expense, "merchant" | "description">): string =>
  `${e.merchant} ${e.description ?? ""}`.toLowerCase();

/**
 * Lumpy bills the statements show as already paid.
 *
 * `next_due_date` in the database is the occurrence nobody has recorded yet --
 * the engine rolls a passed due date forward when it reads (`nextDueOnOrAfter`),
 * but the stored column only moves when a person moves it, and the balance never
 * moves at all. So the day the insurance is actually paid, the fund still claims
 * the money is sitting there and the recommended contribution quietly drops. This
 * finds the charge that proves otherwise: a transaction matching the item's
 * `merchant_pattern`, landing near the stored due date, already imported.
 *
 * Nothing is written from here. The page offers the roll-forward and the new
 * balance, and a person presses it -- the same rule the recurring detector
 * follows, and what lets both of them match on a pattern rather than on proof.
 *
 * The window is capped at half a cycle, so a monthly item cannot be reconciled by
 * next month's charge. Only charges dated on or before `today` count: money that
 * has not left the account is not a payment. Refunds and reversals (a negative
 * amount) are not payments either.
 */
export function lumpyPayments(
  items: LumpyItem[],
  expenses: Expense[],
  opts: { today: ISODate; windowDays?: number },
): LumpyPayment[] {
  const today = d.assertDate(opts.today);
  const maxWindow = opts.windowDays ?? 45;

  const out: LumpyPayment[] = [];
  for (const item of items) {
    if (!item.active) continue;
    const pattern = (item.merchant_pattern ?? "").trim();
    if (pattern.length === 0) continue;
    const needle = needleOf(pattern);
    // Half a cycle: past that, the nearer due date is the next one, not this one.
    const window = Math.min(maxWindow, Math.floor((item.frequency_months * 30) / 2));

    const due = item.next_due_date;
    const hits = expenses.filter(
      (e) =>
        e.amount_cents > 0 &&
        d.compare(e.txn_date, today) <= 0 &&
        Math.abs(d.diffDays(due, e.txn_date)) <= window &&
        matchesPattern(hay(e), needle, item.merchant_whole_word),
    );
    if (hits.length === 0) continue;

    // Closest to the due date wins; the later charge breaks a tie, then the id,
    // so the answer does not depend on the order the rows came back in.
    const best = hits.reduce((a, b) => {
      const da = Math.abs(d.diffDays(due, a.txn_date));
      const db = Math.abs(d.diffDays(due, b.txn_date));
      if (da !== db) return da < db ? a : b;
      const byDate = d.compare(b.txn_date, a.txn_date);
      return byDate !== 0 ? (byDate > 0 ? b : a) : b.id > a.id ? b : a;
    });

    out.push({
      item,
      due_date: due,
      rolls_to: d.addMonthsToDate(due, item.frequency_months),
      expense: {
        id: best.id,
        txn_date: best.txn_date,
        merchant: best.merchant,
        amount_cents: best.amount_cents,
      },
      days_off: d.diffDays(due, best.txn_date),
      delta_cents: best.amount_cents - item.amount_cents,
    });
  }

  // Oldest due date first: the one that has been wrong longest is the one to fix.
  return out.sort((a, b) => d.compare(a.due_date, b.due_date) || a.item.id - b.item.id);
}
