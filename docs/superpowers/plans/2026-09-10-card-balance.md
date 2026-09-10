# Credit Card Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Say what each credit card is about to ask for, derived from the
statements already imported, so the one obligation the plan currently ignores
stops arriving as a surprise.

**Architecture:** No schema change. `import_profiles.cash_account` already
separates a card statement from the checking statement, and `nonCashBatchIds`
already reads it. A card statement writes charges as positive and the payment as
a credit, so the running sum of every row imported under that profile *is* the
balance change. Add a hand-typed opening balance per card -- the same
hand-kept-balance pattern the lumpy fund and the checking tile already use --
and the balance owed is `opening + net`.

**Tech Stack:** Bun, MySQL/MariaDB, zod, Elysia, Eden treaty, React, Tailwind v4,
shadcn/ui.

**Spec:** `docs/superpowers/plans/2026-09-10-README.md` (shared constraints) and
the "Which statement a charge came from" section of `README.md`.

## Global Constraints

- Money is always an integer number of cents. No floats, no `DECIMAL`.
- Dates are always `YYYY-MM-DD` strings. **A raw `tx.unsafe`/`sql.unsafe` SELECT
  does not go through `coerce()`**, so any date column in a hand-written
  statement must say `DATE_FORMAT(col,'%Y-%m-%d')` itself.
- Query params use `.optional()`, never `.default()`.
- Validation failures are 422 in Elysia's shape, not 400.
- Migrations are forward-only. **This plan adds none.**
- `bun run check` must be green at every commit. Never `--no-verify`.
- `bun test` needs MySQL running.

---

## File Structure

- `services/api/src/store.ts` — **modify.** `cardBalances()`, one grouped query.
  Lives beside `nonCashBatchIds`, which reads the same boolean for the other
  half of the same distinction.
- `services/api/src/computed.ts` — **modify.** `GET /api/card-balances`.
- `apps/web/src/components/app/card-balances.tsx` — **create.** The card, the
  tiles, and the opening-balance editor. Its own file because `Dashboard.tsx` is
  already 361 lines and this is a self-contained block.
- `apps/web/src/pages/Dashboard.tsx` — **modify.** Render it below the cash
  position, which is the number it qualifies.
- Tests: `services/api/test/api.test.ts`.

---

### Task 1: The balance is the running sum of the statements

**Files:**
- Modify: `services/api/src/store.ts` (after `nonCashBatchIds`, around line 37)
- Test: `services/api/test/api.test.ts`

**Interfaces:**
- Consumes: `import_profiles.cash_account` (migration 012), `sql` from
  `@lumpy/db`, `setting()` already in this file.
- Produces:
  ```ts
  export const cardOpeningKey = (profileId: number): string => `card_opening_balance_cents:${profileId}`;
  export type CardBalance = {
    profile_id: number; name: string; opening_key: string;
    opening_cents: number; net_cents: number; balance_cents: number;
    txn_count: number; last_txn_date: string | null;
  };
  export function cardBalances(): Promise<CardBalance[]>;
  ```

- [ ] **Step 1: Write the failing test**

Append to `services/api/test/api.test.ts`:

