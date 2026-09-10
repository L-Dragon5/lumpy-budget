# Transaction Splits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one charge be two categories -- half the Costco run is groceries
and half is household -- without breaking the dedupe hash, the re-import no-op,
or any report that reads the expenses table.

**Architecture:** A split keeps the imported row exactly where it is. It gains
children, each an ordinary expense carrying `parent_id`, and the parent is
filtered out of every expense read. So every consumer -- `breakdown`,
`categoryPace`, `totalsByBucket`, `fixedCostVariance`, the cash position --
sees two ordinary rows and needs no change at all. The parent keeps its id and
its `dedupe_hash`, which is the only reason re-importing that statement is still
a no-op.

**One deliberate deviation from the approved sketch:** there is no `split`
boolean. A parent is a row that has children, asked as
`NOT EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = expenses.id)`. One
column instead of two, and an invariant that cannot drift out of step with the
rows it describes.

**Tech Stack:** Bun, MySQL/MariaDB, zod, Elysia, Eden treaty, React, Tailwind v4,
shadcn/ui.

**Spec:** `docs/superpowers/plans/2026-09-10-README.md` (shared constraints) and
the "A re-imported statement is a no-op" section of `README.md`.

## Global Constraints

- Money is always an integer number of cents. No floats, no `DECIMAL`.
- Dates are always `YYYY-MM-DD` strings. **A raw `tx.unsafe` SELECT does not go
  through `coerce()`**, so a hand-written statement must say
  `DATE_FORMAT(col,'%Y-%m-%d')` itself. Five tests caught this in `absorbManual`.
- Query params use `.optional()`, never `.default()`.
- Validation failures are 422 in Elysia's shape, not 400. 409 for a duplicate or
  a row something else still references.
- A column lives in four places in order: migration, `services/db/src/tables.ts`,
  `contracts/types.ts`, scenario expectations.
- Migrations are forward-only. **This plan owns 014 and no other number.**
- `bun run check` must be green at every commit. Never `--no-verify`.
- `bun test` needs MySQL running.

---

## File Structure

- `services/db/migrations/014_expense_parent.sql` — **create.**
- `services/db/src/tables.ts:68` — **modify.** `parent_id` in `expenses.cols`.
- `contracts/types.ts` — **modify.** `parent_id` on the `expense` row schema
  (not on `expenseInput`: a split is its own route, never a field somebody sets),
  plus `expenseSplitInput`.
- `services/budget-core/fixtures/factories.ts:71-84` — **modify.** One default.
- `services/csv-import/src/normalize.ts` — **modify.** `splitDedupeKey`, beside
  `dedupeKey` whose key space it deliberately avoids.
- `services/api/src/store.ts` — **modify.** `NOT_SPLIT_PARENT`, `splitExpense`,
  `unsplitExpense`, the `updateExpense` guard, the `restore` ordering.
- `services/api/src/resources.ts` — **modify.** Two routes and the list filter.
- `apps/web/src/components/app/split-dialog.tsx` — **create.**
- `apps/web/src/components/app/record-dialog.tsx` — **modify.** One
  `submitDisabled` prop; `pending` means "a request is in flight" and must not be
  overloaded to mean "the parts do not add up".
- `apps/web/src/pages/Expenses.tsx` — **modify.** The action and the grouping.
- Tests: `services/api/test/api.test.ts`,
  `services/csv-import/test/normalize.test.ts`.

---

### Task 1: The column exists in all four places, and a backup survives it

**Files:**
- Create: `services/db/migrations/014_expense_parent.sql`
- Modify: `services/db/src/tables.ts:68-71`
- Modify: `contracts/types.ts` (the `expense` schema, around line 223)
- Modify: `services/budget-core/fixtures/factories.ts:71-84`
- Modify: `services/api/src/store.ts` (`restore`, around line 322)
- Test: `services/api/test/api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Expense` gains `parent_id: number | null`. `ExpenseInput` does not.

- [ ] **Step 1: Write the failing test**

Append to `services/api/test/api.test.ts`:

