import { expect, test } from "bun:test";
import type { LumpyItem } from "@lumpy/contracts";
import { addMonths, monthEnd, monthsBetween, monthStart } from "../src/dates";
import { sum } from "../src/money";
import { expense, lumpy } from "../fixtures/factories";
import {
  dueDates, fundPlan, lumpyPayments, nextDueOnOrAfter, plan, recommendedMonthlyTotal,
  steadyMonthlyTotal, timeline,
} from "../src/lumpy";

test("catch-up is bigger than steady state when the bill arrives before a full cycle", () => {
  const item = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2026-04-15" });
  const [p] = plan([item], "2026-01");
  expect(p!.steady_cents).toBe(10000);
  expect(p!.months_until_due).toBe(3);

  // January, February, March, April: four contributions before the bill is paid.
  const f = fundPlan([item], "2026-01");
  expect(f.required_cents).toBe(30000);
  expect(f.catch_up_cents).toBe(20000);
  expect(f.short_by_cents).toBe(120000 - 4 * 10000);
  expect(f.short_month).toBe("2026-04");
  expect(f.through_month).toBe("2026-04");
});

test("a full cycle out, catch-up and steady state agree", () => {
  const item = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2027-01-15" });
  const [p] = plan([item], "2026-01");
  expect(p!.months_until_due).toBe(12);
  const f = fundPlan([item], "2026-01");
  expect(f.required_cents).toBe(10000);
  expect(f.catch_up_cents).toBe(0);
  expect(f.short_by_cents).toBe(0);
  expect(f.short_month).toBeNull();
});

test("a bill due this month needs the whole amount now", () => {
  const item = lumpy({ amount_cents: 30000, frequency_months: 6, next_due_date: "2026-01-20" });
  const [p] = plan([item], "2026-01");
  expect(p!.months_until_due).toBe(0);
  expect(fundPlan([item], "2026-01").required_cents).toBe(30000);
  // Except for whatever is already sitting there.
  expect(fundPlan([item], "2026-01", 18000).required_cents).toBe(12000);
});

test("past-due dates roll forward to the next real occurrence", () => {
  const item = lumpy({ frequency_months: 3, next_due_date: "2024-02-29" });
  expect(nextDueOnOrAfter(item, "2026-01-01")).toBe("2026-02-28");
  expect(dueDates(item, "2026-01-01", "2026-12-31")).toEqual([
    "2026-02-28", "2026-05-28", "2026-08-28", "2026-11-28",
  ]);
});

test("quarterly and annual totals add up", () => {
  const items = [
    lumpy({ name: "Insurance", amount_cents: 120000, frequency_months: 12, next_due_date: "2027-01-01" }),
    lumpy({ name: "Water", amount_cents: 30000, frequency_months: 3, next_due_date: "2026-03-01" }),
  ];
  expect(steadyMonthlyTotal(items, "2026-01")).toBe(10000 + 10000);
  // The flat amount is already enough: the water bill is 30000 with three
  // contributions behind it, and the insurance has all twelve. Asked item by
  // item and added up, this used to come out 5000 a month higher.
  expect(recommendedMonthlyTotal(items, "2026-01")).toBe(20000);
});

test("the timeline funds an underfunded item when it catches up, and misses when it does not", () => {
  const item = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2026-04-15" });

  // Four contributions land before it is paid -- January through April -- so the
  // bill is 30000 a month, not 120000 over the three months until it.
  const caught = timeline([item], "2026-01", 12, 0, "recommended");
  expect(caught.monthly_contribution_cents).toBe(30000);
  expect(caught.rows[0]!.balance_start_cents).toBe(0);
  const apr = caught.rows.find((r) => r.month === "2026-04")!;
  expect(apr.balance_start_cents).toBe(90000);
  expect(apr.outflow_cents).toBe(120000);
  expect(apr.balance_end_cents).toBe(0);
  expect(apr.short).toBe(false);
  expect(apr.due).toEqual([{ id: item.id, name: item.name, amount_cents: 120000, date: "2026-04-15" }]);
  expect(caught.first_short_month).toBeNull();
  expect(caught.total_outflow_cents).toBe(120000);

  const behind = timeline([item], "2026-01", 12, 0, "steady");
  expect(behind.monthly_contribution_cents).toBe(10000);
  const aprShort = behind.rows.find((r) => r.month === "2026-04")!;
  expect(aprShort.short).toBe(true);
  expect(aprShort.shortfall_cents).toBe(120000 - 40000);
  expect(behind.first_short_month).toBe("2026-04");
  expect(behind.worst_balance_cents).toBeLessThan(0);
});