```ts
describe("card balances", () => {
  beforeEach(() => resetDb());

  const mapping = {
    date_column: "Date", amount_column: "Amount", debit_column: null, credit_column: null,
    merchant_column: "Description", description_column: null, date_format: "auto" as const,
    flip_sign: false, skip_rows: 0,
  };

  test("the running sum of a card statement is what the card will ask for", async () => {
    const card = await post("/api/import-profiles", { name: "Airline Card", mapping, cash_account: false });
    await post("/api/import", {
      filename: "card-march.csv", profile_id: card.body.id,
      rows: [
        { txn_date: "2026-03-02", amount_cents: 12000, merchant: "WEGMANS", description: "", category_id: null, source: "import" },
        { txn_date: "2026-03-09", amount_cents: 4500, merchant: "SHELL", description: "", category_id: null, source: "import" },
        // The payment posts on the card statement as a credit, so the running
        // sum needs no rule to know a payment happened.
        { txn_date: "2026-03-20", amount_cents: -10000, merchant: "PAYMENT THANK YOU", description: "", category_id: null, source: "import" },
      ],
    });

    const [row] = (await api("/api/card-balances")).body;
    expect(row).toMatchObject({
      name: "Airline Card", opening_cents: 0, net_cents: 6500, balance_cents: 6500,
      txn_count: 3, last_txn_date: "2026-03-20",
      opening_key: `card_opening_balance_cents:${card.body.id}`,
    });
  });

  test("an opening balance carries the statements you never imported", async () => {
    const card = await post("/api/import-profiles", { name: "Store Card", mapping, cash_account: false });
    await put("/api/settings", { name: `card_opening_balance_cents:${card.body.id}`, value: "45000" });
    await post("/api/import", {
      filename: "store-march.csv", profile_id: card.body.id,
      rows: [{ txn_date: "2026-03-02", amount_cents: 3000, merchant: "HOME DEPOT", description: "", category_id: null, source: "import" }],
    });

    const [row] = (await api("/api/card-balances")).body;
    expect(row).toMatchObject({ opening_cents: 45000, net_cents: 3000, balance_cents: 48000 });
  });

  test("a checking statement is not a card and a card with no imports is still a card", async () => {
    await post("/api/import-profiles", { name: "Big Bank", mapping, cash_account: true });
    const fresh = await post("/api/import-profiles", { name: "New Card", mapping, cash_account: false });
    await post("/api/import", {
      filename: "bank.csv", profile_id: null,
      rows: [{ txn_date: "2026-03-02", amount_cents: 9900, merchant: "RENT", description: "", category_id: null, source: "import" }],
    });

    const body = (await api("/api/card-balances")).body;
    expect(body).toHaveLength(1);
    // Zero, not absent: a card you have set up and not imported yet is a card
    // whose balance you have not been told, and saying nothing hides it.
    expect(body[0]).toMatchObject({
      name: "New Card", profile_id: fresh.body.id, net_cents: 0, balance_cents: 0,
      txn_count: 0, last_txn_date: null,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test services/api -t "card balances"`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Write the query**

In `services/api/src/store.ts`, directly after `nonCashBatchIds` (line 37), add:

```ts
/**
 * Where a card's opening balance is kept. One `settings` row per card, keyed by
 * profile id, so adding a card adds no schema and deleting one leaves a row
 * nothing reads rather than a dangling foreign key.
 *
 * Exported and handed to the client in the response, so the string format is
 * written once and the web app never builds it.
 */
export const cardOpeningKey = (profileId: number): string => `card_opening_balance_cents:${profileId}`;

export type CardBalance = {
  profile_id: number;
  name: string;
  opening_key: string;
  /** What the card owed before the first statement you imported. Typed in once. */
  opening_cents: number;
  /** Everything imported under this card since: charges positive, payments negative. */
  net_cents: number;
  balance_cents: number;
  txn_count: number;
  /** The last row imported under this card, which is how stale the number is. */
  last_txn_date: string | null;
};

/**
 * What each credit card is about to ask for.
 *
 * A card statement writes a purchase as a charge and the payment as a credit, so
 * the running sum of every row imported under that format is exactly the change
 * in the balance -- no payment rule, no cycle, no due date to keep in step. Add
 * the balance the card carried before the first statement anybody imported and
 * you have the number.
 *
 * The known ceiling is the same one the whole app runs on: this is only as
 * current as the last card statement imported, which is why `last_txn_date`
 * comes back with it. A month of charges nobody has imported is a month this
 * number does not know about, and the tile says so rather than implying the
 * card is quiet.
 *
 * `LEFT JOIN` twice so a card with no imports is a row of zeroes rather than
 * missing: a card you set up and have not imported is a card whose balance you
 * have not been told, and saying nothing about it hides it.
 */
export async function cardBalances(): Promise<CardBalance[]> {
  const found = (await sql.unsafe(
    // DATE_FORMAT because this is a raw statement: `rows()` is what coerces a
    // DATE into a YYYY-MM-DD string and nothing here goes through it.
    `SELECT p.id                                        AS profile_id,
            p.name                                      AS name,
            COALESCE(SUM(e.amount_cents), 0)            AS net_cents,
            COUNT(e.id)                                 AS txn_count,
            DATE_FORMAT(MAX(e.txn_date), '%Y-%m-%d')    AS last_txn_date
       FROM import_profiles p
       LEFT JOIN import_batches b ON b.profile_id = p.id
       LEFT JOIN expenses e       ON e.import_batch_id = b.id
      WHERE p.cash_account = FALSE
      GROUP BY p.id, p.name
      ORDER BY p.name ASC`,
  )) as { profile_id: number; name: string; net_cents: string | number; txn_count: string | number; last_txn_date: string | null }[];

  return Promise.all(
    found.map(async (r) => {
      const profile_id = Number(r.profile_id);
      // SUM over BIGINT comes back as a string on some drivers. Every other
      // money value in this app is an integer number of cents and this one is
      // not allowed to be the exception.
      const net = Number(r.net_cents) || 0;
      const opening = Number(await setting(cardOpeningKey(profile_id), "0")) || 0;
      return {
        profile_id,
        name: r.name,
        opening_key: cardOpeningKey(profile_id),
        opening_cents: opening,
        net_cents: net,
        balance_cents: opening + net,
        txn_count: Number(r.txn_count) || 0,
        last_txn_date: r.last_txn_date,
      };
    }),
  );
}
```