```ts
describe("split storage", () => {
  beforeEach(() => resetDb());

  test("an ordinary expense reports no parent", async () => {
    const e = await post("/api/expenses", {
      txn_date: "2026-03-02", amount_cents: 18000, merchant: "COSTCO",
      description: "", category_id: null, source: "manual",
    });
    expect(e.status).toBe(201);
    // Declared on the row schema, so a column missing from `tables.ts` fails
    // the response validator here rather than reaching the client as undefined.
    expect(e.body.parent_id).toBeNull();
  });

  test("a backup restores a child after the parent it points at", async () => {
    const parent = await post("/api/expenses", {
      txn_date: "2026-03-02", amount_cents: 18000, merchant: "COSTCO",
      description: "", category_id: null, source: "manual",
    });
    // Written straight to the table: the split route does not exist until
    // Task 3, and this test is about the restore ordering, not about splitting.
    await sql.unsafe(
      `INSERT INTO expenses (txn_date, amount_cents, merchant, description, category_id, source, parent_id, dedupe_hash)
       VALUES ('2026-03-02', 12000, 'COSTCO', '', NULL, 'manual', ?, 'child-hash-1')`,
      [parent.body.id],
    );

    const file = (await api("/api/export")).body;
    // The export is ordered txn_date DESC, id DESC, so the child comes out
    // first and a naive restore would insert it before its parent exists.
    const restored = await post("/api/restore", file);
    expect(restored.status).toBe(200);
    expect(restored.body.restored.expenses).toBe(2);

    const back = (await api("/api/expenses")).body;
    expect(back.find((e: { dedupe_hash: string }) => e.dedupe_hash === "child-hash-1").parent_id)
      .toBe(parent.body.id);
  });
});
```

Import `sql` from `./setup` if that file does not already re-export it; the
existing suite imports it there.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test services/api -t "split storage"`
Expected: FAIL — `parent_id` is undefined, and the raw INSERT errors on an
unknown column.

- [ ] **Step 3: Write the migration**

Create `services/db/migrations/014_expense_parent.sql`:

```sql
-- One charge, more than one category.
--
-- A Costco run is half groceries and half household, and until now the row could
-- only be one of them. A split keeps the imported row exactly where it is and
-- gives it children: ordinary expenses that carry `parent_id`. The parent is
-- filtered out of every expense read, so `breakdown`, `categoryPace`,
-- `totalsByBucket` and the variance report see two ordinary rows and needed no
-- change at all.
--
-- The parent is kept rather than deleted because it holds the `dedupe_hash`.
-- Delete it and the next overlapping statement re-inserts the charge whole,
-- beside the halves somebody already split it into, and the month is counted
-- twice. Keeping it is the entire reason a re-import is still a no-op.
--
-- There is no `split` boolean. "Has children" is the question, and asking the
-- rows directly is one column instead of two and an invariant that cannot drift.
--
-- ON DELETE CASCADE, so deleting the charge deletes its parts, and deleting the
-- import batch still takes everything that came in with it. The self-reference
-- is why `restore()` inserts expenses in ascending id order: a child is always
-- created after its parent, so ascending id is parents-first.

ALTER TABLE expenses
  ADD COLUMN parent_id INT UNSIGNED NULL,
  ADD KEY idx_expenses_parent (parent_id),
  ADD CONSTRAINT fk_expense_parent FOREIGN KEY (parent_id) REFERENCES expenses(id) ON DELETE CASCADE;
```

- [ ] **Step 4: Add it to the table spec**

In `services/db/src/tables.ts`, in the `expenses` entry, add `"parent_id"` to
`cols` after `"import_batch_id"`:

```ts
  expenses: {
    cols: ["id", "txn_date", "amount_cents", "merchant", "description", "category_id", "source", "import_batch_id", "parent_id", "dedupe_hash"],
    date: ["txn_date"],
    order: "txn_date DESC, id DESC",
  },
```

- [ ] **Step 5: Add it to the contract**

In `contracts/types.ts`, replace the `expense` row schema:

```ts
export const expense = z
  .object({ id, import_batch_id: id.nullable().default(null), dedupe_hash: z.string() })
  .and(expenseInput);
```

with:

```ts
export const expense = z
  .object({
    id,
    import_batch_id: id.nullable().default(null),
    /**
     * The charge this row is one part of, or null.
     *
     * On the row schema and deliberately not on `expenseInput`: a split is its
     * own route, because it has to write every part in one transaction and check
     * that they add up. A field anybody could set would let half a split exist.
     */
    parent_id: id.nullable().default(null),
    dedupe_hash: z.string(),
  })
  .and(expenseInput);
```

- [ ] **Step 6: Give the fixture factory a default**

In `services/budget-core/fixtures/factories.ts`, in `expense()`, add after
`import_batch_id: null,`:

```ts
    parent_id: null,
```

The JSON household fixtures are parsed and cast, so they need no edit; this
factory declares `Expense` explicitly and would fail the typecheck without it.

- [ ] **Step 7: Order the restore parents-first**

In `services/api/src/store.ts`, inside `restore()`, replace:

```ts
    for (const table of RESTORE_ORDER) {
      restored[table] = await bulkInsert(table, tables[table] as unknown as Record<string, unknown>[], tx);
    }
