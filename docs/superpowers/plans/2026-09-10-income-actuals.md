# Income Actuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give deposits a bucket of their own so an imported paycheck stops
counting as negative discretionary spending, and show each month's real
deposits beside the income the plan assumes.

**Architecture:** A sixth bucket, `income`, added to the `categories.bucket`
ENUM and to `bucketSchema`. The seed already ships an `Income` category (under
`transfer`); migration 013 moves it. `bucketOf` gains one rule: an
*uncategorized* row that is negative is neutral rather than discretionary,
because the "over-report spending is the safe error" argument inverts on a
credit. Budget-core gains a pure `incomeReconciliation` that compares
`monthlyActual` (the plan) against what actually landed in income categories.

**Tech Stack:** Bun, MySQL/MariaDB, zod, Elysia, Eden treaty, React, Tailwind v4,
shadcn/ui.

**Spec:** `docs/superpowers/plans/2026-09-10-README.md` (shared constraints) and
the "Known limits" / "How the pieces work" sections of `README.md`.

## Global Constraints

- Money is always an integer number of cents. No floats, no `DECIMAL`.
- Dates are always `YYYY-MM-DD` strings. No `Date` object crosses the DB or HTTP
  boundary. A raw `tx.unsafe` SELECT does not go through `coerce()`.
- Query params use `.optional()`, never `.default()`.
- Validation failures are 422 in Elysia's shape, not 400.
- A column lives in four places in order: migration, `services/db/src/tables.ts`,
  `contracts/types.ts`, scenario expectations.
- Migrations are forward-only. **This plan owns 013 and no other number.**
- `bun run check` must be green at every commit. Never `--no-verify`.
- `bun test` needs MySQL running.

---

## File Structure

- `services/db/migrations/013_income_bucket.sql` — **create.** Widens the ENUM,
  moves the seeded `Income` category.
- `contracts/types.ts:58` — **modify.** `bucketSchema` gains `"income"`.
- `services/db/src/seed.ts:33` — **modify.** `Income` seeds as `income`, plus
  three payroll rules.
- `services/budget-core/src/reports.ts:9-11` — **modify.** `bucketOf` reads the
  sign; `totalsByBucket` gains an `income` key.
- `services/budget-core/src/income.ts` — **modify.** `depositedInMonth` and
  `incomeReconciliation`.
- `services/api/src/computed.ts:22` and `:35-53` — **modify.** `bucketQuery`
  gains `income`; `/income-calendar` returns actuals.
- `apps/web/src/lib/format.ts:63-80` — **modify.** Label, hint, order.
- `apps/web/src/pages/Income.tsx:196-240` — **modify.** Deposited column.
- Tests: `services/budget-core/test/reports.test.ts`,
  `services/budget-core/test/income.test.ts`, `services/api/test/api.test.ts`,
  `services/db/test/seed.test.ts`.

---

### Task 1: The `income` bucket exists end to end

**Files:**
- Create: `services/db/migrations/013_income_bucket.sql`
- Modify: `contracts/types.ts:58`
- Modify: `services/db/src/seed.ts:33-34`
- Test: `services/api/test/api.test.ts`, `services/db/test/seed.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Bucket` now includes `"income"`. Every later task and every other
  plan that switches on a bucket sees the new member.

- [ ] **Step 1: Write the failing API test**

Append to `services/api/test/api.test.ts`, inside the existing `describe("crud")`
block:

```ts
test("a category can be created in the income bucket", async () => {
  const created = await post("/api/categories", {
    name: "Paychecks", bucket: "income", icon: "banknote", color: null,
  });
  expect(created.status).toBe(201);
  expect(created.body.bucket).toBe("income");

  // The proof the ENUM migration landed: MySQL rejects an unlisted value, so a
  // zod schema that allows it and a column that does not would fail right here.
  expect((await api(`/api/categories/${created.body.id}`)).body.bucket).toBe("income");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test services/api -t "income bucket"`
Expected: FAIL — 422 from zod (`bucketSchema` has no `income`), before MySQL is
even asked.

- [ ] **Step 3: Widen the zod enum**

In `contracts/types.ts`, replace line 58:

```ts
export const bucketSchema = z.enum(["discretionary", "fixed", "lumpy", "savings", "transfer"]);
```