test("an opening balance closes the gap", () => {
  const item = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2026-04-15" });
  const t = timeline([item], "2026-01", 12, 90000, "steady");
  expect(t.first_short_month).toBeNull();
  expect(t.rows.find((r) => r.month === "2026-04")!.balance_end_cents).toBe(10000);
});

test("the timeline is exactly the months asked for and carries the balance forward", () => {
  const monthlyItem = lumpy({ amount_cents: 1000, frequency_months: 1, next_due_date: "2026-01-10" });
  const t = timeline([monthlyItem], "2026-06", 12, 0, "steady");
  expect(t.rows).toHaveLength(12);
  expect(t.rows[0]!.month).toBe("2026-06");
  expect(t.rows[11]!.month).toBe("2027-05");
  // Contributes 1000 and pays 1000 every month: it never accumulates.
  for (const r of t.rows) expect(r.balance_end_cents).toBe(0);
});

test("inactive items are invisible", () => {
  const t = timeline([lumpy({ active: false })], "2026-01", 12, 0);
  expect(t.monthly_contribution_cents).toBe(0);
  expect(t.total_outflow_cents).toBe(0);
});

test("the balance counts once, against the fund, not against one bill", () => {
  const soon = lumpy({ id: 1, name: "HOA", amount_cents: 45000, frequency_months: 3, next_due_date: "2026-04-01" });
  const later = lumpy({ id: 2, name: "Insurance", amount_cents: 120000, frequency_months: 12, next_due_date: "2026-07-01" });
  const steady = 15000 + 10000;

  // Empty: 45000 by April is two contributions of 22500. July is the quarterly
  // HOA again plus the insurance -- 210000 paid out by then, over five
  // contributions, so July sets the number.
  expect(fundPlan([soon, later], "2026-03").required_cents).toBe(42000);

  // 45000 in the account pays the April bill outright, and it is the same 45000
  // that is still there in July: (210000 - 45000) / 5 = 33000. Asked per item,
  // the balance could only be spent once and July was told to start from zero.
  expect(fundPlan([soon, later], "2026-03", 45000).required_cents).toBe(33000);

  // Enough to cover everything in the window falls back to the flat amount, and
  // nothing above the flat amount is ever asked for.
  const rich = fundPlan([soon, later], "2026-03", 200000);
  expect(rich.required_cents).toBe(steady);
  expect(rich.catch_up_cents).toBe(0);
  expect(rich.short_by_cents).toBe(0);
});

test("the required contribution is the smallest one that never runs the fund dry", () => {
  // 1000 random funds: the number is enough, and one cent less is not.
  let short = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const rand = mulberry(seed);
    const items = Array.from({ length: 1 + Math.floor(rand() * 5) }, (_, n) =>
      lumpy({
        id: n + 1,
        amount_cents: 1000 + Math.floor(rand() * 200000),
        frequency_months: [1, 3, 6, 12, 24][Math.floor(rand() * 5)]!,
        next_due_date: `2026-${String(1 + Math.floor(rand() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`,
      }));
    const balance = Math.floor(rand() * 300000);
    const f = fundPlan(items, "2026-01", balance);

    const months = monthsBetween("2026-01", f.through_month) + 1;
    // The balance on the last day of each month: everything contributed on the
    // 1sts so far, less everything paid out so far.
    const walk = (c: number) =>
      Math.min(...Array.from({ length: months }, (_, k) => balance + c * (k + 1) - outflowThrough(items, "2026-01", k)));
    expect(walk(f.required_cents)).toBeGreaterThanOrEqual(0);
    if (f.required_cents > f.steady_cents) {
      short++;
      expect(walk(f.required_cents - 1)).toBeLessThan(0);
    }
  }
  // The generator has to actually produce underfunded funds, or this proves nothing.
  expect(short).toBeGreaterThan(100);
});

