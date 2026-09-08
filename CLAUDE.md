# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `README.md` first. It documents what the app does and the domain rules
(cents-as-integers, safety-first bill assignment, catch-up lumpy math, dedupe
hashes). This file covers only what you cannot see from the README.

## Commands

```bash
bun run check                    # typecheck + bun test + scenarios; exactly what the pre-commit hook runs
bun test services/budget-core    # one package
bun test -t "largest remainder"  # one test by name
bun run scenarios                # household fixtures diffed against stored expectations
bun run scenarios:update         # accept the diff, only after reading it
bun run --cwd apps/web lint      # oxlint; not part of `check`
bun run backup                   # mysqldump to ~/lumpy-backups; run before a migration
bun run reset                    # row counts only; --yes backs up, wipes, re-seeds
```

`bun test` needs MySQL running: `services/api/test/*` hits a real
`lumpy_budget_test` database (`TEST_DATABASE_URL`), migrates it, and TRUNCATEs
between tests. budget-core and csv-import tests are pure.

The hook is not installed by cloning: `git config core.hooksPath .githooks`.

## Dependency direction

`contracts` → `budget-core` → `db` → `api` → `apps/web`. Nothing points back up.

- `contracts/types.ts` is the single source of shape. Zod schemas are used as
  Elysia body **and** response validators, so an undeclared column fails a test
  instead of leaking to the client.
- `services/budget-core` is pure: no DB, no HTTP, no `Date.now()`. All money is
  `Cents` (integers) and all dates are `YYYY-MM-DD` strings. Keep it that way —
  the scenario lane depends on it being deterministic.
- `services/api` exports its own type; `apps/web/src/lib/api.ts` consumes it
  through Eden `treaty<App>`. A renamed route or changed column surfaces as a
  web-app typecheck error, which is why `bun run typecheck` compiles both
  tsconfigs.

## Adding or changing a column

Four places, in this order, or reads silently drop it:

1. a new numbered `services/db/migrations/NNN_*.sql` (forward-only, no rollback).
   **Start at 013.** 001-010 were squashed into `001_init.sql`; the databases
   that lived through them still record 002-010 in `_migrations`, so reusing a
   number below 011 reads as history that already ran. 011 and 012 are real
   files, applied on top of `001_init.sql` on a fresh database too -- do not fold
   their columns back into 001, or a fresh database runs 011 into a duplicate
   column.
2. `services/db/src/tables.ts` — `cols` plus the right coercion list
   (`date` / `datetime` / `bool` / `num` / `json`). `rows()` builds its SELECT
   from this spec; a column absent here does not exist as far as the app is concerned.
3. `contracts/types.ts` — row schema and input schema
4. the scenario expectations, if the engine reads it (`bun run scenarios:update`)

## Traps that already bit and are pinned by tests

- **Never let a `Date` object cross the DB or HTTP boundary.** Date columns are
  selected as `DATE_FORMAT(col,'%Y-%m-%d')`; `coerce()` in `db/src/client.ts` is
  the backstop.
- **Eden's JSON reviver is deliberately off** (`apps/web/src/lib/eden-options.ts`).
  It turns date-shaped strings into `Date` while the inferred type still says
  `string`, so the compiler cannot see the lie.
- **Query params use `.optional()`, never `.default()`.** A zod default lands in
  the output type, which Eden hands the client, making an optional param
  required. Default inside the handler instead.
- **Validation failures are 422 in Elysia's shape, not 400.** The shape is
  recorded in `services/api/test/fixtures/validation-error.json` and asserted.
- **`settings` is not in `TABLES`.** It is queried by hand in `store.ts`, so the
  four-place checklist above does not apply to it. `updated_on` is computed with
  SQL `DATE()` rather than sliced off an ISO string: a TIMESTAMP written at 8pm
  local is already tomorrow in UTC, and comparing that to a DATE column drops a
  day of rows.
- **`/api/import` is the CSV statement importer; `/api/restore` is the backup
  loader.** One adds rows, the other replaces every table. The names collide in
  conversation, not in the router; do not rename either into the other.
- **The `/merge` routes are registered before their `crud()` blocks** in
  `resources.ts`. After them, `/import-profiles/:id` and `/category-rules/:id`
  would try to read "merge" as an id on any verb the two share.
- **A merged rule is keyed on `pattern.toLowerCase().trim()`**, the same needle
  `applyRules` matches on (`csv-import/src/normalize.ts:122`). Change one and
  change the other, or a merge starts writing rules that can never fire.
- **`categoryRuleInput.pattern` trims before it checks length.** Padding never
  reached the matcher, so it does not reach the column either; `"  a  "` is a
  one-character needle and a 422, not a three-character pattern.
- **`normalizeMerchant` and `merchantKey` live in `contracts` too, and for the
  same reason as `matchesPattern`.** The CSV importer hashes the normalized
  merchant to decide whether it has seen a *transaction* before; the recurring
  detector in `budget-core` groups by `merchantKey` to decide whether it has seen
  a *bill* before. `csv-import/src/normalize.ts` re-exports `normalizeMerchant`
  so `dedupeKey` reads unchanged. `merchantKey` is the first two tokens, digits
  and joining words dropped: a heuristic, and only safe because nothing is
  written from it without a person pressing Add.
- **`missing_months` on a variance row means "this bill did not post while other
  things did".** A month with no transactions at all is excluded from it and
  reported once by `monthsWithoutStatements`. They read the same in a badge and
  mean opposite things: one bill went missing, or one month never got imported.