with:

```ts
/**
 * `income` is money arriving, not money leaving. It exists because an imported
 * checking statement writes every deposit as a credit -- a negative expense --
 * and without a bucket of its own a $2,400 paycheck reads as $2,400 of negative
 * discretionary spending: it inflates what is available, it poisons the
 * `categoryPace` median, and it quietly credits the checking balance.
 *
 * Distinct from `transfer` rather than folded into it. Both are neutral against
 * what you can spend, but only one is the number `monthlyActual` is predicting,
 * and matching on a bucket survives somebody renaming the category.
 */
export const bucketSchema = z.enum(["discretionary", "fixed", "lumpy", "savings", "transfer", "income"]);
```

- [ ] **Step 4: Write the migration**

Create `services/db/migrations/013_income_bucket.sql`:

```sql
-- Deposits get a bucket of their own.
--
-- An imported checking statement writes every credit as a negative expense.
-- With no bucket for it, `bucketOf` fell through to its default and a paycheck
-- counted as negative discretionary spending: available to spend went up by the
-- size of the paycheck, the categoryPace median was computed against a category
-- nobody spends in, and the cash position credited a balance the money had
-- already been counted into.
--
-- Separate from `transfer` on purpose. Both are neutral against what you can
-- spend, but only `income` is the number `monthlyActual` predicts, and a report
-- that matches on the bucket survives somebody renaming the category.
--
-- The UPDATE heals what the seed always meant: `Income` shipped under
-- `transfer` because that was the only neutral bucket there was. Scoped to that
-- exact name and that exact bucket, so a category a person built themselves is
-- left alone -- the same shape as migration 009 turning on the whole-word switch
-- for the two rules whose trailing space was reaching for it.

ALTER TABLE categories
  MODIFY COLUMN bucket
    ENUM('discretionary','fixed','lumpy','savings','transfer','income')
    NOT NULL DEFAULT 'discretionary';

UPDATE categories SET bucket = 'income' WHERE name = 'Income' AND bucket = 'transfer';
```

- [ ] **Step 5: Move the seeded category and add payroll rules**

In `services/db/src/seed.ts`, change the `Bucket` type on line 9 and the last
entry of `CATEGORIES`:

```ts
type Bucket = "discretionary" | "fixed" | "lumpy" | "savings" | "transfer" | "income";
```

```ts
  ["Credit Card Payment", "transfer", "credit-card"],
  ["Income", "income", "banknote"],
```

Then add to `RULES`, next to the other groups:

```ts
  // Deposits. Guesses like every other rule here, and the ones most worth
  // getting right: an uncategorized credit is the one row that can move a
  // number in the direction this app must never guess in.
  ["payroll", "Income"], ["direct dep", "Income"], ["dir dep", "Income"],
```

- [ ] **Step 6: Write the failing seed test**

`services/db/test/seed.test.ts` builds its own client with a dynamic import and
has no `rows()` helper, and `db` must not import from a package above it, so this
one is raw SQL. Append:

```ts
test("the seeded Income category is in the income bucket", async () => {
  await empty();
  await seed();
  const found = (await sql.unsafe(
    "SELECT bucket FROM categories WHERE name = 'Income'",
  )) as { bucket: string }[];
  expect(found[0]!.bucket).toBe("income");
});

test("a payroll rule points at it", async () => {
  await empty();
  await seed();
  const found = (await sql.unsafe(
    `SELECT r.pattern FROM category_rules r
       JOIN categories c ON c.id = r.category_id
      WHERE c.name = 'Income' ORDER BY r.pattern ASC`,
  )) as { pattern: string }[];
  expect(found.map((r) => r.pattern)).toEqual(["dir dep", "direct dep", "payroll"]);
});
```

`empty()` and `seed()` are already defined at the top of that file; match how the
existing tests call them.

- [ ] **Step 7: Migrate the test database and run both suites**

```bash
bun run migrate
TEST_DATABASE_URL="mysql://root@127.0.0.1:3306/lumpy_budget_test" bun test services/db services/api
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add services/db/migrations/013_income_bucket.sql contracts/types.ts \
        services/db/src/seed.ts services/db/test/seed.test.ts services/api/test/api.test.ts
git commit -m "A deposit is not spending you did in reverse"
```