- [ ] **Step 4: Add the route**

In `services/api/src/computed.ts`, immediately after the `/cash-position`
handler's closing `})`, add:

```ts
  /**
   * What each card will ask for, beside the cash position it qualifies.
   *
   * The cash position deliberately leaves a card charge out: it is spending on
   * the day it happened and it is not money out of checking until the card is
   * paid. That is right, and on its own it is half an answer -- the money is
   * still owed. This is the other half.
   */
  .get("/card-balances", () => store.cardBalances())
```

- [ ] **Step 5: Run the API suite**

Run: `bun test services/api`
Expected: PASS, all three new tests included.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/store.ts services/api/src/computed.ts services/api/test/api.test.ts
git commit -m "The card statement already told you what the card will ask for"
```

---

### Task 2: The dashboard says it out loud

**Files:**
- Create: `apps/web/src/components/app/card-balances.tsx`
- Modify: `apps/web/src/pages/Dashboard.tsx`

**Interfaces:**
- Consumes: `GET /api/card-balances` through Eden, so every field is typed from
  the server's own route type. Reuses `BalanceTile`
  (`apps/web/src/components/app/balance-tile.tsx`) unchanged, handing it
  `opening_key` from the response.
- Produces: `export function CardBalances(): JSX.Element | null` — renders
  nothing when no card format exists.

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/app/card-balances.tsx`:

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatTile } from "@/components/app/stat-tile";
import { BalanceTile } from "@/components/app/balance-tile";
import { eden, useApi } from "@/lib/api";
import { dateLabel } from "@/lib/format";

/**
 * What the cards are about to ask for.
 *
 * The cash position leaves a card charge out on purpose -- it has not left
 * checking yet -- which is right and is half an answer. The money is still owed,
 * and this is where that half goes: beside the balance it qualifies, not on a
 * page of its own.
 *
 * Nothing at all when no import format is marked as a card, because a household
 * with one checking account should not be shown an empty card section forever.
 */