```

with:

```ts
    for (const table of RESTORE_ORDER) {
      let incoming = tables[table] as unknown as Record<string, unknown>[];
      // A split child points at its parent, and `expenses` is exported
      // txn_date DESC, id DESC -- so the child comes out of the file first and
      // its foreign key would have nothing to point at yet. A child is always
      // created after its parent, so ascending id is parents-first, always.
      if (table === "expenses") incoming = [...incoming].sort((a, b) => Number(a.id) - Number(b.id));
      restored[table] = await bulkInsert(table, incoming, tx);
    }
```

- [ ] **Step 8: Migrate and run**

```bash
bun run migrate
bun run check
```
Expected: PASS, both new tests included. `bun run scenarios` is unaffected: the
engine never reads `parent_id`.

- [ ] **Step 9: Commit**

```bash
git add services/db/migrations/014_expense_parent.sql services/db/src/tables.ts \
        contracts/types.ts services/budget-core/fixtures/factories.ts \
        services/api/src/store.ts services/api/test/api.test.ts
git commit -m "A charge can be told which charge it is part of"
```

---

### Task 2: A split child's identity is not a transaction's identity

**Files:**
- Modify: `services/csv-import/src/normalize.ts` (after `dedupeKeys`, around
  line 155)
- Test: `services/csv-import/test/normalize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const splitDedupeKey = (parentId: number, index: number): string`.

- [ ] **Step 1: Write the failing test**

Append to `services/csv-import/test/normalize.test.ts`:

```ts
describe("splitDedupeKey", () => {
  test("cannot collide with a key any statement row could produce", () => {
    const key = splitDedupeKey(41, 0);
    // dedupeKey is `date|amount|MERCHANT` with an optional `|#n`. A key that
    // starts with a word no date can start with is in a space of its own, so a
    // real $120 COSTCO charge on the same day as a $120 split part can never be
    // dropped as a duplicate of it.
    expect(key.startsWith("split|")).toBe(true);
    expect(key).not.toContain("|20");
  });

  test("is one key per part of one charge", () => {
    expect(splitDedupeKey(41, 0)).not.toBe(splitDedupeKey(41, 1));
    expect(splitDedupeKey(41, 0)).not.toBe(splitDedupeKey(42, 0));
    expect(splitDedupeKey(41, 0)).toBe(splitDedupeKey(41, 0));
  });
});
```

Add `splitDedupeKey` to that file's import from `../src/normalize`.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test services/csv-import -t splitDedupeKey`
Expected: FAIL — `splitDedupeKey is not a function`.

- [ ] **Step 3: Write it**

In `services/csv-import/src/normalize.ts`, directly after `dedupeKeys`, add:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `bun test services/csv-import`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/csv-import/src/normalize.ts services/csv-import/test/normalize.test.ts
git commit -m "A half of a charge is not a charge that size"
```

---

### Task 3: Split, unsplit, and disappear the parent from every read

**Files:**
- Modify: `services/api/src/store.ts` (`expensesBetween` line 17, `updateExpense`
  around line 305, plus the new functions)
- Modify: `services/api/src/resources.ts:26-66`
- Modify: `contracts/types.ts` (`expenseSplitInput`)
- Test: `services/api/test/api.test.ts`

**Interfaces:**
- Consumes: `splitDedupeKey` from `@lumpy/csv-import`, `Expense` with
  `parent_id` from Task 1.
- Produces:
  ```ts
  // contracts/types.ts
  export const expenseSplitInput: z.ZodType<{ parts: { amount_cents: number; category_id: number | null; description: string }[] }>;
  // services/api/src/store.ts
  export const NOT_SPLIT_PARENT: string;
  export function splitExpense(id: number, parts: ExpenseSplitInput["parts"]): Promise<Expense[] | { error: string; status: 404 | 409 | 422 }>;
  export function unsplitExpense(id: number): Promise<number>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `services/api/test/api.test.ts`:

