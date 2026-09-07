import { expect, test } from "bun:test";
import { category, expense, fixedCost, goal, lumpy, stream } from "../fixtures/factories";
import { monthSummary, type BudgetInputs } from "../src/summary";

// Joe's actual shape: semi-monthly day job, monthly rental income.
const dayJob = stream({ name: "Day job", frequency: "semimonthly", anchor_date: null, day_1: 15, day_2: 0, amount_cents: 300000 });
const rental = stream({ name: "Rental", frequency: "monthly", anchor_date: null, day_of_month: 5, amount_cents: 180000 });
const groceries = category({ name: "Groceries", bucket: "discretionary" });
const rentCat = category({ name: "Housing", bucket: "fixed" });

const inputs = (over: Partial<BudgetInputs> = {}): BudgetInputs => ({
  streams: [dayJob, rental],
  fixedCosts: [
    fixedCost({ name: "Rent", amount_cents: 150000, due_day: 1, lead_days: 3, category_id: rentCat.id }),
    fixedCost({ name: "Car loan", amount_cents: 42000, due_day: 16, lead_days: 0 }),
    fixedCost({ name: "Internet", amount_cents: 8000, due_day: 20, lead_days: 3 }),
  ],
  lumpyItems: [lumpy({ name: "Car insurance", amount_cents: 120000, frequency_months: 12, next_due_date: "2027-03-01" })],
  savingsGoals: [
    goal({ name: "Emergency", mode: "fixed", amount_cents: 50000 }),
    goal({ name: "Vacation", mode: "percent", amount_cents: null, percent: 5 }),
  ],
  expenses: [
    expense({ txn_date: "2026-03-10", amount_cents: 25000, category_id: groceries.id }),
    expense({ txn_date: "2026-03-20", amount_cents: 10000, category_id: groceries.id }),
    expense({ txn_date: "2026-03-01", amount_cents: 150000, category_id: rentCat.id, merchant: "Landlord" }),
  ],
  categories: [groceries, rentCat],
  month: "2026-03",
  ...over,
});

test("the month ties out by hand", () => {
  const s = monthSummary(inputs());
  expect(s.income_cents).toBe(780000); // 300000 x2 + 180000
  expect(s.income_normalized_cents).toBe(780000);
  expect(s.extra_paycheck).toBe(false);
  expect(s.fixed_cents).toBe(200000);
  expect(s.lumpy_cents).toBe(10000); // 120000 / 12, exactly a cycle out
  expect(s.savings_cents).toBe(50000 + 39000); // fixed + 5% of 780000
  expect(s.planned_free_cents).toBe(780000 - 200000 - 10000 - 89000);
  expect(s.planned_free_cents).toBe(481000);
});

test("paying the rent does not get subtracted twice", () => {
  const s = monthSummary(inputs());
  expect(s.spent.total).toBe(185000);
  expect(s.spent.discretionary).toBe(35000);
  expect(s.spent.fixed).toBe(150000);
  // Only the 35000 of real discretionary spending moves the number.
  expect(s.available_cents).toBe(481000 - 35000);
  expect(s.available_cents).toBe(446000);
});

test("an uncategorized expense still reduces what is available", () => {
  const s = monthSummary(
    inputs({
      expenses: [expense({ txn_date: "2026-03-11", amount_cents: 9900, category_id: null })],
    }),
  );
  expect(s.available_cents).toBe(481000 - 9900);
});

test("expenses outside the month are ignored", () => {
  const s = monthSummary(
    inputs({ expenses: [expense({ txn_date: "2026-04-01", amount_cents: 99999, category_id: groceries.id })] }),
  );
  expect(s.spent.total).toBe(0);
  expect(s.available_cents).toBe(481000);
});

test("every paycheck knows what it is holding and what is left", () => {
  const s = monthSummary(inputs());
  const inMonth = s.paychecks.filter((p) => !p.prior_month);
  expect(inMonth.map((p) => p.date)).toEqual(["2026-03-05", "2026-03-15", "2026-03-31"]);

  // Rent is due the 1st with 3 days lead, so February's paycheck carries it.
  const carrier = s.paychecks.find((p) => p.prior_month)!;
  expect(carrier.date).toBe("2026-02-15");
  expect(carrier.holds.map((h) => h.name)).toEqual(["Rent"]);

  const mar15 = inMonth.find((p) => p.date === "2026-03-15")!;
  expect(mar15.holds.map((h) => h.name)).toEqual(["Car loan", "Internet"]);
  expect(mar15.hold_total_cents).toBe(50000);
  expect(mar15.lumpy_cents).toBe(3846);
  expect(mar15.savings_cents).toBe(34231);
  expect(mar15.free_cents).toBe(300000 - 50000 - 3846 - 34231);

  // The splits are exact, not approximately exact.
  expect(inMonth.reduce((a, p) => a + p.lumpy_cents, 0)).toBe(10000);
  expect(inMonth.reduce((a, p) => a + p.savings_cents, 0)).toBe(89000);
});

test("a period runs from one paycheck to the day before the next", () => {
  const s = monthSummary(inputs());
  expect(s.periods.map((p) => [p.start, p.end])).toEqual([
    ["2026-03-05", "2026-03-14"],
    ["2026-03-15", "2026-03-30"],
    ["2026-03-31", "2026-04-04"], // runs into April, up to the next rental payment
  ]);

  const [p1, p2, p3] = s.periods;
  expect(p1!.spent_discretionary_cents).toBe(25000); // groceries on the 10th
  expect(p2!.spent_discretionary_cents).toBe(10000); // groceries on the 20th
  expect(p3!.spent_discretionary_cents).toBe(0);
  expect(p1!.available_cents).toBe(p1!.planned_free_cents - 25000);
  // Period free cash sums to the month's free cash minus what a prior paycheck carries.
  expect(s.periods.reduce((a, p) => a + p.planned_free_cents, 0)).toBe(780000 - 50000 - 10000 - 89000);
});

test("a 3-paycheck month shows up as surplus over the normalized average", () => {
  const biweekly = stream({ name: "Job", frequency: "biweekly", anchor_date: "2026-01-02", amount_cents: 200000 });
  const s = monthSummary(inputs({ streams: [biweekly], month: "2026-01", expenses: [], savingsGoals: [] }));
  expect(s.income_cents).toBe(600000);
  expect(s.income_normalized_cents).toBe(433333);
  expect(s.surplus_cents).toBe(166667);
  expect(s.extra_paycheck).toBe(true);
  expect(s.periods).toHaveLength(3);
});

test("catch-up mode raises the lumpy contribution when a bill is close", () => {
  const soon = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2026-06-01" });
  const recommended = monthSummary(inputs({ lumpyItems: [soon] }));
  const steady = monthSummary(inputs({ lumpyItems: [soon], lumpyMode: "steady" }));
  expect(recommended.lumpy_cents).toBe(40000); // 120000 over the 3 months left
  expect(steady.lumpy_cents).toBe(10000);
  expect(recommended.lumpy_steady_cents).toBe(10000);
  expect(recommended.available_cents).toBe(steady.available_cents - 30000);
});

test("bills nobody can pay are reported, not swallowed", () => {
  const s = monthSummary(inputs({ streams: [] }));
  expect(s.income_cents).toBe(0);
  expect(s.unfunded.map((u) => u.name)).toEqual(["Rent", "Car loan", "Internet"]);
  expect(s.periods).toEqual([]);
  // No income: 200000 of bills, 10000 lumpy, 50000 fixed savings (the 5% goal is 5% of nothing),
  // then 35000 already spent.
  expect(s.available_cents).toBe(-295000);
});
