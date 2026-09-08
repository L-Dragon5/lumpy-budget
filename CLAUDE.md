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

1. a new numbered `services/db/migrations/NNN_*.sql` (forward-only, no rollback)
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
  in the seed was reaching for.
- **MySQL ignores trailing spaces when it compares strings.** `col <> TRIM(col)`
  is false for `'bp '`, so any query looking for padding compares
  `CHAR_LENGTH(col) <> CHAR_LENGTH(TRIM(col))` instead. Migration 008 is written
  that way and a test pins it.
- **A backup restores rows with the ids they were exported with** (`bulkInsert`
  in `db/src/client.ts`), which is the only reason the file's foreign keys still
  resolve. It writes the spec's columns, not the row's keys, so a column added to
  `tables.ts` without a `contracts/types.ts` entry restores as NULL and fails the
  constraint -- the same four-place checklist, one more reason.
- **Only discretionary spending subtracts from available.** Fixed / lumpy /
  savings transactions are reconciliation; counting them twice is the bug this
  app exists to avoid.

## Two lanes

Gate (`bun test`, `bun run scenarios`): deterministic, local, free, sub-second.
Scenarios are the eval lane — whole households through the engine with
invariants checked every run (a month's paychecks sum to its income, every
split sums to its total). There is no model in this app, so that is the honest
equivalent of an eval suite.
