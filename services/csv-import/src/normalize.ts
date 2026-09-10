import { matchesPattern, merchantKey, needleOf, normalizeMerchant } from "@lumpy/contracts";
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

/**
 * Re-exported, not defined here: the detector that suggests lumpy items from an
 * imported statement groups by the same identity this hashes, and budget-core
 * cannot reach into a sibling package. See `normalizeMerchant` in contracts.
 */
export { normalizeMerchant } from "@lumpy/contracts";

/**
 * The identity of a transaction: same day, same amount, same merchant, and which
 * of those it is. The API hashes this and stores it unique, so re-importing an
 * overlapping statement inserts nothing.
 *
 * `occurrence` is the whole reason this takes a second argument. Two $6.50
 * coffees at one shop on one day are one identity and two real transactions, and
 * without the index the second was dropped as a duplicate and counted as
 * "skipped" -- a silent undercount of exactly the discretionary spending this app
 * exists to protect. The index is per statement, assigned by `dedupeKeys`, so a
 * file that lists a charge twice inserts it twice and re-importing that same file
 * is still a no-op, because the same rows get the same indices both times.
 *
 * Occurrence 0 produces the string it always produced, byte for byte, so every
 * hash already in the database stays the hash of the row it belongs to and no
 * rehash migration is needed.
 *
 * ponytail: identity is still date + amount + merchant, not a bank's own
 * transaction id, which most CSV exports do not carry. The known ceiling is a
 * statement split so that one file holds only the *second* of two identical
 * charges: it arrives as occurrence 0 and reads as already imported. Add the id
 * column to the identity the day a bank actually exports one.
 */
export const dedupeKey = (
  e: Pick<ExpenseInput, "txn_date" | "amount_cents" | "merchant">,
  occurrence = 0,
): string =>
  `${e.txn_date}|${e.amount_cents}|${normalizeMerchant(e.merchant)}${occurrence > 0 ? `|#${occurrence}` : ""}`;

/**
 * One key per row, numbering repeats in the order the file lists them. Kept
 * beside `dedupeKey` rather than in the API because it is the pure half: same
 * rows in, same keys out, and the API only hashes what comes back.
 */
export function dedupeKeys(rows: Pick<ExpenseInput, "txn_date" | "amount_cents" | "merchant">[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = dedupeKey(r);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return dedupeKey(r, n);
  });
}

/**
 * The identity of one part of a split charge, deliberately outside the key space
 * `dedupeKey` uses.
 *
 * A part carries the parent's date and merchant and some fraction of its amount,
 * so a part hashed the ordinary way would occupy a key a real statement row can
 * produce. Split a $180 Costco charge into $120 and $60, and a genuine $120
 * Costco charge on that same day would arrive as occurrence 0, find the hash
 * taken, and be dropped as a duplicate -- a silent undercount, which is the one
 * failure this app exists to prevent.
 *
 * `(parent, index)` is unique by construction, so unlike `freeHash` this needs no
 * round trip and cannot race. It is also stable, which is what lets a part be
 * edited without its identity moving: a part is "the second half of charge 41"
 * whatever it is later re-apportioned to.
 */
export const splitDedupeKey = (parentId: number, index: number): string => `split|${parentId}|#${index}`;

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

/**
 * The pattern that would catch this merchant next time, or null if a rule
 * already catches it. Setting a category by hand is the one moment both halves
 * of a rule are known, so the Expenses page offers to write it down; this is the
 * half that decides whether there is anything to offer.
 *
 * The needle runs to the merchant's second real word. Which tokens are real is
 * `merchantKey`'s question and it answers this one too, rather than a second
 * list of store numbers and joining words drifting away from the first: a token
 * it drops is noise, so WEGMANS #123 offers "wegmans" and TOWN OF PERINTON TAX
 * offers "town of perinton" rather than standing for every town in the county.
 *
 * Built from the raw merchant and not the normalized one, because a rule is
 * matched with `indexOf` against the string the statement actually wrote:
 * `merchantKey` folds SQ *COFFEE to SQ COFFEE, which does not occur in the row
 * it came from. So the head is checked against this very row before it is
 * offered, and the whole merchant is the fallback when it does not survive. A
 * pattern that matches nothing is worse than a long one.
 *
 * ponytail: two words, the same guess `merchantKey` makes, so CAPITAL ONE AUTO
 * offers "capital one" -- the car loan and the credit card both. Affordable for
 * the same reason: nothing is written until a person presses the button, with
 * the pattern printed on it, and Settings edits rules afterwards.
 */
export function suggestRule(
  row: { merchant: string; description: string },
  rules: CategoryRule[],
): string | null {
  const hay = `${row.merchant} ${row.description}`.toLowerCase();
  if (rules.some((r) => matchesPattern(hay, needleOf(r.pattern), r.whole_word))) return null;

  const tokens = needleOf(row.merchant).split(/\s+/);
  let words = 0;
  let end = 0;
  for (let i = 0; i < tokens.length && words < 2; i++) {
    if (merchantKey(tokens[i]!, 1) !== "") {
      words = words + 1;
      end = i + 1;
    }
  }
  const head = tokens.slice(0, end).join(" ");
  // Two characters is `categoryRuleInput`'s floor, and a one-character needle
  // matches nearly every merchant there is.
  const pattern = head.length >= 2 && matchesPattern(hay, head) ? head : needleOf(row.merchant);
  return pattern.length >= 2 ? pattern : null;
}
