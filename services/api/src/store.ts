import type {
  Absorption, BackupTables, Category, CategoryRule, Expense, ExpenseInput, ExpenseSplitInput, FixedCost,
  IncomeStream, CategoryRuleInput, CategoryRuleMergeInput, ImportProfile, ImportProfileInput, LumpyItem,
  MergeResult, RestoreResult, RuleMergeResult, SavingsGoal,
} from "@lumpy/contracts";
import { bulkInsert, byId, insert, rows, sql, update, type Executor } from "@lumpy/db";
import { applyRules, dedupeKey, dedupeKeys, matchable, splitDedupeKey } from "@lumpy/csv-import";
import * as core from "@lumpy/budget-core";

export const streams = () => rows<IncomeStream>("income_streams");
export const fixedCosts = () => rows<FixedCost>("fixed_costs");
export const lumpyItems = () => rows<LumpyItem>("lumpy_items");
export const savingsGoals = () => rows<SavingsGoal>("savings_goals");
export const categories = () => rows<Category>("categories");
export const categoryRules = () => rows<CategoryRule>("category_rules");

/**
 * A charge that has been split is not a row anybody should be shown: its parts
 * are, and counting both would count the money twice.
 *
 * Asked of the rows rather than cached in a boolean, so it cannot fall out of
 * step with them. The subquery is against the same table the outer SELECT reads,
 * which `rows()` names `expenses`, and `idx_expenses_parent` is what makes it
 * free at this size.
 */
export const NOT_SPLIT_PARENT = "NOT EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = expenses.id)";

export const expensesBetween = (start: string, end: string) =>
  rows<Expense>("expenses", `txn_date BETWEEN ? AND ? AND ${NOT_SPLIT_PARENT}`, [start, end]);

/**
 * A row a statement row is allowed to absorb: typed by hand, and not a part of
 * a split.
 *
 * A split charge itself qualifies, although every other read hides it. It is
 * the one row that can be what the bank posts -- the bank charged $180, not $120
 * and $60 -- and if it could not be merged, a charge typed in and split before
 * its statement arrived would land a second time beside its own parts.
 *
 * A part never qualifies, for the mirror reason: it is a share of a charge the
 * bank posted whole, so a statement row that matches its amount is some other
 * charge. Merging one would rewrite the part into that charge and leave the
 * split no longer adding up.
 *
 * One string, read by both halves: `mergeCandidates` proposes with it and
 * `absorbManual` re-checks with it, so the wizard can never be offered a pair
 * the server would refuse, or refused one it was offered.
 */
const MERGE_TARGET = "source = 'manual' AND parent_id IS NULL";

/**
 * What the import wizard pairs statement rows against.
 *
 * Its own read rather than a flag on the `/expenses` list: that list is what
 * every page totals, and a parameter that puts a split charge back beside its
 * parts is the double count this whole feature exists to prevent, one query
 * string away. This read answers a narrower question and cannot be totalled by
 * accident.
 *
 * ponytail: no limit. It is hand-typed rows inside one statement's dates plus
 * the match window, which is tens of rows, not thousands.
 */
export const mergeCandidates = (start: string, end: string) =>
  rows<Expense>("expenses", `txn_date BETWEEN ? AND ? AND ${MERGE_TARGET}`, [start, end]);

/**
 * Import batches whose format is not the checking account -- a credit card.
 *
 * The cash position is the only reader. A card purchase is spending on the day it
 * happens, which is what every other number in the app wants, and it is not money
 * out of checking until the card is paid, which is what the balance tile wants.
 * One boolean on the format the statement was imported under is the whole
 * distinction; a manual row has no batch and counts, because a row typed by hand
 * is a row that came off the account being tracked.
 */
export async function nonCashBatchIds(): Promise<Set<number>> {
  const out = (await sql.unsafe(
    `SELECT b.id FROM import_batches b
       JOIN import_profiles p ON p.id = b.profile_id
      WHERE p.cash_account = FALSE`,
  )) as { id: number }[];
  return new Set(out.map((r) => Number(r.id)));
}

export async function setting(name: string, fallback = "0"): Promise<string> {
  const out = (await sql.unsafe("SELECT value FROM settings WHERE name = ?", [name])) as { value: string }[];
  return out[0]?.value ?? fallback;
}

