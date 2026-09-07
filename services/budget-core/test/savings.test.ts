import { expect, test } from "bun:test";
import { goal } from "../fixtures/factories";
import type { SavingsGoal } from "@lumpy/contracts";
import { goalProgress, monthlySavings, savingsBalanceTotal, savingsMonthlyTotal } from "../src/savings";

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

const bucket = (p: Partial<SavingsGoal>): SavingsGoal =>
  goal({ mode: "fixed", amount_cents: 50000, percent: null, target_cents: null, balance_cents: 0, ...p });

test("a goal with a target reports how far along it is and when it lands", () => {
  const g = bucket({ name: "Vacation", amount_cents: 50000, target_cents: 300000, balance_cents: 120000 });
  const [p] = goalProgress([g], 0);
  expect(p!.pct).toBeCloseTo(40, 6);
  expect(p!.remaining_cents).toBe(180000);
  expect(p!.monthly_cents).toBe(50000);
  expect(p!.months_to_target).toBe(4); // 180000 / 50000, rounded up
  expect(p!.funded).toBe(false);
});

test("an overfunded goal reports past 100% rather than capping", () => {
  const [p] = goalProgress([bucket({ target_cents: 100000, balance_cents: 125000 })], 0);
  expect(p!.pct).toBe(125);
  expect(p!.remaining_cents).toBe(0);
  expect(p!.months_to_target).toBe(0);
  expect(p!.funded).toBe(true);
});

test("an open-ended goal has a balance but no finish line", () => {
  const [p] = goalProgress([bucket({ target_cents: null, balance_cents: 90000 })], 0);
  expect(p!.pct).toBeNull();
  expect(p!.remaining_cents).toBe(0);
  expect(p!.months_to_target).toBeNull();
  expect(p!.funded).toBe(false);
});

test("a target with nothing going into it never arrives", () => {
  const g = bucket({ mode: "fixed", amount_cents: 0, target_cents: 100000, balance_cents: 1000 });
  const [p] = goalProgress([g], 500000);
  expect(p!.months_to_target).toBeNull();
  expect(p!.remaining_cents).toBe(99000);
});

test("a percent goal's forecast follows that month's income", () => {
  const g = bucket({ mode: "percent", amount_cents: null, percent: 10, target_cents: 240000, balance_cents: 0 });
  expect(goalProgress([g], 600000)[0]!.months_to_target).toBe(4); // 60000 a month
  expect(goalProgress([g], 300000)[0]!.months_to_target).toBe(8); // 30000 a month
});

test("the balance total counts every bucket, including inactive ones", () => {
  expect(
    savingsBalanceTotal([
      bucket({ balance_cents: 120000 }),
      bucket({ balance_cents: 80000, active: false }),
    ]),
  ).toBe(200000);
  expect(goalProgress([bucket({ balance_cents: 80000, active: false })], 0)).toEqual([]);
});
