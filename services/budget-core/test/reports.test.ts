import { expect, test } from "bun:test";
import { category, expense } from "../fixtures/factories";
import {
  breakdown, bucketOf, categoryIndex, categoryPace, median, series, totalsByBucket, UNCATEGORIZED,
} from "../src/reports";

const groceries = category({ name: "Groceries", bucket: "discretionary", color: "#4f46e5" });
const rent = category({ name: "Rent", bucket: "fixed" });
const cats = [groceries, rent];

const rows = [
  expense({ txn_date: "2026-01-05", amount_cents: 12000, category_id: groceries.id, merchant: "Wegmans" }),
  expense({ txn_date: "2026-01-08", amount_cents: 8000, category_id: groceries.id, merchant: "Aldi" }),
  expense({ txn_date: "2026-01-01", amount_cents: 150000, category_id: rent.id, merchant: "Landlord" }),
  expense({ txn_date: "2026-01-20", amount_cents: 3000, category_id: null, merchant: "Unknown LLC" }),
  expense({ txn_date: "2026-02-03", amount_cents: 5000, category_id: groceries.id, merchant: "Wegmans" }),
];

test("an uncategorized expense counts as discretionary, which is the safe direction", () => {
  const byId = categoryIndex(cats);
  expect(bucketOf({ category_id: null, amount_cents: 3000 }, byId)).toBe("discretionary");
  expect(bucketOf({ category_id: rent.id, amount_cents: 150000 }, byId)).toBe("fixed");
  // A category that no longer exists is no category at all, sign rule included.
  expect(bucketOf({ category_id: 99999, amount_cents: 3000 }, byId)).toBe("discretionary");
  expect(bucketOf({ category_id: 99999, amount_cents: -3000 }, byId)).toBe("transfer");
});

test("bucket totals separate real spending from bills being paid", () => {
  const t = totalsByBucket(rows, cats);
  expect(t.discretionary).toBe(12000 + 8000 + 3000 + 5000);
  expect(t.fixed).toBe(150000);
  expect(t.total).toBe(178000);
});

test("breakdown sorts biggest first and percentages sum to 100", () => {
  const b = breakdown(rows, cats, { start: "2026-01-01", end: "2026-01-31" });
  expect(b.total_cents).toBe(173000);
  expect(b.txn_count).toBe(4);
  expect(b.slices.map((s) => s.name)).toEqual(["Rent", "Groceries", UNCATEGORIZED]);
  expect(b.slices[1]!.amount_cents).toBe(20000);
  expect(b.slices[1]!.txn_count).toBe(2);
  expect(b.slices[1]!.color).toBe("#4f46e5");
  expect(Math.round(b.slices.reduce((a, s) => a + s.pct, 0))).toBe(100);
});

test("breakdown filters to one bucket", () => {
  const b = breakdown(rows, cats, { start: "2026-01-01", end: "2026-01-31", bucket: "discretionary" });
  expect(b.total_cents).toBe(23000);
  expect(b.slices.map((s) => s.name)).toEqual(["Groceries", UNCATEGORIZED]);
});

test("an empty window returns zeroes, not NaN", () => {
  const b = breakdown(rows, cats, { start: "2026-06-01", end: "2026-06-30" });
  expect(b).toEqual({ slices: [], total_cents: 0, txn_count: 0 });
});

test("weekly series uses Sunday weeks and fills the gaps with zero", () => {
  const s = series(rows, { granularity: "week", start: "2026-01-01", end: "2026-01-31" }, cats);
  expect(s[0]!.key).toBe("2025-12-28");
  expect(s[0]!.end).toBe("2026-01-03");
  expect(s[0]!.amount_cents).toBe(150000); // Jan 1 rent
  expect(s[1]!.key).toBe("2026-01-04");
  expect(s[1]!.amount_cents).toBe(20000); // Jan 5 and Jan 8
  expect(s[2]!.amount_cents).toBe(0);
  expect(s.find((p) => p.key === "2026-01-18")!.amount_cents).toBe(3000);
  expect(s.reduce((a, p) => a + p.amount_cents, 0)).toBe(173000);
});