/**
 * A setting plus when it was last actually changed.
 *
 * `updated_on` is computed by the database rather than sliced off the ISO string:
 * a TIMESTAMP set at 8pm local is already the next day in UTC, and comparing that
 * against a DATE column would silently drop a whole day of spending. DATE() reads
 * it on the same clock the DATE columns were written with.
 */
export async function settingRow(name: string): Promise<{ value: string; updated_at: string; updated_on: string } | null> {
  const out = (await sql.unsafe(
    "SELECT value, updated_at, DATE_FORMAT(DATE(updated_at), '%Y-%m-%d') AS updated_on FROM settings WHERE name = ?",
    [name],
  )) as { value: string; updated_at: Date | string; updated_on: string }[];
  const row = out[0];
  if (!row) return null;
  return {
    value: row.value,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updated_on: row.updated_on,
  };
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

export type ImportResult = {
  batch_id: number;
  row_count: number;
  /** Rows this batch now owns, merges included. */
  inserted: number;
  /** How many of `inserted` were rows somebody had already typed in. */
  absorbed: number;
  skipped: number;
};

/**
 * Rewrites hand-entered rows to be the statement rows they turned out to be.
 *
 * A person types "Corner Coffee" on the day they spend it; the bank writes
 * "SQ *CORNER COFFEE 4821" and posts it a day later. Date, merchant and
 * therefore `dedupeKey` all disagree, so the import inserts a second row and
 * the month is counted twice. `matchManual` proposes these pairs on the amount
 * alone and a person confirms them; nothing here infers anything.
 *
 * The row keeps its id and the category somebody chose by hand, and takes the
 * statement's date, merchant, description and batch. The hash it takes is the
 * one a plain import would have written for that row, which is the whole point:
 * next month's overlapping statement is a no-op again, with nothing to
 * re-confirm.
 *
 * The batch owns the row afterwards, so deleting the import deletes it. That is
 * deliberate. `nonCashBatchIds` reads the batch to tell a card charge from money
 * out of checking, and a merged card charge left batchless would be counted
 * against the checking balance every month from then on -- silently, and in the
 * one report that exists to be trusted.
 *
 * A pair naming a row that is gone, one that is not hand-entered, one that is a
 * part of a split, or one the two dates and amounts do not actually allow is
 * dropped, and its statement row inserts normally. Dropping the row instead would short a transaction the bank
 * really charged, which is the only outcome here that cannot be noticed later.
 *
 * `matchable` is re-asked here rather than taken on trust. The wizard proposes
 * with it and a person confirms, but what arrives is a request, and a request
 * that merged two unrelated rows would delete one of them with nothing left to
 * say it happened. `MERGE_TARGET` is re-asked for the same reason: a part of a
 * split is refused however the request names it.
 *
 * A charge typed in and split before its statement arrived merges like any
 * other, and its parts come along: they take the statement's date, merchant,
 * source and batch, and keep their own amounts, categories, notes and hashes.
 * The batch is the part that matters. The parts are what every read counts, so
 * they are what `nonCashBatchIds` has to recognise as a card charge, and what
 * deleting the import has to take. Their hashes are `splitDedupeKey(parent, i)`,
 * which does not depend on the date or merchant that just changed, so they stay
 * unique and a re-import of this file still collides with the parent alone.
 *
 * ponytail: one UPDATE per pair. A month of statements produces a handful, and
 * batching them into a CASE expression would trade a readable statement for
 * round trips nobody is waiting on.
 */
async function absorbManual(
  pairs: Absorption[],
  rows: (ExpenseInput & { description: string })[],
  keys: string[],
  batchId: number,
  tx: Executor,
): Promise<Set<number>> {
  const merged = new Set<number>();
  if (pairs.length === 0) return merged;

  // One typed row absorbs one statement row and the reverse; a request saying
  // otherwise keeps the first of each and drops the rest.
  const takenManual = new Set<number>();
  const wanted: Absorption[] = [];
  for (const p of pairs) {
    if (p.row_index >= rows.length || takenManual.has(p.manual_id) || merged.has(p.row_index)) continue;
    takenManual.add(p.manual_id);
    merged.add(p.row_index);
    wanted.push(p);
  }
  if (wanted.length === 0) return merged;

  const ids = wanted.map((p) => p.manual_id);
  const found = (await tx.unsafe(
    // DATE_FORMAT because this is a raw statement: `rows()` coerces a DATE to a
    // string and nothing here goes through it, so the column would arrive as a
    // Date and `matchable` would slice a string off an object.
    `SELECT id, DATE_FORMAT(txn_date, '%Y-%m-%d') AS txn_date, amount_cents, description
       FROM expenses
      WHERE ${MERGE_TARGET} AND id IN (${ids.map(() => "?").join(", ")})`,
    ids,
  )) as { id: number; txn_date: string; amount_cents: number; description: string }[];
  const mine = new Map(found.map((r) => [r.id, r]));

  for (const p of wanted) {
    const typed = mine.get(p.manual_id);
    const r = rows[p.row_index]!;
    if (!typed || !matchable(typed, r)) {
      merged.delete(p.row_index);
      continue;
    }
    await tx.unsafe(
      `UPDATE expenses
          SET txn_date = ?, amount_cents = ?, merchant = ?, description = ?, source = ?,
              import_batch_id = ?, dedupe_hash = ?, category_id = COALESCE(category_id, ?)
        WHERE id = ? AND ${MERGE_TARGET}`,
      // Everything the person put there wins over a blank on the statement, the
      // same way COALESCE keeps the category they chose. A statement's memo
      // column is usually empty, and "flat white, met Sam" is not recoverable.
      [r.txn_date, r.amount_cents, r.merchant, r.description || typed.description, r.source ?? "import",
       batchId, hash(keys[p.row_index]!), r.category_id, p.manual_id],
    );
    // Its parts, if it was split; a no-op for the charges that were not. Only
    // what describes the charge moves: each part's amount, category and note
    // are the split somebody made, and its hash is which part it is.
    await tx.unsafe(
      "UPDATE expenses SET txn_date = ?, merchant = ?, source = ?, import_batch_id = ? WHERE parent_id = ?",
      [r.txn_date, r.merchant, r.source ?? "import", batchId, p.manual_id],
    );
  }
  return merged;
}

/**
 * Imports in one transaction: rules applied first, then INSERT IGNORE against the
 * unique dedupe hash so re-importing an overlapping statement inserts nothing.
 */
export async function importExpenses(args: {
  filename: string;
  profile_id: number | null;
  rows: ExpenseInput[];
  absorb?: Absorption[];
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

    // Numbered across the whole file before it is chunked, so a charge listed
    // twice gets two identities and both rows land. The indices depend on the
    // file's own order, so re-importing the same statement produces the same
    // hashes and is still a no-op.
    const keys = dedupeKeys(categorized);

    // Confirmed merges first: they rewrite existing rows to hold the very hashes
    // the INSERT below would have used, so those rows must be out of it. Both
    // halves run in one transaction, or a failed insert would leave a typed row
    // already rewritten to a statement it is no longer part of.
    const merged = await absorbManual(args.absorb ?? [], categorized, keys, batchId, tx);
    const fresh = categorized
      .map((r, i) => ({ r, key: keys[i]! }))
      .filter((_, i) => !merged.has(i));

    let inserted = 0;
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200);
      const values = chunk
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?)")
        .join(", ");
      const params = chunk.flatMap(({ r, key }) => [
        r.txn_date, r.amount_cents, r.merchant, r.description ?? "",
        r.category_id, r.source ?? "import", batchId, hash(key),
      ]);
      const res = (await tx.unsafe(
        `INSERT IGNORE INTO expenses
           (txn_date, amount_cents, merchant, description, category_id, source, import_batch_id, dedupe_hash)
         VALUES ${values}`,
        params,
      )) as unknown as { affectedRows: number };
      inserted += Number(res.affectedRows ?? 0);
    }

    const absorbed = merged.size;
    const owned = inserted + absorbed;
    const skipped = categorized.length - owned;
    await tx.unsafe("UPDATE import_batches SET inserted = ?, skipped = ? WHERE id = ?", [owned, skipped, batchId]);
    return { batch_id: batchId, row_count: categorized.length, inserted: owned, absorbed, skipped };
  });
}