test("the fund lands on zero at the month that set the number", () => {
  const items = [
    lumpy({ id: 1, amount_cents: 132500, frequency_months: 6, next_due_date: "2027-01-07" }),
    lumpy({ id: 2, amount_cents: 65000, frequency_months: 12, next_due_date: "2027-02-01" }),
    lumpy({ id: 3, amount_cents: 40000, frequency_months: 12, next_due_date: "2027-01-01" }),
  ];
  const t = timeline(items, "2026-09", 12, 0, "recommended");
  expect(t.worst_balance_cents).toBeGreaterThanOrEqual(0);
  expect(t.worst_balance_cents).toBeLessThan(t.monthly_contribution_cents);
  expect(t.first_short_month).toBeNull();
});

test("inactive items are not part of the number", () => {
  const on = lumpy({ id: 1, amount_cents: 120000, frequency_months: 12, next_due_date: "2026-04-15" });
  const off = lumpy({ id: 2, amount_cents: 999900, frequency_months: 12, next_due_date: "2026-02-01", active: false });
  expect(fundPlan([on, off], "2026-01")).toEqual(fundPlan([on], "2026-01"));
  expect(fundPlan([off], "2026-01").required_cents).toBe(0);
});

// ------------------------------------------------- payments already imported

test("a charge near the due date is the payment, and rolls the item forward", () => {
  const item = lumpy({
    name: "Car insurance", amount_cents: 120000, frequency_months: 12,
    next_due_date: "2026-04-15", merchant_pattern: "geico",
  });
  const paid = expense({ txn_date: "2026-04-17", amount_cents: 123400, merchant: "GEICO *AUTO 8829" });
  const [p] = lumpyPayments([item], [paid], { today: "2026-04-30" });
  expect(p!.due_date).toBe("2026-04-15");
  expect(p!.rolls_to).toBe("2027-04-15");
  expect(p!.expense.id).toBe(paid.id);
  expect(p!.days_off).toBe(2);
  // The bill going up is the second thing this finds.
  expect(p!.delta_cents).toBe(3400);
});

test("an item with no pattern is never reconciled, however obvious the charge", () => {
  const item = lumpy({ next_due_date: "2026-04-15", merchant_pattern: null });
  const paid = expense({ txn_date: "2026-04-15", amount_cents: 120000, merchant: "Car insurance" });
  expect(lumpyPayments([item], [paid], { today: "2026-04-30" })).toEqual([]);
  // Nor is an inactive one: it is not being saved for, so nothing left the fund.
  const off = lumpy({ next_due_date: "2026-04-15", merchant_pattern: "geico", active: false });
  expect(lumpyPayments([off], [expense({ txn_date: "2026-04-15", merchant: "GEICO" })], { today: "2026-04-30" })).toEqual([]);
});

test("money that has not left yet, and money coming back, are not payments", () => {
  const item = lumpy({ next_due_date: "2026-04-15", merchant_pattern: "geico", amount_cents: 120000 });
  // A statement can carry a transaction dated ahead of itself.
  const ahead = expense({ txn_date: "2026-04-15", amount_cents: 120000, merchant: "GEICO" });
  expect(lumpyPayments([item], [ahead], { today: "2026-04-10" })).toEqual([]);
  // A refund matches the pattern and is the opposite of a payment.
  const refund = expense({ txn_date: "2026-04-15", amount_cents: -4000, merchant: "GEICO REFUND" });
  expect(lumpyPayments([item], [refund], { today: "2026-04-30" })).toEqual([]);
});

