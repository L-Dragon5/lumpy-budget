import { expect, test } from "bun:test";
import { category, expense, fixedCost } from "../fixtures/factories";
import { fixedCostVariance } from "../src/variance";

const utilities = category({ name: "Utilities", bucket: "fixed" });
const rentCat = category({ name: "Rent", bucket: "fixed" });
const groceries = category({ name: "Groceries", bucket: "discretionary" });
const cats = [utilities, rentCat, groceries];

const gas = fixedCost({ name: "Gas and electric", amount_cents: 9000, category_id: utilities.id });
const rent = fixedCost({ name: "Rent", amount_cents: 150000, category_id: rentCat.id });

// Three complete months before March, plus noise March itself must not count.
const expenses = [
  expense({ txn_date: "2025-12-04", amount_cents: 13000, category_id: utilities.id }),
  expense({ txn_date: "2026-01-04", amount_cents: 15000, category_id: utilities.id }),
  expense({ txn_date: "2026-02-04", amount_cents: 14000, category_id: utilities.id }),
  expense({ txn_date: "2026-03-04", amount_cents: 99900, category_id: utilities.id }),
  expense({ txn_date: "2025-12-01", amount_cents: 150000, category_id: rentCat.id }),
  expense({ txn_date: "2026-01-01", amount_cents: 150000, category_id: rentCat.id }),
  expense({ txn_date: "2026-02-01", amount_cents: 150000, category_id: rentCat.id }),
  expense({ txn_date: "2026-01-09", amount_cents: 8000, category_id: groceries.id }),
];

test("a variable bill shows what it actually costs, not what it was entered at", () => {
  const [worst] = fixedCostVariance([gas, rent], cats, expenses, { through: "2026-03", months: 3 });
  expect(worst!.category_name).toBe("Utilities");
  expect(worst!.actual_avg_cents).toBe(14000);
  expect(worst!.budgeted_cents).toBe(9000);
  expect(worst!.delta_cents).toBe(5000);
  expect(Math.round(worst!.pct_off)).toBe(56);
  expect(worst!.months_with_data).toBe(3);
});

test("the current month is excluded: it is half billed and would drag the average down", () => {
  const rows = fixedCostVariance([gas], cats, expenses, { through: "2026-03", months: 3 });
  expect(rows[0]!.actual_by_month.map((r) => r.month)).toEqual(["2025-12", "2026-01", "2026-02"]);
  expect(rows[0]!.actual_by_month.some((r) => r.amount_cents === 99900)).toBe(false);
});

test("a bill that matches its budget reports no delta", () => {
  const rows = fixedCostVariance([rent], cats, expenses, { through: "2026-03", months: 3 });
  expect(rows[0]!.delta_cents).toBe(0);
  expect(rows[0]!.pct_off).toBe(0);
});

test("a month with no matching expense is missing data, not a free month", () => {
  const only = [expense({ txn_date: "2026-02-04", amount_cents: 14000, category_id: utilities.id })];
  const [row] = fixedCostVariance([gas], cats, only, { through: "2026-03", months: 3 });
  expect(row!.months_with_data).toBe(1);
  // 14000 over one real month, not 14000/3 over three.
  expect(row!.actual_avg_cents).toBe(14000);
});

test("nothing imported yet reports no delta rather than a bill that costs nothing", () => {
  const [row] = fixedCostVariance([gas], cats, [], { through: "2026-03", months: 3 });
  expect(row!.months_with_data).toBe(0);
  expect(row!.actual_avg_cents).toBe(0);
  expect(row!.delta_cents).toBe(0);
});

test("two bills sharing a category are compared as one, and inactive bills are ignored", () => {
  const water = fixedCost({ name: "Water", amount_cents: 4000, category_id: utilities.id });
  const old = fixedCost({ name: "Old plan", amount_cents: 50000, category_id: utilities.id, active: false });
  const [row] = fixedCostVariance([gas, water, old], cats, expenses, { through: "2026-03", months: 3 });
  expect(row!.cost_names).toEqual(["Gas and electric", "Water"]);
  expect(row!.budgeted_cents).toBe(13000);
  expect(row!.delta_cents).toBe(1000);
});

test("rows with data sort ahead of rows without, biggest surprise first", () => {
  const phoneCat = category({ name: "Phone", bucket: "fixed" });
  const phone = fixedCost({ name: "Phone", amount_cents: 7000, category_id: phoneCat.id });
  const rows = fixedCostVariance([gas, rent, phone], [...cats, phoneCat], expenses, { through: "2026-03", months: 3 });
  // Utilities is off by $50, Rent by nothing, Phone has no statement imported at all.
  expect(rows.map((r) => r.category_name)).toEqual(["Utilities", "Rent", "Phone"]);
  expect(rows.at(-1)!.months_with_data).toBe(0);
});

test("a bill with no category is left out: there is nothing to compare it to", () => {
  const orphan = fixedCost({ name: "Storage unit", amount_cents: 5000, category_id: null });
  expect(fixedCostVariance([orphan], cats, expenses, { through: "2026-03" })).toEqual([]);
});
