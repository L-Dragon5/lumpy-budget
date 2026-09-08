import { expect, test } from "bun:test";
import { fixedCost, goal, lumpy, stream } from "../fixtures/factories";
import { forecast, monthsThatCanAfford, monthsToAfford } from "../src/forecast";
import { monthSummary } from "../src/summary";

const base = {
  streams: [stream({ name: "Job", amount_cents: 200000, frequency: "biweekly", anchor_date: "2026-01-02" })],
  fixedCosts: [fixedCost({ name: "Rent", amount_cents: 150000, due_day: 1 })],
  lumpyItems: [lumpy({ name: "Car insurance", amount_cents: 120000, frequency_months: 12, next_due_date: "2026-07-15" })],
  savingsGoals: [goal({ name: "Emergency", mode: "fixed" as const, amount_cents: 20000 })],
  start: "2026-03",
  months: 12,
};

test("twelve months out, and the first one agrees with the month summary", () => {
  const f = forecast(base);
  expect(f.rows).toHaveLength(12);
  expect(f.rows.map((r) => r.month)[0]).toBe("2026-03");
  expect(f.rows[11]!.month).toBe("2027-02");

  // The forecast is not a second opinion: month one has to be the number the
  // dashboard already shows for that month.
  const s = monthSummary({
    ...base,
    month: "2026-03",
    expenses: [],
    categories: [],
    lumpyOpeningBalanceCents: 0,
  });
  expect(f.rows[0]!.planned_free_cents).toBe(s.planned_free_cents);
  expect(f.rows[0]!.lumpy_cents).toBe(s.lumpy_cents);
  expect(f.rows[0]!.income_cents).toBe(s.income_cents);
});

test("an extra-paycheck month shows up as one, and it is the roomiest month", () => {
  const f = forecast(base);
  const extra = f.rows.filter((r) => r.extra_paycheck);
  expect(extra.length).toBeGreaterThan(0);
  for (const r of extra) {
    expect(r.income_cents).toBeGreaterThan(r.income_normalized_cents);
    expect(r.planned_free_cents).toBeGreaterThan(f.average_free_cents);
  }
});

test("the month the insurance is paid names what leaves the fund", () => {
  const july = forecast(base).rows.find((r) => r.month === "2026-07")!;
  expect(july.lumpy_due_cents).toBe(120000);
  expect(july.lumpy_due.map((x) => x.name)).toEqual(["Car insurance"]);
  // It leaves the *fund*, which was saved for month by month, so the month's own
  // free cash is untouched by it: what is committed out of July's income is
  // exactly what is committed out of June's, paid bill or no paid bill.
  const june = forecast(base).rows.find((r) => r.month === "2026-06")!;
  const committed = (r: typeof july) => r.income_cents - r.planned_free_cents;
  expect(committed(july)).toBe(committed(june));
});

test("a plan that does not balance names the first month it stops balancing", () => {
  const f = forecast({ ...base, fixedCosts: [fixedCost({ name: "Rent", amount_cents: 420000 })] });
  expect(f.first_tight_month).toBe("2026-03");
  expect(f.tightest_month).not.toBeNull();
  // Every ordinary month is short; the three-paycheck months are the only ones
  // that carry it, which is the whole reason the surplus is worth naming.
  expect(f.rows.filter((r) => !r.tight).every((r) => r.extra_paycheck)).toBe(true);
  expect(f.rows.filter((r) => r.tight).length).toBeGreaterThan(6);
});

test("a fund that runs dry says so, in the month it does", () => {
  const f = forecast({
    ...base,
    lumpyItems: [lumpy({ name: "Taxes", amount_cents: 600000, frequency_months: 12, next_due_date: "2026-05-01" })],
    lumpyOpeningBalanceCents: 0,
    lumpyMode: "steady",
  });
  expect(f.first_short_month).toBe("2026-05");
});

test("what a purchase costs, answered in months", () => {
  const f = forecast(base);
  const affordable = monthsThatCanAfford(f, 10000);
  expect(affordable.length).toBeGreaterThan(0);
  // Nothing in a twelve-month window covers a million dollars out of one month.
  expect(monthsThatCanAfford(f, 100000000)).toEqual([]);
  expect(monthsToAfford(f, 100000000)).toBeNull();
  // Saving one month's free cash covers something that costs one month's free cash.
  expect(monthsToAfford(f, f.rows[0]!.planned_free_cents)).toBe(1);
  expect(monthsToAfford(f, 1)).toBe(1);
});

test("no income, no free cash, and no crash", () => {
  const f = forecast({ ...base, streams: [], savingsGoals: [] });
  expect(f.rows).toHaveLength(12);
  expect(f.rows.every((r) => r.income_cents === 0)).toBe(true);
  expect(f.rows.every((r) => r.tight)).toBe(true);
});
