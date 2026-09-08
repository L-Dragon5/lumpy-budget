import { expect, test } from "bun:test";
import { category, expense, fixedCost } from "../fixtures/factories";
import { fixedCostVariance, monthsWithoutStatements, varianceWindow } from "../src/variance";

const utilities = category({ name: "Utilities", bucket: "fixed" });
const rentCat = category({ name: "Rent", bucket: "fixed" });
const groceries = category({ name: "Groceries", bucket: "discretionary" });
const cats = [utilities, rentCat, groceries];

const gas = fixedCost({ name: "Gas and electric", amount_cents: 9000, category_id: utilities.id });
const rent = fixedCost({ name: "Rent", amount_cents: 150000, category_id: rentCat.id });

// Three complete months before March, plus noise March itself must not count.
const expenses = [
  expense({ txn_date: "2025-12-04", amount_cents: 13000, category_id: utilities.id, merchant: "NATIONAL GRID" }),
  expense({ txn_date: "2026-01-04", amount_cents: 15000, category_id: utilities.id, merchant: "NATIONAL GRID" }),
  expense({ txn_date: "2026-02-04", amount_cents: 14000, category_id: utilities.id, merchant: "NATIONAL GRID" }),
  expense({ txn_date: "2026-03-04", amount_cents: 99900, category_id: utilities.id, merchant: "NATIONAL GRID" }),
  expense({ txn_date: "2025-12-01", amount_cents: 150000, category_id: rentCat.id, merchant: "LANDLORD" }),
  expense({ txn_date: "2026-01-01", amount_cents: 150000, category_id: rentCat.id, merchant: "LANDLORD" }),
  expense({ txn_date: "2026-02-01", amount_cents: 150000, category_id: rentCat.id, merchant: "LANDLORD" }),
  expense({ txn_date: "2026-01-09", amount_cents: 8000, category_id: groceries.id, merchant: "WEGMANS" }),
];

