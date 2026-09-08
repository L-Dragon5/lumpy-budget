import { expect, test } from "bun:test";
import { expense, lumpy } from "../fixtures/factories";
import {
  dueDates, lumpyPayments, nextDueOnOrAfter, plan, recommendedMonthlyTotal, steadyMonthlyTotal, timeline,
} from "../src/lumpy";

test("catch-up is bigger than steady state when the bill arrives before a full cycle", () => {
  const item = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2026-04-15" });
  const [p] = plan([item], "2026-01");
  expect(p!.steady_cents).toBe(10000);
  expect(p!.months_until_due).toBe(3);
  expect(p!.catch_up_cents).toBe(40000);
  expect(p!.recommended_cents).toBe(40000);
  expect(p!.behind).toBe(true);
});

test("a full cycle out, catch-up and steady state agree", () => {
  const item = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2027-01-15" });
  const [p] = plan([item], "2026-01");
  expect(p!.months_until_due).toBe(12);
  expect(p!.catch_up_cents).toBe(10000);
  expect(p!.behind).toBe(false);
});

test("a bill due this month needs the whole amount now", () => {
  const item = lumpy({ amount_cents: 30000, frequency_months: 6, next_due_date: "2026-01-20" });
  const [p] = plan([item], "2026-01");
  expect(p!.months_until_due).toBe(0);
  expect(p!.catch_up_cents).toBe(30000);
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
  expect(recommendedMonthlyTotal(items, "2026-01")).toBe(10000 + 15000); // water is 2 months out
});

test("the timeline funds an underfunded item when it catches up, and misses when it does not", () => {
  const item = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2026-04-15" });

  const caught = timeline([item], "2026-01", 12, 0, "recommended");
  expect(caught.monthly_contribution_cents).toBe(40000);
  expect(caught.rows[0]!.balance_start_cents).toBe(0);
  const apr = caught.rows.find((r) => r.month === "2026-04")!;
  expect(apr.balance_start_cents).toBe(120000);
  expect(apr.outflow_cents).toBe(120000);
  expect(apr.balance_end_cents).toBe(40000);
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

test("money already in the fund is claimed by whatever comes due first", () => {
  const soon = lumpy({ id: 1, name: "HOA", amount_cents: 45000, frequency_months: 3, next_due_date: "2026-04-01" });
  const later = lumpy({ id: 2, name: "Insurance", amount_cents: 120000, frequency_months: 12, next_due_date: "2026-07-01" });

  const empty = plan([soon, later], "2026-03", 0);
  expect(empty[0]!.catch_up_cents).toBe(45000); // all of it, this month
  expect(empty[1]!.catch_up_cents).toBe(30000); // 120000 over 4 months

  const funded = plan([soon, later], "2026-03", 45000);
  expect(funded[0]!.already_covered_cents).toBe(45000);
  expect(funded[0]!.catch_up_cents).toBe(0);
  expect(funded[0]!.recommended_cents).toBe(15000); // falls back to steady state
  expect(funded[1]!.already_covered_cents).toBe(0);

  const overFunded = plan([soon, later], "2026-03", 200000);
  expect(overFunded[1]!.already_covered_cents).toBe(120000);
  expect(overFunded[1]!.catch_up_cents).toBe(0);
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