---

### Task 2: An uncategorized credit is neutral, not a refund of your whole month

**Files:**
- Modify: `services/budget-core/src/reports.ts:8-11`, `:21-36`
- Test: `services/budget-core/test/reports.test.ts`

**Interfaces:**
- Consumes: `Bucket` including `"income"` from Task 1.
- Produces: `bucketOf(e: Pick<Expense, "category_id" | "amount_cents">, byId: Map<number, Category>): Bucket`
  — the parameter type widens from `Pick<Expense, "category_id">`. Every existing
  caller passes a whole `Expense`, so no call site changes.
  `BucketTotals` gains an `income: Cents` key.

- [ ] **Step 1: Write the failing test**

Append to `services/budget-core/test/reports.test.ts`. That file uses flat
`test()` calls with named imports and no `describe`, so these follow it. Add
`sum` to nothing and change no imports: `category`, `expense`, `bucketOf`,
`categoryIndex` and `totalsByBucket` are all imported there already.

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test services/budget-core/test/reports.test.ts`
Expected: FAIL — the first new test gets `"discretionary"`, and `totals.income`
is `undefined`.

- [ ] **Step 3: Read the sign in `bucketOf`**

In `services/budget-core/src/reports.ts`, replace lines 8-11:

```ts
/** Anything without a category counts as discretionary: it is safer to over-report spending. */
export function bucketOf(e: Pick<Expense, "category_id">, byId: Map<number, Category>): Bucket {
  return (e.category_id !== null ? byId.get(e.category_id)?.bucket : undefined) ?? "discretionary";
}
```

with:

```ts
/**
 * A row's bucket, and what to do with one nobody has placed.
 *
 * An uncategorized *charge* is discretionary, because over-reporting spending is
 * the safe error. An uncategorized *credit* inverts that argument exactly: read
 * as discretionary it pays money back into what is available, and a paycheck
 * imported off a checking statement pays back the whole month. So a credit is
 * neutral until somebody says what it is, and it waits in the review queue on
 * the expenses page like every other unplaced row.
 *
 * This only ever applies to rows with no category at all. A refund somebody
 * categorized is a fact, and it goes on creditting the category it came out of.
 */
export function bucketOf(
  e: Pick<Expense, "category_id" | "amount_cents">,
  byId: Map<number, Category>,
): Bucket {
  const named = e.category_id !== null ? byId.get(e.category_id)?.bucket : undefined;
  if (named !== undefined) return named;
  return e.amount_cents < 0 ? "transfer" : "discretionary";
}
```

- [ ] **Step 4: Give `BucketTotals` its sixth key**

In the same file, in `totalsByBucket`, add `income: 0,` to the initializer,
directly after `transfer: 0,`:

```ts
  const out: BucketTotals = {
    discretionary: 0,
    fixed: 0,
    lumpy: 0,
    savings: 0,
    transfer: 0,
    income: 0,
    total: 0,
  };
```

`BucketTotals` is `Record<Bucket, Cents> & { total: Cents }`, so the key is
already required by the type; this is the value side catching up.

- [ ] **Step 5: Run the whole gate lane**

Run: `bun test services/budget-core && bun run scenarios`
Expected: budget-core PASS. **`scenarios` will FAIL** with a diff adding
`"income": 0` to every `money.spent` block. Read the diff and confirm that is
the only change.

- [ ] **Step 6: Accept the scenario diff**

Run: `bun run scenarios:update && bun run scenarios`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/budget-core/src/reports.ts services/budget-core/test/reports.test.ts \
        services/budget-core/fixtures/households
git commit -m "The paycheck was not a refund on everything you bought"
```

---

### Task 3: What actually landed, against what the plan assumed

**Files:**
- Modify: `services/budget-core/src/income.ts`
- Test: `services/budget-core/test/income.test.ts`

**Interfaces:**
- Consumes: `bucketOf`, `categoryIndex`, `inWindow` from `./reports`;
  `monthlyActual` already in this file.