/**
 * How many identical transactions one day is allowed to hold. Four hundred is
 * not a limit anybody reaches; it is there so a bug cannot turn this into an
 * unbounded scan.
 */
const MAX_OCCURRENCES = 400;

/**
 * The hash for a hand-entered row: the first occurrence index this database does
 * not already hold.
 *
 * The unique index exists so a re-imported statement inserts nothing, not so a
 * person is forbidden from recording two identical coffees. Typing the second one
 * is a deliberate act, and refusing it undercounts real spending -- which is the
 * one number the whole app is protecting. So a manual row takes the next free
 * index instead of colliding.
 *
 * `excludeId` is the row being edited: its own hash is not a duplicate of itself,
 * and an edit that changes nothing must not renumber it.
 *
 * ponytail: one round trip, then a scan of the candidates in memory. Two writers
 * racing for the same index would still collide, and the unique index would say
 * so as a 409 -- which is the right answer for an app with one user on localhost.
 */
async function freeHash(
  e: Pick<ExpenseInput, "txn_date" | "amount_cents" | "merchant">,
  excludeId?: number,
): Promise<string> {
  const candidates = Array.from({ length: MAX_OCCURRENCES }, (_, i) => hash(dedupeKey(e, i)));
  const params: unknown[] = [...candidates];
  let where = `dedupe_hash IN (${candidates.map(() => "?").join(", ")})`;
  if (excludeId !== undefined) {
    where += " AND id <> ?";
    params.push(excludeId);
  }
  const taken = (await sql.unsafe(`SELECT dedupe_hash FROM expenses WHERE ${where}`, params)) as {
    dedupe_hash: string;
  }[];
  const used = new Set(taken.map((r) => r.dedupe_hash));
  const free = candidates.find((h) => !used.has(h));
  if (free === undefined) throw new Error(`more than ${MAX_OCCURRENCES} identical transactions on ${e.txn_date}`);
  return free;
}