```ts
describe("splitting a charge", () => {
  beforeEach(() => resetDb());

  const costco = {
    txn_date: "2026-03-02", amount_cents: 18000, merchant: "COSTCO",
    description: "big run", category_id: null, source: "manual" as const,
  };

  test("two parts replace the charge in every read", async () => {
    const groceries = await post("/api/categories", { name: "Groceries", bucket: "discretionary", icon: "cart", color: null });
    const home = await post("/api/categories", { name: "Home", bucket: "discretionary", icon: "home", color: null });
    const parent = await post("/api/expenses", costco);

    const split = await post(`/api/expenses/${parent.body.id}/split`, {
      parts: [
        { amount_cents: 12000, category_id: groceries.body.id, description: "" },
        { amount_cents: 6000, category_id: home.body.id, description: "shelving" },
      ],
    });
    expect(split.status).toBe(201);
    expect(split.body).toHaveLength(2);

    const listed = (await api("/api/expenses")).body;
    // The parent is gone from the list and the two parts are there instead, so
    // the total is $180 once rather than $180 twice.
    expect(listed).toHaveLength(2);
    expect(listed.map((e: { amount_cents: number }) => e.amount_cents).sort()).toEqual([6000, 12000]);
    expect(listed.every((e: { parent_id: number }) => e.parent_id === parent.body.id)).toBe(true);

    // And every derived report agrees, because they all read expensesBetween.
    const reports = (await api("/api/reports?start=2026-03-01&end=2026-03-31")).body;
    expect(reports.totals.total).toBe(18000);
    expect(reports.breakdown.slices.map((s: { name: string }) => s.name).sort()).toEqual(["Groceries", "Home"]);
  });

  test("a part inherits the batch, so a card charge is still a card charge", async () => {
    const mapping = {
      date_column: "Date", amount_column: "Amount", debit_column: null, credit_column: null,
      merchant_column: "Description", description_column: null, date_format: "auto" as const,
      flip_sign: false, skip_rows: 0,
    };
    const card = await post("/api/import-profiles", { name: "Card", mapping, cash_account: false });
    await post("/api/import", {
      filename: "card.csv", profile_id: card.body.id,
      rows: [{ ...costco, source: "import" }],
    });
    const imported = (await api("/api/expenses")).body[0];

    await post(`/api/expenses/${imported.id}/split`, {
      parts: [
        { amount_cents: 12000, category_id: null, description: "" },
        { amount_cents: 6000, category_id: null, description: "" },
      ],
    });
    const parts = (await api("/api/expenses")).body;
    // Batchless parts would be counted as money out of checking forever, in the
    // one report that exists to be trusted.
    expect(parts.every((e: { import_batch_id: number | null }) => e.import_batch_id === imported.import_batch_id)).toBe(true);
  });

  test("parts that do not add up are a 422 naming both numbers", async () => {
    const parent = await post("/api/expenses", costco);
    const bad = await post(`/api/expenses/${parent.body.id}/split`, {
      parts: [
        { amount_cents: 12000, category_id: null, description: "" },
        { amount_cents: 5000, category_id: null, description: "" },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toContain("17000");
    expect(bad.body.error).toContain("18000");
    expect((await api("/api/expenses")).body).toHaveLength(1);
  });

  test("splitting a charge twice is a 409, and so is splitting a part", async () => {
    const parent = await post("/api/expenses", costco);
    const parts = [
      { amount_cents: 12000, category_id: null, description: "" },
      { amount_cents: 6000, category_id: null, description: "" },
    ];
    await post(`/api/expenses/${parent.body.id}/split`, { parts });
    expect((await post(`/api/expenses/${parent.body.id}/split`, { parts })).status).toBe(409);

    const child = (await api("/api/expenses")).body[0];
    expect((await post(`/api/expenses/${child.id}/split`, {
      parts: [
        { amount_cents: 6000, category_id: null, description: "" },
        { amount_cents: 6000, category_id: null, description: "" },
      ],
    })).status).toBe(409);
  });

  test("unsplitting brings the charge back whole", async () => {
    const parent = await post("/api/expenses", costco);
    await post(`/api/expenses/${parent.body.id}/split`, {
      parts: [
        { amount_cents: 12000, category_id: null, description: "" },
        { amount_cents: 6000, category_id: null, description: "" },
      ],
    });
    expect((await del(`/api/expenses/${parent.body.id}/split`)).status).toBe(200);

    const listed = (await api("/api/expenses")).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: parent.body.id, amount_cents: 18000, description: "big run", parent_id: null,
    });
  });

  test("re-importing the statement is still a no-op after a split", async () => {
    // The whole reason the parent is kept rather than deleted: it holds the
    // hash. Without it the charge comes back whole beside its own halves.
    const rows = [{ ...costco, source: "import" as const }];
    await post("/api/import", { filename: "s.csv", profile_id: null, rows });
    const imported = (await api("/api/expenses")).body[0];
    await post(`/api/expenses/${imported.id}/split`, {
      parts: [
        { amount_cents: 12000, category_id: null, description: "" },
        { amount_cents: 6000, category_id: null, description: "" },
      ],
    });

    const again = await post("/api/import", { filename: "s.csv", profile_id: null, rows });
    expect(again.body.inserted).toBe(0);
    expect(again.body.skipped).toBe(1);
    expect((await api("/api/expenses")).body).toHaveLength(2);
  });

  test("deleting the charge deletes its parts", async () => {
    const parent = await post("/api/expenses", costco);
    await post(`/api/expenses/${parent.body.id}/split`, {
      parts: [
        { amount_cents: 12000, category_id: null, description: "" },
        { amount_cents: 6000, category_id: null, description: "" },
      ],
    });
    expect((await del(`/api/expenses/${parent.body.id}`)).status).toBe(200);
    expect((await api("/api/expenses")).body).toEqual([]);
  });

  test("editing a part keeps the identity that cannot collide with a statement", async () => {
    const parent = await post("/api/expenses", costco);
    await post(`/api/expenses/${parent.body.id}/split`, {
      parts: [
        { amount_cents: 12000, category_id: null, description: "" },
        { amount_cents: 6000, category_id: null, description: "" },
      ],
    });
    const child = (await api("/api/expenses")).body[0];
    const before = child.dedupe_hash;

    const edited = await put(`/api/expenses/${child.id}`, {
      txn_date: child.txn_date, amount_cents: 9000, merchant: child.merchant,
      description: "", category_id: null, source: child.source,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.amount_cents).toBe(9000);
    // A part's identity is "which part of charge N", not date+amount+merchant,
    // so re-apportioning it must not move it into the statement key space.
    expect(edited.body.dedupe_hash).toBe(before);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test services/api -t "splitting a charge"`
