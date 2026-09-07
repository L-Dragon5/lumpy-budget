import type { FixedCost, IncomeStream } from "@lumpy/contracts";
import { allocate, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISODate, ISOMonth } from "./dates";
import { allOccurrences, occurrencesInMonth } from "./schedule";

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
  const thisMonth = occurrencesInMonth(streams.filter((s) => s.active), month);

  const plans = new Map<string, PaycheckPlan>();
  const key = (date: ISODate, streamId: number) => `${date}#${streamId}`;
  const ensure = (o: (typeof candidates)[number]): PaycheckPlan => {
    const k = key(o.date, o.stream_id);
    let p = plans.get(k);
    if (!p) {
      p = {
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
      };
      plans.set(k, p);
    }
    return p;
  };
  // Every paycheck landing inside the month always shows up, even with no holds.
  for (const o of thisMonth) ensure(o);

  const unfunded: Hold[] = [];
  for (const c of fixedCosts.filter((f) => f.active)) {
    const dueDate = d.clampDay(y, m, c.due_day);
    const target = d.addDays(dueDate, -c.lead_days);
    // The last paycheck that lands on or before the money is needed.
    const covering = [...candidates].reverse().find((o) => d.compare(o.date, target) <= 0);
    const fallback = covering ?? candidates[0];
    const hold: Hold = {
      fixed_cost_id: c.id,
      name: c.name,
      amount_cents: c.amount_cents,
      due_date: dueDate,
      late: !covering,
    };
    if (!fallback) {
      unfunded.push(hold);
      continue;
    }
    const p = ensure(fallback);
    p.holds.push(hold);
    p.hold_total_cents += c.amount_cents;
  }

  // Lumpy and savings come out of this month's paychecks, split in proportion
  // to paycheck size so a small check is not asked to carry a big transfer.
  const inMonth = [...plans.values()]
    .filter((p) => !p.prior_month)
    .sort((a, b) => d.compare(a.date, b.date) || a.stream_id - b.stream_id);
  const weights = inMonth.map((p) => p.amount_cents);
  const lumpySplit = allocate(lumpyMonthlyCents, weights);
  const savingsSplit = allocate(savingsMonthlyCents, weights);
  inMonth.forEach((p, i) => {
    p.lumpy_cents = lumpySplit[i] ?? 0;
    p.savings_cents = savingsSplit[i] ?? 0;
  });

  const paychecks = [...plans.values()].sort(
    (a, b) => d.compare(a.date, b.date) || a.stream_id - b.stream_id,
  );
  for (const p of paychecks) {
    p.holds.sort((a, b) => d.compare(a.due_date, b.due_date));
    p.free_cents = p.amount_cents - p.hold_total_cents - p.lumpy_cents - p.savings_cents;
    p.over_committed = p.free_cents < 0;
  }

  return {
    month,
    paychecks,
    fixed_total_cents: sum(fixedCosts.filter((f) => f.active).map((f) => f.amount_cents)),
    income_cents: sum(inMonth.map((p) => p.amount_cents)),
    free_total_cents: sum(inMonth.map((p) => p.free_cents)),
    unfunded,
  };
}