/** A single manual expense still gets a dedupe hash; see freeHash for which one. */
export async function insertExpense(e: ExpenseInput): Promise<number> {
  return insert("expenses", { ...e, dedupe_hash: await freeHash(e) });
}

/**
 * An edit rewrites the hash, because the hash covers date, amount and merchant
 * and all three are editable. Leaving it stale would let an edit produce the
 * duplicate the unique index exists to prevent, and would make the statement
 * that row came from re-import as a no-op even though the row no longer matches
 * it. A collision surfaces as errno 1062, which the API already reads as a 409.
 */
export async function updateExpense(id: number, e: ExpenseInput): Promise<number> {
  const existing = await byId<Expense>("expenses", id);
  // A part's identity is "which part of charge N", not date + amount + merchant.
  // Rehashing it on an edit would drop it into the key space a statement row can
  // produce, and a real charge of that size on that day would then be skipped as
  // a duplicate of it.
  if (existing && existing.parent_id !== null) return update("expenses", id, e);
  return update("expenses", id, { ...e, dedupe_hash: await freeHash(e, id) });
}

/**
 * One charge becomes its parts.
 *
 * The charge itself stays exactly where it is, keeping its id and its
 * `dedupe_hash` -- that is the whole reason the next overlapping statement is
 * still a no-op. It is simply never read again: `NOT_SPLIT_PARENT` filters it
 * out, so `breakdown`, `categoryPace`, `totalsByBucket`, the variance report and
 * the cash position see two ordinary rows and needed no change at all.
 *
 * Each part inherits the charge's date, merchant, source and `import_batch_id`.
 * The batch is not decoration: `nonCashBatchIds` reads it to tell a card charge
 * from money out of checking, and batchless parts would be counted against the
 * checking balance forever -- the same trap `absorbManual` documents.
 *
 * The parts must add to the charge, checked here and not in zod, which has never
 * seen the row. After that they are ordinary expenses: editable, deletable,
 * individually re-categorisable. Unsplitting restores the charge at the amount
 * the bank actually charged, whatever the parts were later re-apportioned to.
 */
