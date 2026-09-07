import type { FixedCost, IncomeStream } from "@lumpy/contracts";
import { allocate, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISODate, ISOMonth } from "./dates";
import { allOccurrences } from "./schedule";

export type Hold = {
  fixed_cost_id: number;
  name: string;
  amount_cents: Cents;
  due_date: ISODate;
  /** No paycheck lands early enough to cover this bill. */
  late: boolean;
};

export type PaycheckPlan = {
  date: ISODate;
  stream_id: number;
  stream_name: string;
  amount_cents: Cents;
  /** True for a prior-month paycheck that is carrying one of this month's bills. */
  prior_month: boolean;
  holds: Hold[];
  hold_total_cents: Cents;
  lumpy_cents: Cents;
  savings_cents: Cents;
  free_cents: Cents;
  /** The paycheck cannot cover everything assigned to it. */
  over_committed: boolean;
};

export type Allocation = {
  month: ISOMonth;
  paychecks: PaycheckPlan[];
  fixed_total_cents: Cents;
  income_cents: Cents;
  free_total_cents: Cents;
  unfunded: Hold[];
};

/**
 * Safety-first: every bill is parked on a specific paycheck, the last one that
 * lands at least `lead_days` before the due date. That is the whole point --
 * a monthly total can look fine while rent is due three days before you get paid.
 */
/** What a paycheck can still carry: gross, less what is already committed from it. */
const capacity = (p: PaycheckPlan): Cents =>
  p.amount_cents - p.hold_total_cents - p.lumpy_cents - p.savings_cents;

export function allocateMonth(args: {
  streams: IncomeStream[];
  fixedCosts: FixedCost[];
  month: ISOMonth;
  lumpyMonthlyCents?: Cents;
  savingsMonthlyCents?: Cents;
}): Allocation {
  const { streams, fixedCosts, month, lumpyMonthlyCents = 0, savingsMonthlyCents = 0 } = args;
  const [y, m] = d.monthParts(month);

  // Look back a month so a bill due on the 2nd can be covered by the paycheck
  // that actually funds it, which arrived in the previous month.
  const lookback = d.addDays(d.monthStart(month), -31);
  const candidates = allOccurrences(
    streams.filter((s) => s.active),
    lookback,
    d.monthEnd(month),
  );

  // One plan per occurrence, keyed by position rather than by date: two pay
  // events can legitimately land on the same day (semimonthly on the 30th and
  // the last day both clamp to Feb 28), and collapsing them loses real money.
  const plans: PaycheckPlan[] = candidates.map((o) => ({
    date: o.date,
    stream_id: o.stream_id,
    stream_name: o.stream_name,
    amount_cents: o.amount_cents,
    prior_month: d.monthOf(o.date) !== month,
    holds: [],
    hold_total_cents: 0,
    lumpy_cents: 0,
    savings_cents: 0,
    free_cents: 0,
    over_committed: false,
  }));

  // The lumpy and savings transfers are obligations too, so they are carved out
  // before any bill is assigned: a paycheck's capacity is what is left after them,
  // not its gross. Split in proportion to paycheck size.
  const inMonth = plans.filter((p) => !p.prior_month);
  const weights = inMonth.map((p) => p.amount_cents);
  const lumpySplit = allocate(lumpyMonthlyCents, weights);
  const savingsSplit = allocate(savingsMonthlyCents, weights);
  inMonth.forEach((p, i) => {
    p.lumpy_cents = lumpySplit[i] ?? 0;
    p.savings_cents = savingsSplit[i] ?? 0;
  });

  const unfunded: Hold[] = [];
  // Soonest bills first, so the paycheck nearest each due date is claimed by the
  // bill that actually needs it.
  const bills = fixedCosts
    .filter((f) => f.active)
    .map((c) => ({ cost: c, dueDate: d.clampDay(y, m, c.due_day) }))
    .sort((a, b) => d.compare(a.dueDate, b.dueDate) || a.cost.id - b.cost.id);

  for (const { cost: c, dueDate } of bills) {
    const target = d.addDays(dueDate, -c.lead_days);
    // Hold the money as late as is still safe, but only from a paycheck that can
    // actually cover it: otherwise a small rental deposit ends up "holding" the
    // mortgage while a big paycheck two days earlier sits empty.
    let idx = -1;
    let latest = -1;
    for (let i = plans.length - 1; i >= 0; i--) {
      if (d.compare(plans[i]!.date, target) > 0) continue;
      if (latest < 0) latest = i;
      if (capacity(plans[i]!) >= c.amount_cents) { idx = i; break; }
    }
    if (idx < 0) idx = latest;
    const covering = idx >= 0;
    const carrier = covering ? plans[idx]! : plans[0];
    const hold: Hold = {
      fixed_cost_id: c.id,
      name: c.name,
      amount_cents: c.amount_cents,
      due_date: dueDate,
      late: !covering,
    };
    if (!carrier) {
      unfunded.push(hold);
      continue;
    }
    carrier.holds.push(hold);
    carrier.hold_total_cents += c.amount_cents;
  }

  // Lumpy and savings come out of this month's paychecks, split in proportion
  // to paycheck size so a small check is not asked to carry a big transfer.
  for (const p of plans) {
    p.holds.sort((a, b) => d.compare(a.due_date, b.due_date));
    p.free_cents = capacity(p);
    p.over_committed = p.free_cents < 0;
  }
  // A prior-month paycheck only appears when it is carrying one of this month's bills.
  const paychecks = plans.filter((p) => !p.prior_month || p.holds.length > 0);

  return {
    month,
    paychecks,
    fixed_total_cents: sum(fixedCosts.filter((f) => f.active).map((f) => f.amount_cents)),
    income_cents: sum(inMonth.map((p) => p.amount_cents)),
    free_total_cents: sum(inMonth.map((p) => p.free_cents)),
    unfunded,
  };
}
