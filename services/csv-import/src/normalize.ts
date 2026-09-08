import { matchesPattern, needleOf } from "@lumpy/contracts";
import type { CategoryRule, ExpenseInput, ImportMapping } from "@lumpy/contracts";
import type { ParsedCsv } from "./parse";
import { detectDateFormat, parseAmountCents, parseDate } from "./parse";

export type RowError = { row: number; field: string; value: string; message: string };
export type NormalizeResult = { rows: ExpenseInput[]; errors: RowError[] };

const pick = (row: Record<string, string>, col: string | null): string =>
  col ? (row[col] ?? "").trim() : "";

/** Guess a mapping from the headers, so the common case is zero clicks. */
export function guessMapping(csv: ParsedCsv): ImportMapping {
  // Needle order is priority order: the first needle that matches any header wins,
  // so "Transaction Date" beats "Post Date" no matter which column comes first.
  const find = (...needles: string[]): string | null => {
    const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");
    for (const n of needles) {
      const hit = csv.headers.find((h) => norm(h).includes(n));
      if (hit) return hit;
    }
    return null;
  };

  // A budget cares when the money was spent, not when the bank got around to posting it.
  const dateCol = find("transactiondate", "postdate", "date") ?? csv.headers[0] ?? "";
  const debit = find("debit", "withdrawal", "moneyout");
  const credit = find("credit", "deposit", "moneyin");
  const amount = find("amount") ?? (debit || credit ? null : find("value"));
  const merchant = find("description", "merchant", "payee", "name", "details") ?? csv.headers[1] ?? "";
  const secondary = csv.headers.find(
    (h) => h !== merchant && /memo|note|detail|category|type|extended/i.test(h),
  );

  const sample = csv.rows.slice(0, 200).map((r) => r[dateCol] ?? "");
  const amountSample = amount ? csv.rows.slice(0, 200).map((r) => r[amount] ?? "") : [];
  // Most banks write spending as a negative number; flip it so "spent" is positive.
  const mostlyNegative =
    amountSample.filter((v) => parseAmountCents(v) !== null && parseAmountCents(v)! < 0).length >
    amountSample.filter((v) => (parseAmountCents(v) ?? 0) > 0).length;

  return {
    date_column: dateCol,
    amount_column: amount && !(debit && credit) ? amount : null,
    debit_column: amount && !(debit && credit) ? null : debit,
    credit_column: amount && !(debit && credit) ? null : credit,
    merchant_column: merchant,
    description_column: secondary ?? null,
    date_format: detectDateFormat(sample),
    flip_sign: mostlyNegative,
    skip_rows: 0,
  };
}

/**
 * CSV rows in, expenses out, with every rejected row reported by line number.
 * Spending is stored positive; a refund is negative.
 */
export function normalize(csv: ParsedCsv, mapping: ImportMapping, source = "import"): NormalizeResult {
  const rows: ExpenseInput[] = [];
  const errors: RowError[] = [];

  csv.rows.forEach((raw, i) => {
    const line = i + 2 + mapping.skip_rows; // +1 for the header, +1 for 1-based lines
    const dateRaw = pick(raw, mapping.date_column);
    const txn_date = parseDate(dateRaw, mapping.date_format);
    if (!txn_date) {
      errors.push({ row: line, field: mapping.date_column, value: dateRaw, message: "unreadable date" });
      return;
    }

    let amount: number | null = null;
    if (mapping.amount_column) {
      amount = parseAmountCents(pick(raw, mapping.amount_column));
      if (amount === null) {
        errors.push({ row: line, field: mapping.amount_column, value: pick(raw, mapping.amount_column), message: "unreadable amount" });
        return;
      }
      if (mapping.flip_sign) amount = -amount;
    } else {
      const debit = parseAmountCents(pick(raw, mapping.debit_column));
      const credit = parseAmountCents(pick(raw, mapping.credit_column));
      if (debit === null && credit === null) {
        errors.push({ row: line, field: mapping.debit_column ?? mapping.credit_column ?? "amount", value: "", message: "no debit or credit amount" });
        return;
      }
      // Debit is money out (positive), credit is money in (negative).
      amount = Math.abs(debit ?? 0) - Math.abs(credit ?? 0);
    }

    const merchant = pick(raw, mapping.merchant_column) || "(no merchant)";
    rows.push({
      txn_date,
      amount_cents: amount,
      merchant: merchant.slice(0, 200),
      description: pick(raw, mapping.description_column).slice(0, 500),
      category_id: null,
      source,
    });
  });

  return { rows, errors };
}

/** Collapse the noise banks add so the same purchase always hashes the same. */
export const normalizeMerchant = (m: string): string =>
  (m ?? "").normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * The identity of a transaction: same day, same amount, same merchant. The API
 * hashes this and stores it unique, so re-importing an overlapping statement
 * inserts nothing.
 */
export const dedupeKey = (e: Pick<ExpenseInput, "txn_date" | "amount_cents" | "merchant">): string =>
  `${e.txn_date}|${e.amount_cents}|${normalizeMerchant(e.merchant)}`;

/**
 * First matching rule by priority wins. Rows that already have a category are
 * left alone.
 *
 * A rule with `whole_word` needs a non-letter on each side of the hit, so "bp"
 * finds BP #4021 and BP1234 and passes over BPOST. Without it a rule is the
 * plain substring it has always been.
 */
export function applyRules<T extends { merchant: string; description: string; category_id: number | null }>(
  rows: T[],
  rules: CategoryRule[],
): T[] {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
  const needles = ordered.map((r) => ({ rule: r, needle: needleOf(r.pattern) }));
  return rows.map((row) => {
    if (row.category_id !== null) return row;
    const hay = `${row.merchant} ${row.description}`.toLowerCase();
    const hit = needles.find(({ rule, needle }) => matchesPattern(hay, needle, rule.whole_word));
    return hit ? { ...row, category_id: hit.rule.category_id } : row;
  });
}