export function CardBalances() {
  const cards = useApi(["card-balances"], () => eden.api["card-balances"].get());
  const rows = cards.data ?? [];
  if (rows.length === 0) return null;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Owed on cards</CardTitle>
        <CardDescription>
          Charges minus payments, from the statements imported under each card format. As current as the last
          statement you imported and no more, which is what the date beside each one is for.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((c) => (
          <div key={c.profile_id} className="flex flex-col gap-2">
            <StatTile
              label={c.name}
              cents={c.balance_cents}
              tone={c.balance_cents > 0 ? "neutral" : "muted"}
              caption={
                c.txn_count === 0
                  ? "No statement imported yet"
                  : `${c.txn_count} row${c.txn_count === 1 ? "" : "s"} through ${dateLabel(c.last_txn_date!)}`
              }
            />
            <BalanceTile
              settingKey={c.opening_key}
              label={`${c.name} opening balance`}
              caption="What the card owed before your first import."
              editCaption="What the card owed before the first statement you imported."
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
```

`dateLabel` is `apps/web/src/lib/format.ts:38`. `StatTile`'s tones are
`"neutral" | "good" | "critical" | "muted"` and a balance owed is neither good
nor an error, so it takes the plain one and the caption carries the meaning.

- [ ] **Step 2: Render it on the dashboard**

In `apps/web/src/pages/Dashboard.tsx`, add the import beside the existing
`BalanceTile` import on line 13:

```tsx
import { CardBalances } from "@/components/app/card-balances";
```

and place `<CardBalances />` directly after the block that contains the
`<BalanceTile settingKey="checking_balance_cents" ... />` tile, so the money owed
sits under the money you have.

- [ ] **Step 3: Typecheck and lint**

Run: `bun run typecheck && bun run --cwd apps/web lint`
Expected: PASS. A failure naming `card-balances` means Task 1's route is not
merged: this page's types come from the server's route type.

- [ ] **Step 4: Look at it with real data**

```bash
bun run demo --reset
bun run dev
```
Open http://localhost:5173. If the demo ships no card format, add one in
Settings -> Import formats with **spending leaves checking** off, import a
statement under it, and confirm the tile appears and the opening balance saves.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app/card-balances.tsx apps/web/src/pages/Dashboard.tsx
git commit -m "Money you have, and money you owe, one under the other"
```

---

### Task 3: Write down the ceiling

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Extend the `README.md` section that already explains the boolean**

Under "How the pieces work", append to the **Which statement a charge came from**
paragraph:

```markdown
That boolean now answers a second question. A card statement writes purchases as
charges and the payment as a credit, so the running sum of everything imported
under a card format is the change in what the card is owed. Type in what the card
owed before your first import and the dashboard says what it will ask for, beside
the checking balance it deliberately leaves out of.

It is exactly as current as the last card statement you imported, so the tile
prints that date. A month of charges nobody has imported is a month this number
does not know about, and it is better to see the date than to read a stale
balance as a quiet card.
```

Under "Known limits":

```markdown
- A card balance is derived from the statements imported under that card format.
  Import the checking statement and not the card's, and the payment is visible
  while the charges it paid for are not.
```

- [ ] **Step 2: Add the trap to `CLAUDE.md`**

Under "Traps that already bit and are pinned by tests":

```markdown
- **`cardBalances` sums every row under a non-cash profile, sign and all.** A
  card statement's payment row is a credit, which is why no payment pattern and
  no billing cycle is needed. It is a raw `sql.unsafe` SELECT, so it says
  `DATE_FORMAT(MAX(e.txn_date),'%Y-%m-%d')` itself and coerces `SUM()` with
  `Number()` -- a BIGINT sum arrives as a string on some drivers. The opening
  balance lives in `settings` under `cardOpeningKey(profileId)`, and that string
  is built in one place and handed to the client as `opening_key`.
```

- [ ] **Step 3: Full gate lane**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit and push**

```bash
git add README.md CLAUDE.md
git commit -m "Say how stale the card balance is allowed to be"
git push
```

**Restart after merging:** restart the API (`bun run api`). No migration, so no
database work. The web app needs no restart in dev.

---

## Self-Review

**Spec coverage.** Derived running sum (Task 1). Per-card hand-typed opening
balance in `settings`, edited where it is read (Tasks 1, 2). Staleness stated
(Tasks 1, 2, 3). Cards with no imports still visible (Task 1, third test). Docs
(Task 3).

**Placeholders.** None. Every component prop used here was checked against its
definition: `StatTile` (`label`, `cents`, `tone`, `caption`, `children`),
`BalanceTile` (`settingKey`, `label`, `caption`, `editCaption`) and `dateLabel`.

**Type consistency.** `cardOpeningKey` is defined once in `store.ts`, asserted
in Task 1's first test, and reaches the client as `opening_key`, which Task 2
passes to `BalanceTile`'s `settingKey` prop. `CardBalance.balance_cents` is
`opening_cents + net_cents` in the implementation and is asserted as that in
Task 1's second test.

**Known interaction with another plan.** `transaction-splits` hides split parents
from expense reads; the query in Task 1 Step 3 sums `expenses` directly and would
count a split parent *and* its children. That is fixed by the splits plan's
Task 7 Step 4, not here. See `2026-09-10-README.md`.