Expected: FAIL — 404 on every `/split` call.

- [ ] **Step 3: Add the request schema**

In `contracts/types.ts`, directly after the `absorption` schema, add:

```ts
/**
 * What `POST /api/expenses/:id/split` accepts.
 *
 * Its own route rather than a field on `expenseInput`, because a split is only
 * valid as a whole: every part is written in one transaction and the parts have
 * to add up to the charge. A field anybody could set would let half a split
 * exist, and half a split is a month counted wrong.
 *
 * The sum is checked on the server against the charge's own amount, not here:
 * this schema has never seen the row.
 */
export const expenseSplitInput = z.object({
  parts: z
    .array(
      z.object({
        /** Signed like any amount: splitting a refund splits a negative. */
        amount_cents: cents,
        category_id: id.nullable().default(null),
        description: z.string().max(500).default(""),
      }),
    )
    .min(2)
    .max(20),
});
export type ExpenseSplitInput = z.infer<typeof expenseSplitInput>;
```

- [ ] **Step 4: Hide parents, and write the two operations**

In `services/api/src/store.ts`, add `splitDedupeKey` to the `@lumpy/csv-import`
import, then replace `expensesBetween` (lines 17-18) with:

```ts
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
```

Then, after `updateExpense`, add:

```ts
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
```

Add `Executor` to the `@lumpy/db` import if it is not already there (it is:
`absorbManual` uses it), and `ExpenseSplitInput` to the `@lumpy/contracts` type
import.

- [ ] **Step 5: Keep a part's hash when it is edited**

In `services/api/src/store.ts`, replace `updateExpense`:

```ts
export async function updateExpense(id: number, e: ExpenseInput): Promise<number> {
  return update("expenses", id, { ...e, dedupe_hash: await freeHash(e, id) });
}
```

with:

```ts
export async function updateExpense(id: number, e: ExpenseInput): Promise<number> {
  const existing = await byId<Expense>("expenses", id);
  // A part's identity is "which part of charge N", not date + amount + merchant.
  // Rehashing it on an edit would drop it into the key space a statement row can
  // produce, and a real charge of that size on that day would then be skipped as
  // a duplicate of it.
  if (existing && existing.parent_id !== null) return update("expenses", id, e);
  return update("expenses", id, { ...e, dedupe_hash: await freeHash(e, id) });
}
```

Add `byId` to the `@lumpy/db` import.

- [ ] **Step 6: Add the routes and filter the list**

In `services/api/src/resources.ts`, add `expenseSplitInput` to the
`@lumpy/contracts` import, then inside the `expenses` Elysia block:

Change the list query (line 39) to carry the filter:

```ts
      where.push(store.NOT_SPLIT_PARENT);
      // Clamped rather than rejected: an out-of-range limit is a caller being loose,
      // not a caller being wrong, and that is how it has always behaved.
      const limit = Math.min(5000, Math.max(1, query.limit ?? 500));
      const found = await rows<Expense>("expenses", where.join(" AND "), params);
      return found.slice(0, limit);
```

(`where` is already a `string[]` joined with `" AND "`, and it is now never
empty, which is fine.)

Then add both routes after the `.delete("/expenses/:id", ...)` handler:

