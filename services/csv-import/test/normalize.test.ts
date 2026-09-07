import { expect, test } from "bun:test";
import type { CategoryRule } from "@lumpy/contracts";
import { parseCsv } from "../src/parse";
import { applyRules, dedupeKey, guessMapping, normalize, normalizeMerchant } from "../src/normalize";

const chase = parseCsv(
  "Transaction Date,Post Date,Description,Category,Type,Amount\n" +
  "03/14/2026,03/15/2026,WEGMANS #123,Groceries,Sale,-84.21\n" +
  "03/16/2026,03/17/2026,NETFLIX.COM,Entertainment,Sale,-15.49\n" +
  "03/20/2026,03/21/2026,PAYMENT THANK YOU,,Payment,250.00\n",
);

test("a Chase-shaped export maps itself", () => {
  const m = guessMapping(chase);
  expect(m.date_column).toBe("Transaction Date"); // when it was spent, not when it posted
  expect(m.amount_column).toBe("Amount");
  expect(m.merchant_column).toBe("Description");
  expect(m.description_column).toBe("Category");
  expect(m.date_format).toBe("MM/DD/YYYY");
  expect(m.flip_sign).toBe(true); // the file writes spending as negative
});

test("normalizing that export makes spending positive and refunds negative", () => {
  const { rows, errors } = normalize(chase, guessMapping(chase));
  expect(errors).toEqual([]);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ txn_date: "2026-03-14", amount_cents: 8421, merchant: "WEGMANS #123", description: "Groceries" });
  expect(rows[2]!.amount_cents).toBe(-25000); // a payment is money coming back
});

test("a debit/credit statement folds into one signed amount", () => {
  const csv = parseCsv(
    "Date,Description,Debit,Credit\n" +
    "2026-03-01,RENT,1500.00,\n" +
    "2026-03-02,PAYROLL,,3000.00\n",
  );
  const m = guessMapping(csv);
  expect(m.amount_column).toBeNull();
  expect(m.debit_column).toBe("Debit");
  expect(m.credit_column).toBe("Credit");
  const { rows, errors } = normalize(csv, m);
  expect(errors).toEqual([]);
  expect(rows.map((r) => r.amount_cents)).toEqual([150000, -300000]);
});

test("bad rows are reported by line number instead of silently dropped", () => {
  const csv = parseCsv("Date,Description,Amount\n2026-03-01,GOOD,10.00\nPENDING,BAD,10.00\n2026-03-03,NOAMT,\n");
  const { rows, errors } = normalize(csv, { ...guessMapping(csv), flip_sign: false });
  expect(rows).toHaveLength(1);
  expect(errors).toEqual([
    { row: 3, field: "Date", value: "PENDING", message: "unreadable date" },
    { row: 4, field: "Amount", value: "", message: "unreadable amount" },
  ]);
});

test("the dedupe key ignores the noise banks add and nothing else", () => {
  const base = { txn_date: "2026-03-14", amount_cents: 8421, merchant: "WEGMANS #123" };
  expect(dedupeKey(base)).toBe(dedupeKey({ ...base, merchant: "  wegmans   #123  " }));
  expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, amount_cents: 8422 }));
  expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, txn_date: "2026-03-16" }));
  expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, merchant: "WEGMANS #124" }));
  expect(normalizeMerchant("Café  Nero*  1234")).toBe("CAFE NERO 1234");
});

const rule = (p: Partial<CategoryRule>): CategoryRule =>
  ({ id: 1, pattern: "x", category_id: 1, priority: 100, ...p });

test("rules categorize on import, lowest priority number first", () => {
  const rows = [
    { merchant: "WEGMANS #123", description: "Groceries", category_id: null },
    { merchant: "NETFLIX.COM", description: "", category_id: null },
    { merchant: "SOMETHING ELSE", description: "", category_id: null },
    { merchant: "WEGMANS #999", description: "", category_id: 42 },
  ];
  const out = applyRules(rows, [
    rule({ id: 1, pattern: "wegmans", category_id: 7, priority: 10 }),
    rule({ id: 2, pattern: "netflix", category_id: 8, priority: 10 }),
    rule({ id: 3, pattern: "wegmans #123", category_id: 99, priority: 50 }),
  ]);
  expect(out.map((r) => r.category_id)).toEqual([7, 8, null, 42]);
});

test("a rule can match on the description, not just the merchant", () => {
  const out = applyRules(
    [{ merchant: "SQ *UNKNOWN", description: "COFFEE SHOP", category_id: null as number | null }],
    [rule({ pattern: "coffee", category_id: 5 })],
  );
  expect(out[0]!.category_id).toBe(5);
});