test("the window is half a cycle, so a monthly item is not paid by next month", () => {
  const monthly = lumpy({ frequency_months: 1, next_due_date: "2026-04-15", merchant_pattern: "acme" });
  const near = expense({ txn_date: "2026-04-25", merchant: "ACME" });
  const far = expense({ txn_date: "2026-05-14", merchant: "ACME" });
  expect(lumpyPayments([monthly], [far], { today: "2026-05-30" })).toEqual([]);
  expect(lumpyPayments([monthly], [near], { today: "2026-05-30" })).toHaveLength(1);
});

test("the charge closest to the due date wins, whatever order the rows arrive in", () => {
  const item = lumpy({ next_due_date: "2026-04-15", merchant_pattern: "geico", frequency_months: 12 });
  const early = expense({ txn_date: "2026-03-28", merchant: "GEICO ONE" });
  const close = expense({ txn_date: "2026-04-14", merchant: "GEICO TWO" });
  expect(lumpyPayments([item], [early, close], { today: "2026-04-30" })[0]!.expense.id).toBe(close.id);
  expect(lumpyPayments([item], [close, early], { today: "2026-04-30" })[0]!.expense.id).toBe(close.id);
});

test("whole_word here means what it means everywhere else", () => {
  const item = lumpy({ next_due_date: "2026-04-15", merchant_pattern: "bp", merchant_whole_word: true });
  const post = expense({ txn_date: "2026-04-15", merchant: "BPOST ANNUAL" });
  const fuel = expense({ txn_date: "2026-04-16", merchant: "BP1234 FUEL CARD" });
  expect(lumpyPayments([item], [post], { today: "2026-04-30" })).toEqual([]);
  expect(lumpyPayments([item], [fuel], { today: "2026-04-30" })).toHaveLength(1);
});

test("the hole is what the flat amount leaves missing, at its deepest", () => {
  // $1,200 due in 3 months: four contributions of $100 saves $400 of it, so $800
  // is missing on the day it is paid.
  const soon = lumpy({ id: 1, amount_cents: 120000, frequency_months: 12, next_due_date: "2026-04-15" });
  // A full cycle out, and paid for by twelve contributions of its own.
  const later = lumpy({ id: 2, amount_cents: 60000, frequency_months: 12, next_due_date: "2027-01-10" });
  const f = fundPlan([soon, later], "2026-01");
  expect(f.steady_cents).toBe(15000);
  expect(f.short_by_cents).toBe(120000 - 4 * 15000);
  expect(f.short_month).toBe("2026-04");
  expect(f.required_cents).toBe(30000);
  expect(f.catch_up_cents).toBe(f.required_cents - f.steady_cents);
});

test("money already in the fund shrinks the hole and closes it", () => {
  const item = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2026-04-15" });
  expect(fundPlan([item], "2026-01", 60000).short_by_cents).toBe(20000);
  const covered = fundPlan([item], "2026-01", 80000);
  expect(covered.short_by_cents).toBe(0);
  expect(covered.short_month).toBeNull();
  expect(covered.required_cents).toBe(covered.steady_cents);
});

test("a fund that is not behind asks for the flat amount and says so", () => {
  const item = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2027-01-15" });
  const f = fundPlan([item], "2026-01");
  expect(f.short_by_cents).toBe(0);
  expect(f.catch_up_cents).toBe(0);
  expect(f.required_cents).toBe(f.steady_cents);
});

/** A seeded PRNG, so the generated funds above are the same set every run. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every occurrence due in the first `k + 1` months, added up. */
function outflowThrough(items: LumpyItem[], start: string, k: number): number {
  const last = addMonths(start, k);
  return sum(items.flatMap((i) => dueDates(i, monthStart(start), monthEnd(last)).map(() => i.amount_cents)));
}
