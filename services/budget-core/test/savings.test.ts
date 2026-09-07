import { expect, test } from "bun:test";
import { goal } from "../fixtures/factories";
import { monthlySavings, savingsMonthlyTotal } from "../src/savings";

test("a fixed goal is the same every month", () => {
  expect(savingsMonthlyTotal([goal({ mode: "fixed", amount_cents: 50000 })], 999999)).toBe(50000);
});

test("a percent goal follows the month's actual income", () => {
  const g = goal({ mode: "percent", amount_cents: null, percent: 10 });
  expect(savingsMonthlyTotal([g], 600000)).toBe(60000);
  expect(savingsMonthlyTotal([g], 400000)).toBe(40000);
  expect(savingsMonthlyTotal([goal({ mode: "percent", amount_cents: null, percent: 7.5 })], 433333)).toBe(32500);
});

test("goals combine, and inactive ones do not", () => {
  const goals = [
    goal({ name: "Emergency", mode: "fixed", amount_cents: 25000 }),
    goal({ name: "Vacation", mode: "percent", amount_cents: null, percent: 5 }),
    goal({ name: "Old", mode: "fixed", amount_cents: 99999, active: false }),
  ];
  expect(savingsMonthlyTotal(goals, 600000)).toBe(25000 + 30000);
  expect(monthlySavings(goals, 600000).map((g) => g.goal.name)).toEqual(["Emergency", "Vacation"]);
});