- Produces:
  ```ts
  export type MonthDeposits = {
    month: ISOMonth;
    planned_cents: Cents;
    deposited_cents: Cents;
    delta_cents: Cents;
    count: number;
    imported: boolean;
  };
  export function depositedInMonth(expenses: Expense[], categories: Category[], month: ISOMonth): { cents: Cents; count: number };
  export function incomeReconciliation(streams: IncomeStream[], expenses: Expense[], categories: Category[], months: ISOMonth[]): MonthDeposits[];
  ```

- [ ] **Step 1: Write the failing test**

Append to `services/budget-core/test/income.test.ts`. That file imports
`stream` from `../fixtures/factories` and its functions from `../src/income`,
with flat `test()` calls; extend both import lines rather than adding a
namespace:

```ts
import { category, expense, stream } from "../fixtures/factories";
import {
  depositedInMonth, incomeCalendar, incomeReconciliation, monthlyActual, monthlyNormalized, nextPaycheck,
} from "../src/income";

const incomeCat = category({ name: "Income", bucket: "income" });
const groceriesCat = category({ name: "Groceries", bucket: "discretionary" });
const paidCats = [incomeCat, groceriesCat];
// $1,200 on the 15th and the last day = $2,400 planned.
const semimonthly = () =>
  stream({ name: "Job", amount_cents: 120000, frequency: "semimonthly", day_1: 15, day_2: 0, anchor_date: null });

test("a deposit is stored as a credit and reported as a positive", () => {
  const rows = [expense({ txn_date: "2026-03-15", amount_cents: -120000, category_id: incomeCat.id })];
  expect(depositedInMonth(rows, paidCats, "2026-03")).toEqual({ cents: 120000, count: 1 });
});

test("reconciliation names the gap when a paycheck did not land", () => {
  const rows = [
    expense({ txn_date: "2026-03-15", amount_cents: -120000, category_id: incomeCat.id }),
    expense({ txn_date: "2026-03-04", amount_cents: 8100, category_id: groceriesCat.id }),
  ];
  const [march] = incomeReconciliation([semimonthly()], rows, paidCats, ["2026-03"]);
  expect(march).toMatchObject({
    month: "2026-03", planned_cents: 240000, deposited_cents: 120000,
    delta_cents: -120000, count: 1, imported: true,
  });
});

test("a month nobody imported is not a month you were not paid", () => {
  // The same rule fixedCostVariance and categoryPace follow. A red -$2,400 on a
  // month with no statement in it is a missing import wearing the face of a
  // missing paycheck, and the two need opposite responses.
  const [april] = incomeReconciliation([semimonthly()], [], paidCats, ["2026-04"]);
  expect(april).toMatchObject({ deposited_cents: 0, delta_cents: 0, imported: false });
});

test("a bonus nobody planned reads as surplus rather than as an error", () => {
  const rows = [
    expense({ txn_date: "2026-03-15", amount_cents: -120000, category_id: incomeCat.id }),
    expense({ txn_date: "2026-03-31", amount_cents: -120000, category_id: incomeCat.id }),
    expense({ txn_date: "2026-03-20", amount_cents: -50000, category_id: incomeCat.id }),
  ];
  const [march] = incomeReconciliation([semimonthly()], rows, paidCats, ["2026-03"]);
  expect(march!.delta_cents).toBe(50000);
  expect(march!.count).toBe(3);
});

test("a deposit outside the month is not that month's income", () => {
  const rows = [expense({ txn_date: "2026-02-28", amount_cents: -120000, category_id: incomeCat.id })];
  expect(depositedInMonth(rows, paidCats, "2026-03")).toEqual({ cents: 0, count: 0 });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test services/budget-core/test/income.test.ts`
Expected: FAIL — `depositedInMonth is not exported by ../src/income`.

- [ ] **Step 3: Implement both functions**

At the end of `services/budget-core/src/income.ts`, add the imports it now needs
to the top of the file:

```ts
import type { Category, Expense, IncomeStream } from "@lumpy/contracts";
import { bucketOf, categoryIndex, inWindow } from "./reports";
```

(`reports.ts` imports nothing from `income.ts`, so this is not a cycle. Merge the
`IncomeStream` import with the one already on line 1.)

Then append:

```ts
/**
 * What really landed in `month`, as a positive number.
 *
 * A deposit is stored the way the importer writes it: a credit, so a negative
 * expense. It is reported here the way a person says it out loud, so the sign
 * is flipped exactly once, here, and nowhere else in the stack.
 */
export function depositedInMonth(
  expenses: Expense[],
  categories: Category[],
  month: ISOMonth,
): { cents: Cents; count: number } {
  const byId = categoryIndex(categories);
  const start = d.monthStart(month);
  const end = d.monthEnd(month);
  const rows = expenses.filter((e) => inWindow(e, start, end) && bucketOf(e, byId) === "income");
  return { cents: -sum(rows.map((e) => e.amount_cents)), count: rows.length };
}

export type MonthDeposits = {
  month: ISOMonth;
  /** What the pay schedules say should have arrived. */
  planned_cents: Cents;
  /** What the statements say did. */
  deposited_cents: Cents;
  /** Deposited minus planned. Negative is a paycheck that did not land. */
  delta_cents: Cents;
  count: number;
  /** Whether any statement covers this month at all. */
  imported: boolean;
};

/**
 * The plan against the bank, month by month.
 *
 * Every other number in this app is derived from the pay schedules somebody
 * typed in once. This is the only one that asks whether they were right, which
 * matters because the whole allocation -- every bill parked on a paycheck, every
 * lumpy contribution carved out before it -- rests on them.
 *
 * A month with no transactions at all is reported as `imported: false` and a
 * delta of zero, not as a month you were not paid. It is the same rule
 * `fixedCostVariance` and `categoryPace` follow, and for the same reason: a
 * missing statement and a missing paycheck read identically in a red number and
 * need opposite responses.
 */
export function incomeReconciliation(
  streams: IncomeStream[],
  expenses: Expense[],
  categories: Category[],
  months: ISOMonth[],
): MonthDeposits[] {
  // Decided by every transaction, not only the deposits: a month whose statement
  // holds nothing but spending was still imported, and its missing paycheck is
  // a real finding.
  const importedMonths = new Set(expenses.map((e) => d.monthOf(e.txn_date)));
  return months.map((month) => {
    const planned = monthlyActual(streams, month);
    const imported = importedMonths.has(month);
    const { cents, count } = depositedInMonth(expenses, categories, month);
    return {
      month,
      planned_cents: planned,
      deposited_cents: cents,
      delta_cents: imported ? cents - planned : 0,
      count,
      imported,
    };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test services/budget-core/test/income.test.ts`
Expected: PASS, the four new tests and the four already there.