test("monthly series covers every month in the range", () => {
  const s = series(rows, { granularity: "month", start: "2026-01-01", end: "2026-03-31" }, cats);
  expect(s.map((p) => p.key)).toEqual(["2026-01", "2026-02", "2026-03"]);
  expect(s.map((p) => p.amount_cents)).toEqual([173000, 5000, 0]);
  expect(s[0]!.end).toBe("2026-01-31");
});

// ------------------------------------------------------ this month, so far

const dining = category({ name: "Dining", bucket: "discretionary" });
const fuel = category({ name: "Fuel", bucket: "discretionary" });

/** Three months of groceries, always on the 3rd, plus a late-month top-up. */
const paceRows = [
  expense({ txn_date: "2026-01-03", amount_cents: 10000, category_id: groceries.id }),
  expense({ txn_date: "2026-01-28", amount_cents: 90000, category_id: groceries.id }),
  expense({ txn_date: "2026-02-03", amount_cents: 20000, category_id: groceries.id }),
  expense({ txn_date: "2026-02-28", amount_cents: 90000, category_id: groceries.id }),
  expense({ txn_date: "2026-03-03", amount_cents: 30000, category_id: groceries.id }),
  expense({ txn_date: "2026-03-28", amount_cents: 90000, category_id: groceries.id }),
  expense({ txn_date: "2026-04-03", amount_cents: 50000, category_id: groceries.id }),
];

test("this month is compared against the same stretch of earlier months", () => {
  const pace = categoryPace(paceRows, [groceries], { today: "2026-04-10", months: 3 });
  expect(pace.month).toBe("2026-04");
  expect(pace.through_day).toBe(10);
  expect(pace.months_compared).toEqual(["2026-01", "2026-02", "2026-03"]);

  const [row] = pace.rows;
  expect(row!.month_to_date_cents).toBe(50000);
  // The 28th of each month is past day 10 and is not in the comparison; a full
  // month's average against ten days of spending would say you are always under.
  expect(row!.by_month.map((m) => m.amount_cents)).toEqual([10000, 20000, 30000]);
  expect(row!.typical_cents).toBe(20000);
  expect(row!.delta_cents).toBe(30000);
  expect(row!.pct_off).toBe(150);
});

test("the median, not the mean: one bad month is not the number to live up to", () => {
  const rows = [
    expense({ txn_date: "2026-01-05", amount_cents: 10000, category_id: dining.id }),
    expense({ txn_date: "2026-02-05", amount_cents: 12000, category_id: dining.id }),
    // A wedding. The mean would be $47k and every future month would read as thrift.
    expense({ txn_date: "2026-03-05", amount_cents: 120000, category_id: dining.id }),
    expense({ txn_date: "2026-04-05", amount_cents: 15000, category_id: dining.id }),
  ];
  const [row] = categoryPace(rows, [dining], { today: "2026-04-10", months: 3 }).rows;
  expect(row!.typical_cents).toBe(12000);
  expect(row!.delta_cents).toBe(3000);
});

test("a month nobody imported is not a month you spent nothing", () => {
  const rows = [
    expense({ txn_date: "2026-01-05", amount_cents: 10000, category_id: fuel.id }),
    // February has no statement at all, so it is not a zero to average in.
    expense({ txn_date: "2026-03-05", amount_cents: 12000, category_id: fuel.id }),
    expense({ txn_date: "2026-04-05", amount_cents: 30000, category_id: fuel.id }),
  ];
  const pace = categoryPace(rows, [fuel], { today: "2026-04-10", months: 3 });
  expect(pace.months_compared).toEqual(["2026-01", "2026-03"]);
  expect(pace.rows[0]!.typical_cents).toBe(11000);

  // But a month whose statement holds something else is a real zero for fuel.
  const withRent = [...rows, expense({ txn_date: "2026-02-01", amount_cents: 150000, category_id: rent.id })];
  const both = categoryPace(withRent, [fuel, rent], { today: "2026-04-10", months: 3 });
  expect(both.months_compared).toEqual(["2026-01", "2026-02", "2026-03"]);
  expect(both.rows.find((r) => r.category_id === fuel.id)!.by_month.map((m) => m.amount_cents))
    .toEqual([10000, 0, 12000]);
  // Rent is fixed, so it is not in a discretionary comparison at all.
  expect(both.rows.map((r) => r.name)).toEqual(["Fuel"]);
});

