import type {
  Category, CategoryRule, Expense, ExpenseInput, FixedCost, IncomeStream, LumpyItem, SavingsGoal,
} from "@lumpy/contracts";
import { insert, rows, sql, update, type Executor } from "@lumpy/db";
import { applyRules, dedupeKey } from "@lumpy/csv-import";
import * as core from "@lumpy/budget-core";

export const streams = () => rows<IncomeStream>("income_streams");
export const fixedCosts = () => rows<FixedCost>("fixed_costs");
export const lumpyItems = () => rows<LumpyItem>("lumpy_items");
export const savingsGoals = () => rows<SavingsGoal>("savings_goals");
export const categories = () => rows<Category>("categories");
export const categoryRules = () => rows<CategoryRule>("category_rules");

export const expensesBetween = (start: string, end: string) =>
  rows<Expense>("expenses", "txn_date BETWEEN ? AND ?", [start, end]);

export async function setting(name: string, fallback = "0"): Promise<string> {
  const out = (await sql.unsafe("SELECT value FROM settings WHERE name = ?", [name])) as { value: string }[];
  return out[0]?.value ?? fallback;
}

export async function setSetting(name: string, value: string): Promise<void> {
  await sql.unsafe("INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [name, value]);
}

/** Everything monthSummary needs, in one round trip's worth of queries. */
export async function budgetInputs(month: string, lumpyMode: "steady" | "recommended") {
  const [s, f, l, g, c, opening] = await Promise.all([
    streams(), fixedCosts(), lumpyItems(), savingsGoals(), categories(),
    setting("lumpy_opening_balance_cents", "0"),
  ]);
  const expenses = await expensesBetween(core.monthStart(month), core.monthEnd(month));
  return {
    streams: s, fixedCosts: f, lumpyItems: l, savingsGoals: g, categories: c, expenses, month, lumpyMode,
    lumpyOpeningBalanceCents: Number(opening) || 0,
  };
}

export const hash = (key: string): string => new Bun.CryptoHasher("sha256").update(key).digest("hex");

export type ImportResult = { batch_id: number; row_count: number; inserted: number; skipped: number };

/**
 * Imports in one transaction: rules applied first, then INSERT IGNORE against the
 * unique dedupe hash so re-importing an overlapping statement inserts nothing.
 */
export async function importExpenses(args: {
  filename: string;
  profile_id: number | null;
  rows: ExpenseInput[];
}): Promise<ImportResult> {
  const rules = await categoryRules();
  const categorized = applyRules(
    args.rows.map((r) => ({ ...r, description: r.description ?? "" })),
    rules,
  );

  return sql.begin(async (tx: Executor) => {
    const batchId = await insert(
      "import_batches",
      { filename: args.filename, profile_id: args.profile_id, row_count: categorized.length, inserted: 0, skipped: 0 },
      tx,
    );

    let inserted = 0;
    for (let i = 0; i < categorized.length; i += 200) {
      const chunk = categorized.slice(i, i + 200);
      const values = chunk
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?)")
        .join(", ");
      const params = chunk.flatMap((r) => [
        r.txn_date, r.amount_cents, r.merchant, r.description ?? "",
        r.category_id, r.source ?? "import", batchId, hash(dedupeKey(r)),
      ]);
      const res = (await tx.unsafe(
        `INSERT IGNORE INTO expenses
           (txn_date, amount_cents, merchant, description, category_id, source, import_batch_id, dedupe_hash)
         VALUES ${values}`,
        params,
      )) as unknown as { affectedRows: number };
      inserted += Number(res.affectedRows ?? 0);
    }

    const skipped = categorized.length - inserted;
    await tx.unsafe("UPDATE import_batches SET inserted = ?, skipped = ? WHERE id = ?", [inserted, skipped, batchId]);
    return { batch_id: batchId, row_count: categorized.length, inserted, skipped };
  });
}

/** A single manual expense still gets a dedupe hash, so it cannot be double-entered. */
export async function insertExpense(e: ExpenseInput): Promise<number> {
  return insert("expenses", { ...e, dedupe_hash: hash(dedupeKey(e)) });
}

/**
 * An edit rewrites the hash, because the hash covers date, amount and merchant
 * and all three are editable. Leaving it stale would let an edit produce the
 * duplicate the unique index exists to prevent, and would make the statement
 * that row came from re-import as a no-op even though the row no longer matches
 * it. A collision surfaces as errno 1062, which the API already reads as a 409.
 */
export async function updateExpense(id: number, e: ExpenseInput): Promise<number> {
  return update("expenses", id, { ...e, dedupe_hash: hash(dedupeKey(e)) });
}
