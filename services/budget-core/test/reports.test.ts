import { expect, test } from "bun:test";
import { category, expense } from "../fixtures/factories";
import { breakdown, bucketOf, categoryIndex, series, totalsByBucket, UNCATEGORIZED } from "../src/reports";

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
  expect(bucketOf({ category_id: null }, byId)).toBe("discretionary");
  expect(bucketOf({ category_id: rent.id }, byId)).toBe("fixed");
  expect(bucketOf({ category_id: 99999 }, byId)).toBe("discretionary");
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