test("the worst overspend sorts first, and nothing divides by a zero history", () => {
  const rows = [
    expense({ txn_date: "2026-03-05", amount_cents: 5000, category_id: dining.id }),
    expense({ txn_date: "2026-04-05", amount_cents: 9000, category_id: dining.id }),
    // Nothing in the history at all: new this month.
    expense({ txn_date: "2026-04-06", amount_cents: 40000, category_id: fuel.id }),
  ];
  const pace = categoryPace(rows, [dining, fuel], { today: "2026-04-10", months: 3 });
  expect(pace.rows.map((r) => r.name)).toEqual(["Fuel", "Dining"]);
  expect(pace.rows[0]!.typical_cents).toBe(0);
  expect(pace.rows[0]!.pct_off).toBe(0);
});

test("the median averages the two middles and rounds away from zero", () => {
  expect(median([])).toBe(0);
  expect(median([7])).toBe(7);
  expect(median([3, 1, 2])).toBe(2);
  expect(median([1, 2, 3, 5])).toBe(3);
  expect(median([-3, -2])).toBe(-3);
});

const income = category({ name: "Income", bucket: "income" });

test("an uncategorized credit is neutral rather than discretionary", () => {
  // A paycheck the importer could not place. Counted as discretionary it pays
  // $2,400 back into what you can spend, which is the one direction this app
  // must never guess in.
  const deposit = expense({ amount_cents: -240000, category_id: null });
  expect(bucketOf(deposit, categoryIndex(cats))).toBe("transfer");
});

test("an uncategorized charge is still discretionary", () => {
  expect(bucketOf(expense({ amount_cents: 4200, category_id: null }), categoryIndex(cats))).toBe("discretionary");
});

test("a categorized refund still credits the category it came out of", () => {
  // The rule is about rows nobody has placed. A refund somebody categorized is
  // a fact, and it belongs against its own category.
  const refund = expense({ amount_cents: -1500, category_id: groceries.id });
  expect(bucketOf(refund, categoryIndex(cats))).toBe("discretionary");
});

test("an uncategorized credit does not inflate what is available to spend", () => {
  const totals = totalsByBucket(
    [expense({ amount_cents: 4200, category_id: groceries.id }), expense({ amount_cents: -240000, category_id: null })],
    cats,
  );
  expect(totals.discretionary).toBe(4200);
  expect(totals.transfer).toBe(-240000);
  expect(totals.income).toBe(0);
});

test("a deposit in an income category lands in the income bucket", () => {
  const deposit = expense({ amount_cents: -240000, category_id: income.id });
  expect(bucketOf(deposit, categoryIndex([...cats, income]))).toBe("income");
});

test("the uncategorized slice is labelled with the bucket its rows were counted in", () => {
  // bucketOf puts an unplaced credit in `transfer`; a table that then labels
  // the same slice "Discretionary" contradicts the filter that selected it.
  const unplaced = [
    expense({ txn_date: "2026-03-15", amount_cents: -240000, category_id: null }),
    expense({ txn_date: "2026-03-20", amount_cents: 4200, category_id: null }),
  ];
  const window = { start: "2026-03-01", end: "2026-03-31" };
  const transfers = breakdown(unplaced, cats, { ...window, bucket: "transfer" });
  expect(transfers.slices).toMatchObject([{ name: UNCATEGORIZED, bucket: "transfer", amount_cents: -240000 }]);
  const discretionary = breakdown(unplaced, cats, { ...window, bucket: "discretionary" });
  expect(discretionary.slices).toMatchObject([{ name: UNCATEGORIZED, bucket: "discretionary", amount_cents: 4200 }]);
});