```ts
  /**
   * One charge, more than one category. The charge stays put and gains parts;
   * see `store.splitExpense` for why it is not deleted.
   *
   * `/expenses/:id/split` cannot be read as an id, so unlike `/merge` it needs
   * no ordering care -- it is a second segment, not a value in the first.
   */
  .post(
    "/expenses/:id/split",
    async ({ params, body }) => {
      const res = await store.splitExpense(params.id, body.parts);
      return res.ok ? status(201, res.rows) : status(res.status, { error: res.error });
    },
    {
      params: idParam,
      body: expenseSplitInput,
      response: { 201: z.array(expense), 404: errorBody, 409: errorBody, 422: errorBody },
    },
  )
  .delete(
    "/expenses/:id/split",
    async ({ params }) => ((await store.unsplitExpense(params.id)) > 0 ? { deleted: params.id } : notFound()),
    { params: idParam, response: { 200: deleted, 404: errorBody } },
  );
```

Note the `;` moves: the `.delete("/expenses/:id", ...)` above must lose its
trailing `;`.

- [ ] **Step 7: Run the API suite**

Run: `bun test services/api`
Expected: PASS, all eight new tests plus the whole existing suite. If
`response-contract.test.ts` fails, a declared response schema is missing a key
the handler returns; that is the check working.

- [ ] **Step 8: Full gate lane**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add contracts/types.ts services/api/src/store.ts services/api/src/resources.ts \
        services/api/test/api.test.ts
git commit -m "Half the Costco run was groceries and the ledger can say so"
```

---

### Task 4: Splitting from the expenses table

**Files:**
- Create: `apps/web/src/components/app/split-dialog.tsx`
- Modify: `apps/web/src/components/app/record-dialog.tsx` (`RecordDialog`, the
  props object and the submit button)
- Modify: `apps/web/src/pages/Expenses.tsx`

**Interfaces:**
- Consumes: `POST /api/expenses/:id/split` and `DELETE /api/expenses/:id/split`
  through Eden.
- Produces: `export function SplitDialog(props: { expense: Expense; categories: Category[]; onClose: () => void }): JSX.Element`.

- [ ] **Step 1: Give `RecordDialog` a disabled-submit prop**

`RecordDialog` can disable its submit button only through `pending`, which means
"a request is in flight". A split's submit is disabled for a different reason --
the parts do not add up yet -- and overloading `pending` for that is the kind of
thing that reads wrong at 3am. Two lines, in
`apps/web/src/components/app/record-dialog.tsx`:

```tsx
  pending,
  submitDisabled,
  error,
```

```tsx
  pending?: boolean;
  /** Disabled for a reason that is not "a request is in flight". */
  submitDisabled?: boolean;
  error?: unknown;
```

and on the submit button:

```tsx
            <Button type="submit" disabled={pending || submitDisabled}>
```

- [ ] **Step 2: Write the dialog**

Create `apps/web/src/components/app/split-dialog.tsx`:

```tsx
import { useState } from "react";
import type { Category, Expense } from "@lumpy/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/app/controls";
import { MoneyField, RecordDialog } from "@/components/app/record-dialog";
import { Money } from "@/components/app/money";
import { eden, useMutate } from "@/lib/api";

type Part = { amount_cents: number | null; category_id: string; description: string };

/**
 * One charge into two or more parts.
 *
 * The remainder is shown while you type rather than checked on submit, because
 * the parts have to add up to the cent and finding that out after a failed save
 * is finding it out too late. The server checks it again -- what arrives is a
 * request -- and answers 422 with both numbers in it.
 */
