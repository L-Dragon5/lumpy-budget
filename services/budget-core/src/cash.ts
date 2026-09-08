import { sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISODate } from "./dates";
import type { Hold, PaycheckPlan } from "./fixed";

/**
 * The one thing this app never knew: how much money is actually there.
 *
 * Everything else is derived from a plan -- what income is scheduled, what bills
 * are assigned, what is left over in theory. None of it can tell you whether the
 * account survives the next eleven days, because none of it has ever seen the
 * balance. So the balance is typed in, the way the lumpy fund's is, and this
 * puts the plan's next demand beside it: the bills due before the next paycheck
 * lands, and what would be left after them.
 *
 * A hand-kept number goes stale, and a stale balance is worse than none: it says
 * you are fine on the strength of a week-old fact. So the spending recorded
 * since it was typed comes back with it, and the tile that reads this says so.
 */

export type CashPosition = {
  balance_cents: Cents;
  /** The day the balance was last really changed. */
  as_of: ISODate;
  days_stale: number;
  /** Every bucket, not just discretionary: all of it leaves the same account. */
  spent_since_cents: Cents;
  spent_since_count: number;
  next_paycheck_date: ISODate | null;
  next_paycheck_cents: Cents;
  /** Bills due between today and that paycheck. What the balance has to survive. */
  due_before_next_paycheck_cents: Cents;
  due: { name: string; amount_cents: Cents; due_date: ISODate }[];
  /** Balance less those bills. What is really free until payday. */
  projected_cents: Cents;
  /** The account does not cover what is due before the next paycheck. */
  short: boolean;
};

export type CashInputs = {
  /** This month's paychecks and next month's, so the gap across a month end is covered. */
  paychecks: PaycheckPlan[];
  today: ISODate;
  balanceCents: Cents;
  /** When the balance was typed in. Today, for a balance set today. */
  asOf: ISODate;
  spentSinceCents?: Cents;
  spentSinceCount?: number;
};

export function cashPosition(input: CashInputs): CashPosition {
  const today = d.assertDate(input.today);

  // A prior-month paycheck in an allocation is one that already landed; it is
  // never the *next* one, and counting it would put payday in the past.
  const upcoming = input.paychecks
    .filter((p) => d.compare(p.date, today) > 0)
    .sort((a, b) => d.compare(a.date, b.date));
  const next = upcoming[0] ?? null;

  // One bill can be held on two paychecks across two months' allocations; it is
  // still one bill and must be counted once.
  const seen = new Set<string>();
  const due: Hold[] = [];
  for (const p of input.paychecks) {
    for (const h of p.holds) {
      const key = `${h.fixed_cost_id}|${h.due_date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (d.compare(h.due_date, today) < 0) continue;
      // Anything after the next paycheck is that paycheck's problem, not this
      // balance's. With no paycheck in sight every remaining bill is.
      if (next && d.compare(h.due_date, next.date) >= 0) continue;
      due.push(h);
    }
  }
  due.sort((a, b) => d.compare(a.due_date, b.due_date) || a.name.localeCompare(b.name));

  const dueTotal = sum(due.map((h) => h.amount_cents));
  return {
    balance_cents: input.balanceCents,
    as_of: input.asOf,
    days_stale: Math.max(0, d.diffDays(input.asOf, today)),
    spent_since_cents: input.spentSinceCents ?? 0,
    spent_since_count: input.spentSinceCount ?? 0,
    next_paycheck_date: next?.date ?? null,
    next_paycheck_cents: next?.amount_cents ?? 0,
    due_before_next_paycheck_cents: dueTotal,
    due: due.map((h) => ({ name: h.name, amount_cents: h.amount_cents, due_date: h.due_date })),
    projected_cents: input.balanceCents - dueTotal,
    short: input.balanceCents - dueTotal < 0,
  };
}