- **`periodPace`, `cashPosition` and `recurringCandidates` all take `today` as an
  argument.** budget-core reads no clock; the web app passes `todayISO()` and the
  scenarios pass a fixed day, which is the only reason a scenario run on the 11th
  matches one run on the 3rd.
- **`matchesPattern` in `contracts/types.ts` is the one matcher.** Both the CSV
  importer (`csv-import/src/normalize.ts`) and the budgeted-versus-actual report
  (`budget-core/src/variance.ts`) call it, because a bill that reconciles has to
  be a transaction the importer would have categorised the same way. It lives in
  `contracts` because those two packages are siblings whose only shared ancestor
  is that one. It scans with `indexOf`, never a built RegExp: a pattern is user
  text and may hold metacharacters.
- **`whole_word` is a letter boundary, not a word boundary.** A digit counts as
  the end of a word, so `bp` still finds `BP1234` while passing over `BPOST`.
  Default FALSE, so no rule that already existed changed behaviour; migration
  009 turns it on for `bp` and `amc` alone, which is what their trailing space
  in the seed was reaching for. `fixed_costs.merchant_whole_word` (migration
  010) is the same switch for a bill, and 010 turns on nothing.
- **`001_init.sql` is the whole schema and keeps that name deliberately.** An
  existing database already records it as applied, so it skips the file and
  stays where it is; a fresh one gets everything in one pass. Rename it and
  every existing database tries to `CREATE TABLE` over itself.
- **The variance window ends the month *before* `through`.** A test that puts
  its decisive transaction in `through`'s own month passes whatever the matcher
  does, because the calendar excluded it. Two of these tests were written that
  way before the window was checked.
- **MySQL ignores trailing spaces when it compares strings.** `col <> TRIM(col)`
  is false for `'bp '`, so any query looking for padding compares
  `CHAR_LENGTH(col) <> CHAR_LENGTH(TRIM(col))` instead. Migration 008 is written
  that way and a test pins it.
- **A backup restores rows with the ids they were exported with** (`bulkInsert`
  in `db/src/client.ts`), which is the only reason the file's foreign keys still
  resolve. It writes the spec's columns, not the row's keys, so a column added to
  `tables.ts` without a `contracts/types.ts` entry restores as NULL and fails the
  constraint -- the same four-place checklist, one more reason.
- **The dedupe hash covers a fourth thing: which occurrence it is.**
  `dedupeKey(e, n)` appends `|#n` for n > 0 and produces the old string byte for
  byte at n = 0, which is the only reason every hash already in the database
  still belongs to its row. `dedupeKeys` numbers a whole statement in file order
  (so a re-import of the same file is still a no-op) and `freeHash` in
  `api/src/store.ts` picks the first unused index for a hand-entered row. Two
  identical coffees on one day are two transactions; refusing the second
  undercounted the one number this app protects. A manual duplicate is therefore
  a 201, not the 409 it used to be, and a test pins that.
- **`lumpy_items.merchant_pattern` is `fixed_costs.merchant_pattern`**, same
  column, same `matchesPattern`, same whole-word switch. `lumpyPayments` reads
  the *stored* `next_due_date`, not `nextDueOnOrAfter`: the stored column is the
  occurrence nobody has recorded yet, which is the whole state the feature runs
  on. Its window is capped at half a cycle so a monthly item cannot be reconciled
  by next month's charge, and recording a payment is two ordinary PUTs from the
  web app (the item, then the balance setting), not a route.
- **A merge rewrites a hand-entered row; it does not insert and delete.**
  `absorbManual` in `api/src/store.ts` gives the typed row the hash `dedupeKeys`
  produced for its statement row, which is the only reason a re-import stays a
  no-op. It runs inside the import's own transaction and before the INSERT, and
  the merged indices are filtered out of the chunks -- both halves would
  otherwise race for the same unique hash. `matchable` in
  `csv-import/src/match.ts` is asked twice on purpose: the wizard proposes with
  it and the API re-checks the pair that comes back, because a request that
  merged two unrelated rows would overwrite one with nothing left to say so. The
  batch owns the row afterwards, so deleting the import deletes it -- deliberate,
  because `nonCashBatchIds` reads the batch to tell a card charge from money out
  of checking and a batchless merged card charge would be counted against the
  checking balance forever.
- **A raw `tx.unsafe` SELECT does not go through `coerce()`.** `rows()` is what
  turns a DATE into a `YYYY-MM-DD` string; a hand-written statement gets a `Date`
  object and the next thing that slices it reads `undefined`. The one in
  `absorbManual` selects `DATE_FORMAT(txn_date,'%Y-%m-%d')` for that reason, and
  five tests caught it when it did not.
- **`import_profiles.cash_account` is read by `/cash-position` and nothing
  else.** A card charge is spending on the day it happened everywhere in the
  budget; it is not money out of checking until the card is paid. Filter it into
  another report and you start double-discounting real spending.
- **`categoryPace` cuts both sides at today's day of the month.** Comparing a
  full month's history to five days of spending reads as 80% under budget every
  month until the 25th. It is a median, not a mean, and it skips months with no
  transactions at all for the same reason `fixedCostVariance` does.
- **Only discretionary spending subtracts from available.** Fixed / lumpy /
  savings transactions are reconciliation; counting them twice is the bug this
  app exists to avoid.

## Two lanes

Gate (`bun test`, `bun run scenarios`): deterministic, local, free, sub-second.
Scenarios are the eval lane — whole households through the engine with
invariants checked every run (a month's paychecks sum to its income, every
split sums to its total). There is no model in this app, so that is the honest
equivalent of an eval suite.