- [ ] **Step 5: Run the whole gate lane**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/budget-core/src/income.ts services/budget-core/test/income.test.ts
git commit -m "The schedules say $2,400 a month; ask the bank"
```

---

### Task 4: `/income-calendar` answers with the bank in it

**Files:**
- Modify: `services/api/src/computed.ts:22` and `:35-53`
- Test: `services/api/test/api.test.ts`

**Interfaces:**
- Consumes: `core.incomeReconciliation` from Task 3.
- Produces: each entry of the route's `months[]` gains `deposited_cents`,
  `delta_cents`, `deposit_count`, `imported`. `bucketQuery` accepts `"income"`.

- [ ] **Step 1: Write the failing test**

Append to `services/api/test/api.test.ts`:

```ts
test("the income calendar reports what actually landed", async () => {
  const cat = await post("/api/categories", { name: "Income", bucket: "income", icon: "banknote", color: null });
  await post("/api/income-streams", {
    name: "Day job", amount_cents: 120000, frequency: "semimonthly",
    anchor_date: null, day_1: 15, day_2: 0, day_of_month: null, active: true,
  });
  // One of the two March paychecks, plus a charge so March counts as imported.
  await post("/api/expenses", {
    txn_date: "2026-03-15", amount_cents: -120000, merchant: "ACME PAYROLL",
    description: "", category_id: cat.body.id, source: "manual",
  });
  await post("/api/expenses", {
    txn_date: "2026-03-04", amount_cents: 8100, merchant: "WEGMANS",
    description: "", category_id: null, source: "manual",
  });

  const cal = await api("/api/income-calendar?year=2026");
  const march = cal.body.months.find((m: { month: string }) => m.month === "2026-03");
  expect(march).toMatchObject({
    total_cents: 240000, deposited_cents: 120000, delta_cents: -120000,
    deposit_count: 1, imported: true,
  });

  // April has no statement at all, so it is silent rather than accusing.
  const april = cal.body.months.find((m: { month: string }) => m.month === "2026-04");
  expect(april).toMatchObject({ deposited_cents: 0, delta_cents: 0, imported: false });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test services/api -t "actually landed"`
Expected: FAIL — `march` has no `deposited_cents`.

- [ ] **Step 3: Widen `bucketQuery`**

In `services/api/src/computed.ts`, line 22:

```ts
const bucketQuery = z.enum(["discretionary", "fixed", "lumpy", "savings", "transfer", "income", "all"]).optional();
```

- [ ] **Step 4: Fold the reconciliation into `/income-calendar`**

Replace the `/income-calendar` handler body (lines 35-53) with:

```ts
  .get(
    "/income-calendar",
    async ({ query }) => {
      const year = clamp(query.year, new Date().getFullYear(), 1970, 2999);
      const [streams, expenses, cats] = await Promise.all([
        store.streams(),
        store.expensesBetween(`${year}-01-01`, `${year}-12-31`),
        store.categories(),
      ]);
      const months = core.incomeCalendar(streams, year);
      // Zipped rather than merged inside budget-core: `incomeCalendar` is the
      // plan and `incomeReconciliation` is the bank, and keeping them two
      // functions is what lets the scenario lane pin the plan without a ledger.
      const actual = new Map(
        core
          .incomeReconciliation(streams, expenses, cats, months.map((m) => m.month))
          .map((r) => [r.month, r]),
      );
      return {
        year,
        months: months.map((m) => ({
          ...m,
          deposited_cents: actual.get(m.month)?.deposited_cents ?? 0,
          delta_cents: actual.get(m.month)?.delta_cents ?? 0,
          deposit_count: actual.get(m.month)?.count ?? 0,
          imported: actual.get(m.month)?.imported ?? false,
        })),
        streams: streams.map((x) => ({
          id: x.id,
          name: x.name,
          frequency: x.frequency,
          amount_cents: x.amount_cents,
          extra_paycheck_months: core.extraPaycheckMonths(x, year),
        })),
      };
    },
    { query: z.object({ year: num }) },
  )
```

- [ ] **Step 5: Run the API suite**

Run: `bun test services/api`
Expected: PASS, including `response-contract.test.ts` — this route declares no
`response` schema, so the added keys are legal.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/computed.ts services/api/test/api.test.ts
git commit -m "The income calendar stops taking the schedule's word for it"
```

---

### Task 5: The Income page shows the gap

**Files:**
- Modify: `apps/web/src/lib/format.ts:63-80`
- Modify: `apps/web/src/pages/Income.tsx:196-240`

**Interfaces:**
- Consumes: the widened `/income-calendar` payload from Task 4, reached through
  Eden, so the new keys are typed without any client-side declaration.
- Produces: nothing other tasks read.

- [ ] **Step 1: Give the bucket a label, a hint and a place in the order**

In `apps/web/src/lib/format.ts`, add to `BUCKET_LABEL`:

```ts
  income: "Income",
```

to `BUCKET_HINT`:

```ts
  income: "money arriving, never counted as spending",
```

and to `BUCKET_ORDER` (last, because it is the only one that is not an outflow):

```ts
export const BUCKET_ORDER = ["discretionary", "fixed", "lumpy", "savings", "transfer", "income"] as const;
```

- [ ] **Step 2: Add the deposited column to the year list**

In `apps/web/src/pages/Income.tsx`, in the `{year}` card, replace the `<li>`
body's trailing `<span className="flex items-center gap-3">` block with:

```tsx
                  <span className="flex items-center gap-3">
                    <Money cents={m.total_cents} className="text-sm" />
                    {/* What the bank says, against what the schedules assumed.
                        A month nobody imported is silent: a red -$2,400 there is
                        a missing statement wearing the face of a missing
                        paycheck, and the two need opposite responses. */}
                    {m.imported ? (
                      <span className="flex w-32 items-center justify-end gap-2 text-xs">
                        <Money cents={m.deposited_cents} className="text-xs text-muted-foreground" />
                        {m.delta_cents !== 0 ? <Money cents={m.delta_cents} sign tone className="text-xs" /> : null}
                      </span>
                    ) : (
                      <span className="w-32 text-right text-xs text-muted-foreground">not imported</span>
                    )}
                    {m.surplus_cents > 0 ? (
                      <Money cents={m.surplus_cents} sign tone className="w-24 text-right text-xs" />
                    ) : (
                      <span className="w-24" />
                    )}
                  </span>
```

- [ ] **Step 3: Explain the column in the card description**

In the same card's `<CardDescription>`, append after the existing text:

```tsx
                {" "}Each month also shows what the statements actually deposited,
                and the gap. A month with no statement imported says so instead of
                reporting a paycheck as missing.
```

- [ ] **Step 4: Typecheck and lint**

Run: `bun run typecheck && bun run --cwd apps/web lint`
Expected: PASS. A failure here naming `deposited_cents` means Task 4 did not
land: Eden builds this page's types out of the server's route type.

- [ ] **Step 5: Look at it**

```bash
bun run dev
```
Open http://localhost:5173/income. Confirm a month with imports shows two
numbers and a month without says "not imported".

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/format.ts apps/web/src/pages/Income.tsx
git commit -m "Planned, deposited, and the difference between them"
```

---

### Task 6: Write down what the next person needs to know

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the feature to `README.md`**

Under "How the pieces work", after the **Pay schedules** paragraph:

```markdown
**Planned income, and what the bank actually deposited.** Every allocation in
this app rests on pay schedules somebody typed in once. Give a category the
`income` bucket -- the seeded `Income` category has it -- and the income page
compares each month's schedule against the deposits that really landed, so a
raise, a short cheque or a paycheck that never arrived is visible rather than
assumed. A month with no statement imported is reported as exactly that, not as
a month you were not paid.

A deposit is stored the way the importer writes it, as a credit, which is a
negative expense. Its bucket keeps it out of every spending number, and the sign
is flipped once, in `depositedInMonth`, so the page can say it out loud.
```

Under "Known limits", replace nothing; add:

```markdown
- An uncategorized credit is neutral rather than discretionary. That is the safe
  reading, but it means a refund nobody has categorized does not yet credit the
  category it came out of. Categorize it and it does.
```

- [ ] **Step 2: Add the trap to `CLAUDE.md`**

Under "Traps that already bit and are pinned by tests":

```markdown
- **`bucketOf` reads the amount, not just the category.** An uncategorized
  charge is discretionary because over-reporting spending is the safe error; an
  uncategorized *credit* inverts that argument, so it is `transfer` and neutral.
  Counted as discretionary, a paycheck imported off a checking statement paid
  back the entire month: available went up, the `categoryPace` median was taken
  over a category nobody spends in, and `cash-position` credited a balance the
  money was already counted into. Four tests pin it.
- **`income` is a bucket, not the category named "Income".** Migration 013 moved
  the seeded row and widened the ENUM. Matching on the bucket is what survives
  somebody renaming the category, which is the whole reason it is not folded
  into `transfer`.
```

- [ ] **Step 3: Full gate lane**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit and push**

```bash
git add README.md CLAUDE.md
git commit -m "Write down why a credit is not a refund"
git push
```

**Restart after merging:** `bun run migrate` on every database, then restart the
API (`bun run api`). The web app is a Vite build and needs no restart in dev.

---

## Self-Review

**Spec coverage.** Bucket exists in the ENUM, the zod enum, the seed, the
labels, the query param (Task 1, 2, 4, 5). The undercount bug is fixed and
pinned (Task 2). Planned-vs-deposited exists as a pure function, a route and a
column (Tasks 3, 4, 5). Docs (Task 6). No requirement without a task.

**Placeholders.** None: every step carries the code it asks for.

**Type consistency.** `depositedInMonth` returns `{ cents, count }` in Task 3's
implementation and is asserted with that shape in Task 3's test and read with
`.count` in Task 4. `MonthDeposits.count` is mapped to the wire name
`deposit_count` in Task 4 and read as `deposit_count` in Task 4's test; the web
app in Task 5 reads `deposited_cents`, `delta_cents` and `imported`, all of
which Task 4 emits. `bucketOf`'s widened parameter is `Pick<Expense,
"category_id" | "amount_cents">` in Task 2 and every existing caller passes a
whole `Expense`.