export function SplitDialog({
  expense,
  categories,
  onClose,
}: {
  expense: Expense;
  categories: Category[];
  onClose: () => void;
}) {
  const [parts, setParts] = useState<Part[]>([
    { amount_cents: expense.amount_cents, category_id: String(expense.category_id ?? ""), description: "" },
    { amount_cents: null, category_id: "", description: "" },
  ]);
  const split = useMutate((v: { id: number; parts: { amount_cents: number; category_id: number | null; description: string }[] }) =>
    eden.api.expenses({ id: v.id }).split.post({ parts: v.parts }));

  const allocated = parts.reduce((a, p) => a + (p.amount_cents ?? 0), 0);
  const remainder = expense.amount_cents - allocated;
  const set = (i: number, patch: Partial<Part>) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <RecordDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Split ${expense.merchant}`}
      description="The parts have to add up to the charge. Each one is an ordinary transaction afterwards."
      pending={split.isPending}
      error={split.error}
      submitLabel="Split"
      onSubmit={() =>
        split.mutate(
          {
            id: expense.id,
            parts: parts.map((p) => ({
              amount_cents: p.amount_cents ?? 0,
              category_id: p.category_id === "" ? null : Number(p.category_id),
              description: p.description,
            })),
          },
          { onSuccess: onClose },
        )
      }
      submitDisabled={remainder !== 0}
    >
      <div className="flex flex-col gap-3">
        {parts.map((p, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[9rem_1fr]">
            <MoneyField
              label={`Part ${i + 1}`}
              cents={p.amount_cents}
              onChange={(amount_cents) => set(i, { amount_cents })}
            />
            <div className="flex flex-col gap-2 sm:pt-6">
              <SelectField
                value={p.category_id}
                onChange={(category_id) => set(i, { category_id })}
                options={[
                  { value: "", label: "Uncategorized" },
                  ...categories.map((c) => ({ value: String(c.id), label: c.name })),
                ]}
              />
              <Input
                placeholder="Note (optional)"
                value={p.description}
                onChange={(e) => set(i, { description: e.target.value })}
              />
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between text-sm">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setParts((ps) => [...ps, { amount_cents: null, category_id: "", description: "" }])}
            disabled={parts.length >= 20}
          >
            Add a part
          </Button>
          <span className={remainder === 0 ? "text-muted-foreground" : "font-medium"}>
            {remainder === 0 ? "Adds up" : <>Left to allocate: <Money cents={remainder} /></>}
          </span>
        </div>
      </div>
    </RecordDialog>
  );
}
```

Every prop here matches its definition: `MoneyField` takes `cents` (not
`value`), `SelectField` takes no label of its own, and `RecordDialog` renders
`error` through `errorText` itself, so it is handed the raw error object.

- [ ] **Step 3: Wire it into the expenses table**

In `apps/web/src/pages/Expenses.tsx`:

Add the imports and the state:

```tsx
import { SplitIcon } from "lucide-react";
import { SplitDialog } from "@/components/app/split-dialog";
```

```tsx
  const [splitting, setSplitting] = useState<Expense | null>(null);
  const unsplit = useMutate((id: number) => eden.api.expenses({ id }).split.delete());
```

In the row's action cell, beside the existing edit and delete buttons:

```tsx
                          {e.parent_id === null ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setSplitting(e)}
                              aria-label={`Split ${e.merchant}`}
                            >
                              <SplitIcon />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs"
                              onClick={() => unsplit.mutate(e.parent_id!)}
                            >
                              Unsplit
                            </Button>
                          )}
```

And render the dialog beside the page's other dialogs:

```tsx
      {splitting ? (
        <SplitDialog
          expense={splitting}
          categories={categories.data ?? []}
          onClose={() => setSplitting(null)}
        />
      ) : null}
```

- [ ] **Step 4: Mark the parts in the table**

So a $120 row does not read as a $120 charge, add to the merchant cell:

```tsx
                        {e.parent_id !== null ? (
                          <Badge variant="secondary" className="ml-2 text-[10px]">part of a split</Badge>
                        ) : null}
```

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run --cwd apps/web lint`
Expected: PASS.

- [ ] **Step 6: Split something real**

```bash
bun run demo --reset
bun run dev
```
Open http://localhost:5173/expenses. Split a charge two ways, confirm the total
on the Reports page does not move, then unsplit it and confirm the original row
returns with its note intact.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/app/split-dialog.tsx apps/web/src/components/app/record-dialog.tsx apps/web/src/pages/Expenses.tsx
git commit -m "Split it where you are looking at it"
```

---

### Task 5: The one query outside the read path, and the docs

**Files:**
- Modify: `services/api/src/store.ts` (`cardBalances`, **only if the
  card-balance plan is merged**)
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Check whether `cardBalances` exists**

Run: `grep -n "cardBalances" services/api/src/store.ts`

If there is no match, the card-balance plan is not merged: **skip to Step 4**
and note in the commit message that the integration is not applicable. If it
matches, continue.

- [ ] **Step 2: Write the failing test**

Append to `services/api/test/api.test.ts`, inside the existing
`describe("card balances")` block:

```ts
  test("a split card charge is counted once, not twice", async () => {
    const card = await post("/api/import-profiles", { name: "Airline Card", mapping, cash_account: false });
    await post("/api/import", {
      filename: "card.csv", profile_id: card.body.id,
      rows: [{ txn_date: "2026-03-02", amount_cents: 18000, merchant: "COSTCO", description: "", category_id: null, source: "import" }],
    });
    const charge = (await api("/api/expenses")).body[0];
    await post(`/api/expenses/${charge.id}/split`, {
      parts: [
        { amount_cents: 12000, category_id: null, description: "" },
        { amount_cents: 6000, category_id: null, description: "" },
      ],
    });

    // The parent and both parts are all in the table. Summing all three would
    // say the card is owed $360 for a $180 charge.
    const [row] = (await api("/api/card-balances")).body;
    expect(row.net_cents).toBe(18000);
    expect(row.txn_count).toBe(2);
  });
```

- [ ] **Step 3: Add the predicate to the card query**

In `services/api/src/store.ts`, in `cardBalances`, change the `LEFT JOIN` on
expenses to exclude split parents:

```sql
       LEFT JOIN expenses e       ON e.import_batch_id = b.id
                                 AND NOT EXISTS (SELECT 1 FROM expenses c WHERE c.parent_id = e.id)
```

Written out rather than interpolating `NOT_SPLIT_PARENT`: that constant names
the outer table `expenses`, and here the outer table is aliased `e`.

Run: `bun test services/api -t "counted once"`
Expected: PASS.

- [ ] **Step 4: `README.md`**

Under "The rules that keep it correct", after the paragraph about a hand-entered
charge being merged:

```markdown
**One charge can be more than one category.** Half the Costco run is groceries
and half is shelving. Split it and the charge gains parts: ordinary transactions
carrying the date, the merchant and the batch of the charge they came from, each
with its own category and note. The parts have to add up to the cent, checked
while you type and again on the server.

The charge itself is kept, not deleted, and simply never read again. It is
holding the dedupe hash: delete it and next month's overlapping statement
re-inserts the whole charge beside the halves you already split it into, and the
month is counted twice. Unsplit and it comes back at the amount the bank actually
charged.

A part's identity is which part it is, not its date and amount, so a $120 part of
a $180 charge can never make a genuine $120 charge at that shop that day look
like a duplicate.
```

- [ ] **Step 5: `CLAUDE.md`**

Under the traps list:

```markdown
- **A split keeps the parent row and hides it; it does not delete it.** The
  parent holds the `dedupe_hash`, which is the only reason a re-imported
  statement is still a no-op, and `NOT_SPLIT_PARENT` in `api/src/store.ts` is
  what keeps it out of `expensesBetween` and the `/expenses` list -- the two
  reads every report funnels through. There is no `split` column: a parent is a
  row that has children, asked directly, so the flag cannot drift. `cardBalances`
  is the one query that does not go through either read path and carries the
  predicate written out against its own alias.
- **A split part is hashed with `splitDedupeKey(parentId, index)`, not
  `dedupeKey`.** A part carries the parent's date and merchant with a fraction of
  its amount, so an ordinary hash would sit in the key space a statement row can
  produce and a real charge of that size on that day would be dropped as a
  duplicate. That is also why `updateExpense` leaves a part's hash alone: a part
  is "the second half of charge 41" whatever it is re-apportioned to.
- **`restore()` sorts expenses by ascending id.** `parent_id` is a self
  foreign key and the export is ordered `txn_date DESC, id DESC`, so the child
  comes out of the file first. A child is always created after its parent, so
  ascending id is parents-first.
- **A part inherits `import_batch_id` from the charge.** `nonCashBatchIds` reads
  the batch to tell a card charge from money out of checking; batchless parts
  would be counted against the checking balance forever. Same trap
  `absorbManual` already documents.
```

- [ ] **Step 6: Full gate lane**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 7: Commit and push**

```bash
git add services/api README.md CLAUDE.md
git commit -m "Write down why the split charge is still in the table"
git push
```

**Restart after merging:** `bun run migrate` on every database, then restart the
API (`bun run api`). Run `bun run backup` first: 014 adds a foreign key, and a
migration that fails halfway cannot roll back.

---

## Self-Review

**Spec coverage.** Storage with the hash preserved (Tasks 1, 2). Split, unsplit,
the sum check, the double-split refusal, the batch inheritance, and the parent
hidden from every read (Task 3). UI (Task 4). The one query outside the read path
and the docs (Task 5). The re-import no-op is asserted directly, which is the
requirement the whole design exists to protect.

**Placeholders.** None. Every web prop used in Task 4 was checked against its
definition -- `MoneyField.cents`, `SelectField` without a label, `RecordDialog`'s
raw `error` -- and the one prop that did not exist (`submitDisabled`) is added in
a numbered step rather than assumed. Task 5 Step 1 makes the cross-plan
integration a checked branch rather than an assumption.

**Type consistency.** `parent_id` is `id.nullable().default(null)` on the
`expense` row schema in Task 1 and read as `e.parent_id === null` in Tasks 3 and
4. `splitExpense` returns the discriminated `{ ok: true; rows } | { ok: false;
status; error }` in Task 3 Step 4 and is consumed exactly that way in Step 6.
`splitDedupeKey(parentId, index)` has the same argument order in Task 2's
definition, Task 2's test, and its one call in Task 3.
