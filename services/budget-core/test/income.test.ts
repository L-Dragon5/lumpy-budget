import { expect, test } from "bun:test";
import { stream } from "../fixtures/factories";
import { incomeCalendar, monthlyActual, monthlyNormalized, nextPaycheck } from "../src/income";

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