export async function splitExpense(
  id: number,
  parts: ExpenseSplitInput["parts"],
): Promise<{ ok: true; rows: Expense[] } | { ok: false; status: 404 | 409 | 422; error: string }> {
  const parent = await byId<Expense>("expenses", id);
  if (!parent) return { ok: false, status: 404, error: "not found" };
  if (parent.parent_id !== null) return { ok: false, status: 409, error: "this is already part of a split charge" };

  const existing = (await sql.unsafe("SELECT id FROM expenses WHERE parent_id = ? LIMIT 1", [id])) as { id: number }[];
  if (existing.length > 0) return { ok: false, status: 409, error: "this charge is already split" };

  const total = parts.reduce((a, p) => a + p.amount_cents, 0);
  if (total !== parent.amount_cents) {
    return { ok: false, status: 422, error: `the parts add up to ${total}, and the charge is ${parent.amount_cents}` };
  }

  await sql.begin(async (tx: Executor) => {
    for (const [i, part] of parts.entries()) {
      await insert(
        "expenses",
        {
          txn_date: parent.txn_date,
          amount_cents: part.amount_cents,
          merchant: parent.merchant,
          description: part.description || parent.description,
          category_id: part.category_id,
          source: parent.source,
          import_batch_id: parent.import_batch_id,
          parent_id: parent.id,
          dedupe_hash: hash(splitDedupeKey(parent.id, i)),
        },
        tx,
      );
    }
  });

  return { ok: true, rows: await rows<Expense>("expenses", "parent_id = ?", [id]) };
}

/** Delete the parts and the charge is a charge again, at the amount the bank charged. */
export async function unsplitExpense(id: number): Promise<number> {
  const res = (await sql.unsafe("DELETE FROM expenses WHERE parent_id = ?", [id])) as unknown as {
    affectedRows: number;
  };
  return Number(res.affectedRows ?? 0);
}

/**
 * Parents first. Every foreign key in the schema points backwards along this
 * list, so inserting in this order never outruns the row it references and
 * deleting in the reverse order never orphans one. Neither direction has to
 * touch FOREIGN_KEY_CHECKS, which is a session variable and would be a lie to
 * set on a pooled connection.
 */
const RESTORE_ORDER = [
  "categories", "income_streams", "savings_goals", "import_profiles",
  "fixed_costs", "lumpy_items", "category_rules", "import_batches", "expenses",
] as const;

/**
 * Replace everything with the contents of a backup file, or replace nothing.
 *
 * DELETE rather than TRUNCATE on purpose: TRUNCATE is DDL, and MySQL commits the
 * open transaction the moment it sees one -- a failure half way through the
 * restore would then leave an empty database instead of the one you started
 * with. Rows keep their exported ids (see bulkInsert), so the file's foreign
 * keys stay valid without a remapping pass, and InnoDB lifts each AUTO_INCREMENT
 * counter past the ids it was handed, so the next manual entry still gets a free
 * one.
 *
 * `settings` is upserted rather than replaced: it is a key/value table shared
 * with future migrations, and its `updated_at` only moves when a value really
 * changes -- which is what the lumpy-drift window reads.
 */
export async function restore(tables: BackupTables): Promise<RestoreResult> {
  const restored: Record<string, number> = {};
  await sql.begin(async (tx: Executor) => {
    for (let i = RESTORE_ORDER.length - 1; i >= 0; i--) {
      await tx.unsafe(`DELETE FROM \`${RESTORE_ORDER[i]}\``);
    }
    for (const table of RESTORE_ORDER) {
      let incoming = tables[table] as unknown as Record<string, unknown>[];
      // A split child points at its parent, and `expenses` is exported
      // txn_date DESC, id DESC -- so the child comes out of the file first and
      // its foreign key would have nothing to point at yet. A child is always
      // created after its parent, so ascending id is parents-first, always.
      if (table === "expenses") incoming = [...incoming].sort((a, b) => Number(a.id) - Number(b.id));
      restored[table] = await bulkInsert(table, incoming, tx);
    }
    for (const s of tables.settings) {
      await tx.unsafe(
        "INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
        [s.name, s.value],
      );
    }
    restored.settings = tables.settings.length;
  });
  return { restored, total: Object.values(restored).reduce((a, b) => a + b, 0) };
}

