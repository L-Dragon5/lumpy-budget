import { expect, test } from "bun:test";
import { category, expense, stream } from "../fixtures/factories";
import {
  depositedInMonth, incomeCalendar, incomeReconciliation, monthlyActual, monthlyNormalized, nextPaycheck,
} from "../src/income";

const biweekly = () => stream({ name: "Job", amount_cents: 200000, frequency: "biweekly", anchor_date: "2026-01-02" });

test("actual income differs from the normalized average in a 3-paycheck month", () => {
  const s = biweekly();
  expect(monthlyActual([s], "2026-01")).toBe(600000);
  expect(monthlyActual([s], "2026-02")).toBe(400000);
  expect(monthlyNormalized([s])).toBe(433333); // 200000 * 26 / 12
});

test("normalized income adds up across mixed frequencies", () => {
  const semi = stream({ frequency: "semimonthly", anchor_date: null, day_1: 15, day_2: 0, amount_cents: 300000 });
  const monthly = stream({ frequency: "monthly", anchor_date: null, day_of_month: 1, amount_cents: 180000 });
  expect(monthlyNormalized([semi, monthly])).toBe(600000 + 180000);
  expect(monthlyActual([semi, monthly], "2026-02")).toBe(780000);
});

test("the calendar flags exactly the extra-paycheck months and their surplus", () => {
  const cal = incomeCalendar([biweekly()], 2026);
  expect(cal).toHaveLength(12);
  expect(cal.filter((m) => m.extra_paycheck).map((m) => m.month)).toEqual(["2026-01", "2026-07"]);
  const jan = cal.find((m) => m.month === "2026-01")!;
  expect(jan.total_cents).toBe(600000);
  expect(jan.surplus_cents).toBe(600000 - 433333);
  const feb = cal.find((m) => m.month === "2026-02")!;
  expect(feb.surplus_cents).toBe(400000 - 433333);
  // A full year of actuals equals a full year of the average, to within rounding.
  const actual = cal.reduce((a, m) => a + m.total_cents, 0);
  expect(Math.abs(actual - 433333 * 12)).toBeLessThan(500);
});

test("nextPaycheck looks forward, not back", () => {
  const s = biweekly();
  expect(nextPaycheck([s], "2026-01-03")!.date).toBe("2026-01-16");
  expect(nextPaycheck([s], "2026-01-16")!.date).toBe("2026-01-16");
  expect(nextPaycheck([], "2026-01-03")).toBeNull();
});

test("a one-off lands in its month but never lifts the monthly average", () => {
  const job = biweekly();
  const gift = stream({ name: "Gift", frequency: "one_time", anchor_date: "2026-02-10", amount_cents: 50000 });
  expect(monthlyNormalized([job, gift])).toBe(monthlyNormalized([job]));
  expect(monthlyActual([job, gift], "2026-02")).toBe(400000 + 50000);
  expect(monthlyActual([job, gift], "2026-03")).toBe(monthlyActual([job], "2026-03"));

  // The whole gift shows up as surplus in February, and nowhere else.
  const cal = incomeCalendar([job, gift], 2026);
  const feb = cal.find((m) => m.month === "2026-02")!;
  expect(feb.surplus_cents).toBe(400000 + 50000 - 433333);
  expect(feb.extra_paycheck).toBe(false);
});

// ------------------------------------------------- the plan against the bank

const incomeCat = category({ name: "Income", bucket: "income" });
const groceriesCat = category({ name: "Groceries", bucket: "discretionary" });
const paidCats = [incomeCat, groceriesCat];
// $1,200 on the 15th and the last day = $2,400 planned.
const semimonthly = () =>
  stream({ name: "Job", amount_cents: 120000, frequency: "semimonthly", day_1: 15, day_2: 0, anchor_date: null });

test("a deposit is stored as a credit and reported as a positive", () => {
  const rows = [expense({ txn_date: "2026-03-15", amount_cents: -120000, category_id: incomeCat.id })];
  expect(depositedInMonth(rows, paidCats, "2026-03")).toEqual({ cents: 120000, count: 1 });
});

