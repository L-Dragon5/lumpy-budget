import { expect, test } from "bun:test";
import type { CategoryRule } from "@lumpy/contracts";
import { parseCsv } from "../src/parse";
import { applyRules, dedupeKey, dedupeKeys, guessMapping, normalize, normalizeMerchant } from "../src/normalize";

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

test("occurrence 0 is the key it has always been, so stored hashes stay valid", () => {
  const base = { txn_date: "2026-03-14", amount_cents: 8421, merchant: "WEGMANS #123" };
  expect(dedupeKey(base, 0)).toBe(dedupeKey(base));
  expect(dedupeKey(base, 0)).toBe("2026-03-14|8421|WEGMANS 123");
  expect(dedupeKey(base, 1)).not.toBe(dedupeKey(base));
});

test("a file listing one charge twice gets two identities, in file order", () => {
  const coffee = { txn_date: "2026-03-18", amount_cents: 650, merchant: "CORNER COFFEE #4" };
  const other = { txn_date: "2026-03-18", amount_cents: 1200, merchant: "CORNER COFFEE #4" };
  // Two $6.50 coffees at one shop on one day are one identity and two real
  // transactions. Without the index the second was dropped as a duplicate.
  const keys = dedupeKeys([coffee, other, coffee, coffee]);
  expect(new Set(keys).size).toBe(4);
  expect(keys[0]).toBe(dedupeKey(coffee));
  expect(keys[2]).toBe(dedupeKey(coffee, 1));
  expect(keys[3]).toBe(dedupeKey(coffee, 2));
  // The other amount is a different identity and starts its own count.
  expect(keys[1]).toBe(dedupeKey(other));

  // Same file in, same keys out: re-importing an overlapping statement is still
  // a no-op, which is the whole reason the hash is unique.
  expect(dedupeKeys([coffee, other, coffee, coffee])).toEqual(keys);
  // And the index is per identity, not per file position.
  expect(dedupeKeys([other, coffee])).toEqual([dedupeKey(other), dedupeKey(coffee)]);
});

const rule = (p: Partial<CategoryRule>): CategoryRule =>
  ({ id: 1, pattern: "x", whole_word: false, category_id: 1, priority: 100, ...p });

/** A row on its way through the importer, before any rule has looked at it. */
type Row = { merchant: string; description: string; category_id: number | null };
const row = (merchant: string): Row => ({ merchant, description: "", category_id: null });

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

test("a whole-word rule finds the name and not a longer name starting with it", () => {
  const rows = [
    row("BP #4021 FUEL"),
    row("BPOST BRUSSELS"),
    // A store number glued straight onto the name is what a descriptor does, so
    // the boundary is a letter boundary and a digit still counts as one.
    row("BP1234"),
    row("SHELL AND BP"),
    // The first occurrence is inside a longer word; the second is not.
    row("BPOST THEN BP"),
  ];
  const out = applyRules(rows, [rule({ id: 1, pattern: "bp", whole_word: true, category_id: 3 })]);
  expect(out.map((r) => r.category_id)).toEqual([3, null, 3, 3, 3]);
});

test("without the switch a rule is the substring it has always been", () => {
  const rows = [row("BPOST BRUSSELS")];
  expect(applyRules(rows, [rule({ pattern: "bp", category_id: 3 })])[0]!.category_id).toBe(3);
});

test("whole word does not cost a rule the suffixes it wants", () => {
  // "trader joe" has to keep finding TRADER JOES, which is why this is opt-in
  // rather than how every rule now behaves.
  const rows = [row("TRADER JOES #44"), row("TRADER JOE'S #44")];
  const plain = applyRules(rows, [rule({ pattern: "trader joe", category_id: 5 })]);
  expect(plain.map((r) => r.category_id)).toEqual([5, 5]);

  const strict = applyRules(rows, [rule({ pattern: "trader joe", whole_word: true, category_id: 5 })]);
  // An apostrophe is a boundary; a plain "s" is not. This is the trade the
  // switch makes, and the reason it is off unless you ask for it.
  expect(strict.map((r) => r.category_id)).toEqual([null, 5]);
});

test("a pattern full of regex metacharacters is matched as text", () => {
  const rows = [row("SQ *COFFEE"), row("SQXCOFFEE")];
  const out = applyRules(rows, [rule({ pattern: "sq *coffee", whole_word: true, category_id: 9 })]);
  expect(out.map((r) => r.category_id)).toEqual([9, null]);
});