/**
 * Import formats from a backup file, added to whatever is already here.
 *
 * The additive counterpart to restore(): nothing is deleted, and the incoming
 * ids are dropped rather than kept, because this lands in a database where id 1
 * is already some other profile. `name` is the identity instead -- it is the
 * column with the UNIQUE index and the thing you actually recognise in the
 * import wizard -- so a profile you already have has its mapping updated and
 * everything else is inserted fresh.
 *
 * Two rows with the same name in one file is a file that contradicts itself; the
 * unique index says so as a 409 and the transaction takes the whole merge back.
 */
export async function mergeImportProfiles(incoming: ImportProfileInput[]): Promise<MergeResult> {
  const byName = new Map(
    (await rows<ImportProfile>("import_profiles")).map((p) => [p.name, p.id]),
  );
  const added: string[] = [];
  const updated: string[] = [];
  await sql.begin(async (tx: Executor) => {
    for (const profile of incoming) {
      const existing = byName.get(profile.name);
      if (existing === undefined) {
        await insert("import_profiles", profile, tx);
        added.push(profile.name);
      } else {
        await update("import_profiles", existing, profile, tx);
        updated.push(profile.name);
      }
    }
  });
  return { added, updated };
}

/**
 * The same normalisation `applyRules` matches on. Two rules that reduce to the
 * same needle can never both fire -- the lower priority one always wins and the
 * other is dead weight -- so this is the engine's own notion of one rule, not a
 * convenience for the merge.
 */
const needle = (pattern: string): string => pattern.toLowerCase().trim();

/**
 * Categorization rules from a backup file, added to whatever is already here.
 *
 * Unlike an import format, a rule is not self-contained: it points at a category,
 * and the file's category ids mean nothing in this database. So the file's
 * categories come along purely as a lookup, id -> name, and each rule is
 * re-pointed at the local category wearing that name. A rule whose category is
 * not here is skipped and named in the result rather than failing the other
 * forty -- two households are allowed to keep different categories.
 *
 * Rules are matched on their needle, so re-merging a file after fixing a
 * priority updates the rule instead of laying a second, unreachable one beside
 * it. A file listing one needle twice collapses to its last entry, which is the
 * only one that could ever have fired anyway.
 */
export async function mergeCategoryRules(tables: CategoryRuleMergeInput["tables"]): Promise<RuleMergeResult> {
  const [localCats, localRules] = await Promise.all([categories(), categoryRules()]);
  const localCategoryByName = new Map(localCats.map((c) => [c.name.toLowerCase(), c.id]));
  const fileCategoryById = new Map(tables.categories.map((c) => [c.id, c.name]));
  const localRuleByNeedle = new Map(localRules.map((r) => [needle(r.pattern), r.id]));

  const added: string[] = [];
  const updated: string[] = [];
  const skipped: { pattern: string; category: string }[] = [];

  // Collapsed before anything is written, so a file naming one needle twice is
  // one rule here rather than a row plus an unreachable twin.
  const wanted = new Map<string, CategoryRuleInput>();
  for (const rule of tables.category_rules) wanted.set(needle(rule.pattern), rule);

  await sql.begin(async (tx: Executor) => {
    for (const [key, incoming] of wanted) {
      const categoryName = fileCategoryById.get(incoming.category_id);
      const category_id =
        categoryName === undefined ? undefined : localCategoryByName.get(categoryName.toLowerCase());
      if (category_id === undefined) {
        // `#12` when the file did not carry the category either: there is no name
        // to report, and the number is the only thing left to say.
        skipped.push({ pattern: incoming.pattern, category: categoryName ?? `#${incoming.category_id}` });
        continue;
      }

      const rule: CategoryRuleInput = { ...incoming, category_id };
      const existing = localRuleByNeedle.get(key);
      if (existing === undefined) {
        await insert("category_rules", rule, tx);
        added.push(rule.pattern);
      } else {
        await update("category_rules", existing, rule, tx);
        updated.push(rule.pattern);
      }
    }
  });

  return { added, updated, skipped };
}