test("reconciliation names the gap when a paycheck did not land", () => {
  const rows = [
    expense({ txn_date: "2026-03-15", amount_cents: -120000, category_id: incomeCat.id }),
    expense({ txn_date: "2026-03-04", amount_cents: 8100, category_id: groceriesCat.id }),
  ];
  const [march] = incomeReconciliation([semimonthly()], rows, paidCats, ["2026-03"]);
  expect(march).toMatchObject({
    month: "2026-03", planned_cents: 240000, deposited_cents: 120000,
    delta_cents: -120000, count: 1, imported: true,
  });
});

test("a month nobody imported is not a month you were not paid", () => {
  // The same rule fixedCostVariance and categoryPace follow. A red -$2,400 on a
  // month with no statement in it is a missing import wearing the face of a
  // missing paycheck, and the two need opposite responses.
  const [april] = incomeReconciliation([semimonthly()], [], paidCats, ["2026-04"]);
  expect(april).toMatchObject({ deposited_cents: 0, delta_cents: 0, imported: false });
});

test("a bonus nobody planned reads as surplus rather than as an error", () => {
  const rows = [
    expense({ txn_date: "2026-03-15", amount_cents: -120000, category_id: incomeCat.id }),
    expense({ txn_date: "2026-03-31", amount_cents: -120000, category_id: incomeCat.id }),
    expense({ txn_date: "2026-03-20", amount_cents: -50000, category_id: incomeCat.id }),
  ];
  const [march] = incomeReconciliation([semimonthly()], rows, paidCats, ["2026-03"]);
  expect(march!.delta_cents).toBe(50000);
  expect(march!.count).toBe(3);
});

test("a deposit outside the month is not that month's income", () => {
  const rows = [expense({ txn_date: "2026-02-28", amount_cents: -120000, category_id: incomeCat.id })];
  expect(depositedInMonth(rows, paidCats, "2026-03")).toEqual({ cents: 0, count: 0 });
});

test("a short month says when the missing paycheck is sitting uncategorized", () => {
  // The second March cheque came in under a descriptor no rule knew. The month
  // is still short -- deposited counts only the income bucket -- but it says
  // why, so the answer is "categorize it", not "call payroll".
  const rows = [
    expense({ txn_date: "2026-03-15", amount_cents: -120000, category_id: incomeCat.id }),
    expense({ txn_date: "2026-03-31", amount_cents: -120000, category_id: null, merchant: "ACME CORP PPD" }),
    // An uncategorized charge is not a credit, and a categorized refund is placed.
    expense({ txn_date: "2026-03-04", amount_cents: 8100, category_id: null }),
    expense({ txn_date: "2026-03-09", amount_cents: -1500, category_id: groceriesCat.id }),
  ];
  const [march] = incomeReconciliation([semimonthly()], rows, paidCats, ["2026-03"]);
  expect(march).toMatchObject({
    deposited_cents: 120000, delta_cents: -120000,
    uncategorized_credit_cents: 120000, uncategorized_credit_count: 1,
  });
});

test("a month with no uncategorized credits reports zero, not minus zero", () => {
  const rows = [
    expense({ txn_date: "2026-03-15", amount_cents: -120000, category_id: incomeCat.id }),
    expense({ txn_date: "2026-03-04", amount_cents: 8100, category_id: null }),
  ];
  const [march, april] = incomeReconciliation([semimonthly()], rows, paidCats, ["2026-03", "2026-04"]);
  // toBe is Object.is, so -0 fails here where toEqual on a JSON body would not.
  expect(march!.uncategorized_credit_cents).toBe(0);
  expect(march!.uncategorized_credit_count).toBe(0);
  // And a month nobody imported has none to report either.
  expect(april!.uncategorized_credit_cents).toBe(0);
  expect(april!.uncategorized_credit_count).toBe(0);
});