test("a variable bill shows what it actually costs, not what it was entered at", () => {
  const [worst] = fixedCostVariance([gas, rent], cats, expenses, { through: "2026-03", months: 3 });
  expect(worst!.cost_names).toEqual(["Gas and electric"]);
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

test("without a merchant, bills sharing a category are compared as one lump", () => {
  const water = fixedCost({ name: "Water", amount_cents: 4000, category_id: utilities.id });
  const old = fixedCost({ name: "Old plan", amount_cents: 50000, category_id: utilities.id, active: false });
  const [row] = fixedCostVariance([gas, water, old], cats, expenses, { through: "2026-03", months: 3 });
  expect(row!.matched_by).toBe("category");
  expect(row!.cost_names).toEqual(["Gas and electric", "Water"]);
  expect(row!.budgeted_cents).toBe(13000);
  expect(row!.delta_cents).toBe(1000);
});

test("a merchant pattern answers for one bill and leaves the rest of the category alone", () => {
  const grid = fixedCost({ ...gas, merchant_pattern: "national grid" });
  const water = fixedCost({ name: "Water", amount_cents: 7200, category_id: utilities.id });
  const trash = fixedCost({ name: "Trash", amount_cents: 4900, category_id: utilities.id });
  const rows = fixedCostVariance([grid, water, trash], cats, expenses, { through: "2026-03", months: 3 });

  const bill = rows.find((r) => r.key === `cost:${grid.id}`)!;
  expect(bill.matched_by).toBe("merchant");
  expect(bill.merchants).toEqual(["NATIONAL GRID"]);
  expect(bill.actual_avg_cents).toBe(14000);
  expect(bill.delta_cents).toBe(5000);

  // The two without a pattern are still a lump, but National Grid's money is no
  // longer inside it, so it reads as the missing statements it is.
  const lump = rows.find((r) => r.key === `category:${utilities.id}`)!;
  expect(lump.cost_names).toEqual(["Water", "Trash"]);
  expect(lump.months_with_data).toBe(0);
  expect(lump.actual_avg_cents).toBe(0);
});

test("a matched expense is never counted twice, in its bill and again in its category", () => {
  const grid = fixedCost({ ...gas, merchant_pattern: "national grid" });
  const water = fixedCost({ name: "Water", amount_cents: 7200, category_id: utilities.id });
  const rows = fixedCostVariance([grid, water], cats, expenses, { through: "2026-03", months: 3 });
  const total = rows.reduce((a, r) => a + r.actual_by_month.reduce((x, m) => x + m.amount_cents, 0), 0);
  // The three in-window National Grid rows, once.
  expect(total).toBe(13000 + 15000 + 14000);
});

test("the more specific pattern wins when two could match the same transaction", () => {
  const broad = fixedCost({ name: "Anything", amount_cents: 1000, category_id: null, merchant_pattern: "grid" });
  const exact = fixedCost({ name: "Gas and electric", amount_cents: 9000, category_id: null, merchant_pattern: "national grid" });
  const rows = fixedCostVariance([broad, exact], cats, expenses, { through: "2026-03", months: 3 });
  expect(rows.find((r) => r.key === `cost:${exact.id}`)!.months_with_data).toBe(3);
  expect(rows.find((r) => r.key === `cost:${broad.id}`)!.months_with_data).toBe(0);
});

test("the pattern matches the description too, the way the importer does", () => {
  const bill = fixedCost({ name: "Water", amount_cents: 7200, category_id: null, merchant_pattern: "city water" });
  const rows = [
    expense({ txn_date: "2026-01-06", amount_cents: 7500, merchant: "ACH DEBIT", description: "CITY WATER DEPT" }),
  ];
  const [row] = fixedCostVariance([bill], cats, rows, { through: "2026-02", months: 1 });
  expect(row!.months_with_data).toBe(1);
  expect(row!.delta_cents).toBe(300);
});

test("a pattern beats the category, so a bill posted under the wrong one is still found", () => {
  // Miscategorized as groceries by a bad import rule; the pattern does not care.
  const bill = fixedCost({ name: "Gas and electric", amount_cents: 9000, category_id: utilities.id, merchant_pattern: "wegmans" });
  const [row] = fixedCostVariance([bill], cats, expenses, { through: "2026-03", months: 3 });
  expect(row!.months_with_data).toBe(1);
  expect(row!.actual_avg_cents).toBe(8000);
});

test("rows with data sort ahead of rows without, biggest surprise first", () => {
  const phoneCat = category({ name: "Phone", bucket: "fixed" });
  const phone = fixedCost({ name: "Phone", amount_cents: 7000, category_id: phoneCat.id });
  const rows = fixedCostVariance([gas, rent, phone], [...cats, phoneCat], expenses, { through: "2026-03", months: 3 });
  // Utilities is off by $50, Rent by nothing, Phone has no statement imported at all.
  expect(rows.map((r) => r.cost_names.join())).toEqual(["Gas and electric", "Rent", "Phone"]);
  expect(rows.at(-1)!.months_with_data).toBe(0);
});

test("a bill with neither a category nor a merchant is left out: nothing to compare it to", () => {
  const orphan = fixedCost({ name: "Storage unit", amount_cents: 5000, category_id: null });
  expect(fixedCostVariance([orphan], cats, expenses, { through: "2026-03" })).toEqual([]);
});

test("a whole-word pattern will not reconcile a bill with a longer name", () => {
  const bill = fixedCost({
    name: "Fuel card", amount_cents: 5000, category_id: null,
    merchant_pattern: "bp", merchant_whole_word: true,
  });
  const rows = [
    expense({ txn_date: "2026-01-04", amount_cents: 5200, merchant: "BP #4021 FUEL", description: "" }),
    expense({ txn_date: "2026-02-04", amount_cents: 4900, merchant: "BP1234", description: "" }),
    // The one that should not count: a different company entirely. Inside the
    // window on purpose -- `through` ends the window the month before, so a March
    // charge with through="2026-03" would be excluded by the calendar and the
    // test would pass whatever the matcher did.
    expense({ txn_date: "2026-03-04", amount_cents: 99900, merchant: "BPOST BRUSSELS", description: "" }),
  ];
  const [row] = fixedCostVariance([bill], cats, rows, { through: "2026-04", months: 3 });
  expect(row!.months_with_data).toBe(2);
  expect(row!.merchants.sort()).toEqual(["BP #4021 FUEL", "BP1234"]);
  // Without the switch that BPOST charge drags the average from 5050 to 36666.
  expect(row!.actual_avg_cents).toBe(5050);
});

test("without the switch the same bill is the substring it has always been", () => {
  const bill = fixedCost({ name: "Fuel card", amount_cents: 5000, category_id: null, merchant_pattern: "bp" });
  const rows = [expense({ txn_date: "2026-01-04", amount_cents: 99900, merchant: "BPOST BRUSSELS", description: "" })];
  const [row] = fixedCostVariance([bill], cats, rows, { through: "2026-02", months: 1 });
  expect(row!.months_with_data).toBe(1);
});

test("a whole-word bill leaves the transaction for the next pattern, not unclaimed", () => {
  // Claiming is exclusive: a bill that passes on a transaction has to really pass,
  // and the pattern behind it must still get it. The strict pattern is the longer
  // of the two on purpose, so the sort puts it first and it is the one declining.
  const strict = fixedCost({
    name: "Post office", amount_cents: 1800, category_id: null,
    merchant_pattern: "bpos", merchant_whole_word: true,
  });
  const loose = fixedCost({ name: "Fuel card", amount_cents: 5000, category_id: null, merchant_pattern: "bp" });
  const rows = [expense({ txn_date: "2026-01-04", amount_cents: 1900, merchant: "BPOST BRUSSELS", description: "" })];
  const out = fixedCostVariance([strict, loose], cats, rows, { through: "2026-02", months: 1 });
  expect(out.find((r) => r.key === `cost:${strict.id}`)!.months_with_data).toBe(0);
  expect(out.find((r) => r.key === `cost:${loose.id}`)!.months_with_data).toBe(1);
});

test("a month a bill did not post is named, so it reads as a missing statement", () => {
  const patterned = fixedCost({ name: "Gas and electric", amount_cents: 9000, category_id: utilities.id, merchant_pattern: "national grid" });
  const [row] = fixedCostVariance([patterned], cats, expenses, { through: "2026-03", months: 3 });
  expect(row!.missing_months).toEqual([]);

  const gap = expenses.filter((e) => e.txn_date !== "2026-01-04");
  const [withGap] = fixedCostVariance([patterned], cats, gap, { through: "2026-03", months: 3 });
  expect(withGap!.months_with_data).toBe(2);
  expect(withGap!.missing_months).toEqual(["2026-01"]);
});

test("a bill that has never been reconciled reports no missing months, only no data", () => {
  // Every month is missing, which is not the same thing as one month missing:
  // that row already says months_with_data 0, and twelve badges say nothing.
  const [row] = fixedCostVariance([gas], cats, [], { through: "2026-03", months: 3 });
  expect(row!.months_with_data).toBe(0);
  expect(row!.missing_months).toEqual([]);
});

test("a merchant row names the bill it can write back to; a category row cannot", () => {
  const patterned = fixedCost({ name: "Gas and electric", amount_cents: 9000, category_id: utilities.id, merchant_pattern: "national grid" });
  const rows = fixedCostVariance([patterned, rent], cats, expenses, { through: "2026-03", months: 3 });
  const byMerchant = rows.find((r) => r.matched_by === "merchant")!;
  expect(byMerchant.fixed_cost_id).toBe(patterned.id);
  const byCategory = rows.find((r) => r.matched_by === "category")!;
  expect(byCategory.fixed_cost_id).toBeNull();
});

test("a month nobody imported is one fact about the window, not a fault of every bill", () => {
  const patterned = fixedCost({ name: "Gas and electric", amount_cents: 9000, category_id: utilities.id, merchant_pattern: "national grid" });
  // February is missing from the file entirely: no bill posted, nothing at all did.
  const noFebruary = expenses.filter((e) => !e.txn_date.startsWith("2026-02"));

  const [row] = fixedCostVariance([patterned], cats, noFebruary, { through: "2026-03", months: 3 });
  expect(row!.months_with_data).toBe(2);
  // Not badged per bill: the window says it once.
  expect(row!.missing_months).toEqual([]);
  expect(monthsWithoutStatements(noFebruary, { through: "2026-03", months: 3 })).toEqual(["2026-02"]);
});

test("a bill that skipped a month other things did not is still badged", () => {
  const patterned = fixedCost({ name: "Gas and electric", amount_cents: 9000, category_id: utilities.id, merchant_pattern: "national grid" });
  const gap = expenses.filter((e) => e.txn_date !== "2026-01-04");
  const [row] = fixedCostVariance([patterned], cats, gap, { through: "2026-03", months: 3 });
  // January still has the rent, so January is a month this bill went missing in.
  expect(row!.missing_months).toEqual(["2026-01"]);
  expect(monthsWithoutStatements(gap, { through: "2026-03", months: 3 })).toEqual([]);
});

test("the window is three complete months, ending before `through`", () => {
  expect(varianceWindow({ through: "2026-03", months: 3 })).toEqual(["2025-12", "2026-01", "2026-02"]);
  expect(varianceWindow({ through: "2026-03" })).toEqual(["2025-12", "2026-01", "2026-02"]);
  expect(varianceWindow({ through: "2026-03", months: 1 })).toEqual(["2026-02"]);
});
