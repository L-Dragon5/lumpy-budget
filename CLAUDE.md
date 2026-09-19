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
bun run seed --no-rules          # categories without the merchant rules; --no-rules works on reset too
```

`bun test` needs MySQL running: `services/api/test/*` hits a real
`lumpy_budget_test` database (`TEST_DATABASE_URL`), migrates it, and TRUNCATEs
between tests. budget-core and csv-import tests are pure.

The hook is not installed by cloning: `git config core.hooksPath .githooks`.

## Dependency direction

`contracts` → `budget-core` → `db` → `api` → `apps/web`. Nothing points back up.
`csv-import` and `llm` are siblings hanging off `contracts` alone; neither knows
about the database. That is why `scripts/build-eval-cases.ts` lives in `scripts/`
rather than beside the fixture it writes -- it reads the live database, and
putting it inside `services/llm` would hang that package off `db`.

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
   **Start at 019.** 001-010 were squashed into `001_init.sql`; the databases
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
- **`/merge`, `/shadowed` and `/merge-candidates` sit beside `/:id` routes, and
  the order they are registered in does not matter.** Elysia 1.4.30's router
  prefers a static segment to a param whichever is registered first (checked
  both ways, GET and POST). They are grouped ahead of their `crud()` blocks for
  reading, not for correctness. What does matter is pinned by tests: that
  "merge" and "shadowed" are never read as an id. If an Elysia upgrade changes
  the precedence, those tests are what say so.
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
- **`occurrences` clamps the stream's own `starts_on`/`ends_on` onto the asked-for
  window before it walks anything**, which is the single place the app learns
  that a job pays nothing before it started. Every income number except one
  comes out of that function, so nothing else needs the check. The one is
  `monthlyNormalized`, the flat average, which walks no calendar and so takes an
  optional `month` and filters on `runsIn` instead -- overlap with the month,
  not containment, so a job starting on the 20th is that month's average in
  full. Callers that have a month pass it (`monthSummary`, `forecast` per row,
  `incomeCalendar` per month); a caller asking what the streams are worth in
  general omits it. `active` is not a substitute for `ends_on`: it is the manual
  off switch and it deletes the stream's past as well as its future.
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
- **`shadowedRules` must sort exactly the way `applyRules` does** -- priority
  ascending, ties by id -- or it reports rules that work and stays quiet about
  rules that do not. `covers` decides containment on the needles alone, which is
  sound because `applyRules` matches with `indexOf`: a haystack holding B's
  needle holds A's too. `whole_word` is the only wrinkle, and an unguaranteed
  boundary is never called a shadow -- at B's own edge the haystack picks the
  neighbouring character, and it is allowed to pick a letter. `isLetter` is
  exported from `contracts` rather than rewritten here, for the same reason
  `matchesPattern` lives there. The differential test at the bottom of
  `csv-import/test/shadow.test.ts` runs both functions over 3000 generated rule
  sets; change either one and that test is what tells you they disagree.
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
- **`import_profiles.cash_account` is read by `/cash-position` and
  `/card-balances` and nothing else.** A card charge is spending on the day it
  happened everywhere in the budget; it is not money out of checking until the
  card is paid. Filter it into another report and you start double-discounting
  real spending.
- **`cardBalances` sums every row under a non-cash profile, sign and all.** A
  card statement's payment row is a credit, which is why no payment pattern and
  no billing cycle is needed. It is a raw `sql.unsafe` SELECT, so it says
  `DATE_FORMAT(MAX(e.txn_date),'%Y-%m-%d')` itself and coerces `SUM()` with
  `Number()` -- a BIGINT sum arrives as a string on some drivers. The opening
  balance lives in `settings` under `cardOpeningKey(profileId)`, and that string
  is built in one place and handed to the client as `opening_key`.
- **A settings key built from a row id dies with the ids.** TRUNCATE restarts
  AUTO_INCREMENT, so `card_opening_balance_cents:1` survives a wipe and becomes
  the opening balance of the next card created. `wipe()` in `scripts/reset.ts`,
  `restore()` in `store.ts` and `resetDb()` in the API test setup each delete
  every key under `CARD_OPENING_PREFIX`; add another id-keyed setting and it
  needs the same three lines. They match with `LEFT(name, CHAR_LENGTH(?)) = ?`,
  not `LIKE`, because `_` in a LIKE pattern is a wildcard.
- **`categoryPace` cuts both sides at today's day of the month.** Comparing a
  full month's history to five days of spending reads as 80% under budget every
  month until the 25th. It is a median, not a mean, and it skips months with no
  transactions at all for the same reason `fixedCostVariance` does.
- **Only discretionary spending subtracts from available.** Fixed / lumpy /
  savings transactions are reconciliation; counting them twice is the bug this
  app exists to avoid.
- **`total` and the report's `"all"` are `SPENDING`, not every row.**
  `SPENDING` in `budget-core/src/reports.ts` is discretionary, fixed, lumpy and
  savings. A `transfer` is money between your own accounts (a card payment's
  charges are already counted where they happened) and `income` is money
  arriving, so neither is spending. Summed over every row, a month with a
  paycheck in it "spent" less than nothing. The buckets still carry every row,
  so asking for `transfer` or `income` by name still gets them. The scenario
  lane checks `spent.total` equals the four buckets every run, and `joe.json`
  carries a paycheck and a card payment so that check can fail.
- **`bucketOf` reads the amount, not just the category.** An uncategorized
  charge is discretionary because over-reporting spending is the safe error; an
  uncategorized *credit* inverts that argument, so it is `transfer` and neutral.
  Counted as discretionary, a paycheck imported off a checking statement paid
  back the entire month: available went up, the `categoryPace` median was taken
  over a category nobody spends in, and `cash-position` netted it out of
  spent-since. Its parameter is `Pick<Expense, "category_id" | "amount_cents">`,
  so a caller that builds a literal has to say which way the money moved.
  Pinned in `reports.test.ts` and end to end through `/summary` and
  `/cash-position`. `breakdown` labels the Uncategorized slice with
  `bucketOf` of the slice's net for the same reason.
- **`income` is a bucket, not the category named "Income".** Migration 013 moved
  the seeded row and widened the ENUM. Matching on the bucket is what survives
  somebody renaming the category, which is the whole reason it is not folded
  into `transfer`. Anything that used to skip deposits by testing for
  `transfer` now has to name `income` too: `/cash-position` does, and a test
  pins it. `totalsByBucket`, and so `money.spent` in every scenario, carries an
  `income` key.
- **`arrived` in `budget-core/src/income.ts` is the one place a credit's sign
  is flipped.** `depositedInMonth` and `uncategorizedCreditsInMonth` both go
  through it. It returns `0 - sum(...)`, not `-sum(...)`: unary minus on an
  empty month is `-0`, which JSON hides and `toBe`/`toEqual` do not. A test
  fails if it is written the other way.
- **`/income-calendar` declares `incomeCalendarResult` as its response.** The
  validator strips a key the schema does not list, so a field the route adds
  without a matching `contracts/types.ts` entry silently never reaches the page.
  A test asserts the month's full key list for that reason.
  `uncategorized_credit_cents` means `category_id` null and a negative amount,
  the same rows the expenses page counts as uncategorized. It is in neither
  `deposited_cents` nor `delta_cents`; it only explains a short month.
- **A split keeps the parent row and hides it; it does not delete it.** The
  parent holds the `dedupe_hash`, which is the only reason a re-imported
  statement is still a no-op, and `NOT_SPLIT_PARENT` in `api/src/store.ts` is
  what keeps it out of `expensesBetween` and the `/expenses` list -- the two
  reads every report funnels through. There is no `split` column: a parent is a
  row that has children, asked directly, so the flag cannot drift. Any query that
  reads expenses outside those two paths has to carry the predicate itself,
  written out against its own alias. `cardBalances` is one: its `LEFT JOIN` on
  expenses carries `NOT EXISTS (... c.parent_id = e.id)`, because a part
  inherits the batch and summing parent and parts would say the card is owed
  twice the charge. "a split card charge is counted once" pins it.
- **The import wizard proposes from `/expenses/merge-candidates`, not from the
  list.** `MERGE_TARGET` in `api/src/store.ts` (`source = 'manual' AND parent_id
  IS NULL`) is read by both that route and `absorbManual`, so the proposal and
  the server's re-check are one definition. A split charge is a candidate even
  though every other read hides it -- the bank posts the whole charge, and
  without the merge it lands again beside its parts -- and a part never is. A
  merged split charge carries the statement's date, merchant, source and batch
  down to its parts, because the parts are what `nonCashBatchIds` and deleting
  the import actually see. It is a separate route rather than a flag on
  `/expenses` so the list every page totals has no way to return a parent.
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
- **The lumpy contribution is a cash-flow answer, not a sum of per-item ones.**
  `fundPlan` in `budget-core/src/lumpy.ts` is the one place it is decided, and
  `recommendedMonthlyTotal` and `timeline`'s recommended mode both read it.
  Summing `max(steady_i, catch_up_i)` over items -- what this used to do -- tells
  every item to fund itself from scratch by its own due date and lets the balance
  be claimed only once, so the fund over-collects forever; on a real household
  that was $1,200 a year and a balance that plateaued instead of cycling. The
  floor per month is `(cumulative outflow - balance) / (k + 1)`, `k + 1` because
  a contribution lands on the 1st and bills are paid during the month, the same
  order `timeline` walks -- change one and the projection stops touching zero at
  the tight month. `Math.ceil`, not `divRound`: a contribution half a cent light
  is a fund that is short. The window ends at the last item's *next* occurrence,
  which is as far as being behind can reach. `plan()` is per item and carries no
  catch-up any more: `steady_cents` and `months_until_due`, nothing else.
  Pinned by a 1000-fund property test in `lumpy.test.ts` (the number is enough,
  and one cent less is not) and by a scenario invariant.
- **A dismissed suggestion is a `settings` row, not a table.**
  `dismissed_recurring` holds a JSON array of `merchantKey`s and is passed to
  `recurringCandidates` as `dismissedKeys`, where it joins the set that already
  suppresses tracked items. `settings.value` is VARCHAR(500), so
  `dismissRecurring` in `api/src/store.ts` drops the oldest keys to fit rather
  than failing the write -- an overflow re-proposes an old suggestion, which is
  visible. It is deleted by `wipe()` (`DELETED_SETTING_PREFIXES`) and by the API
  test's `resetDb`, because the charges it was about are what those truncate;
  `restore()` leaves it, since the key means the same merchant whatever ids the
  file carries.
- **`bun test` forces `TZ=UTC` while MySQL dates rows on the machine's clock.**
  `services/api/test/setup.ts` puts the process back on the zone from
  `/etc/localtime`, which is the zone the API really runs in. Without it, every
  test comparing a JS date to a `DATE()` off the same instant fails between 8pm
  local and midnight and passes again in the morning.
- **`fixed_balance_cents` existing is what splits the cash position in two.**
  Not a flag, not a count of profiles: a household keeps its bills somewhere it
  may never import, and one that has never heard of the split has to keep the
  single tile it has always had. So the row is deleted rather than zeroed by
  `wipe()` (`DELETED_SETTING_PREFIXES`) and by the API test's `resetDb`, or an
  emptied database claims a bills account with nothing in it, and every later
  test runs split. `DELETE /api/settings/:name` exists for the same reason: the
  web app removes the account by removing the balance.
- **`import_profiles.fixed_account` is only read when `cash_account` is true.**
  A card is neither checking account. `fixedBatchIds` puts `cash_account = TRUE`
  in its own WHERE rather than trusting the column to be false on a card, so a
  format flipped to card and back does not lose which account it was. A row with
  no batch was typed by hand and lands on the everyday account: that is the one a
  person spends against, so it is the safe place for an unknown. `cashPosition`
  takes `paysBills`, and false is the everyday account beside a bills account --
  the bills are counted once, against the account they actually leave, or the
  everyday tile calls spending money spoken for while the bill sits funded.
- **A card's balance is typed as of a day, not carried from an opening.**
  `card_balance_cents:<id>` (migration 018 deleted the `card_opening_balance_cents:`
  keys rather than renaming them -- the old value with a new as-of would have
  shown an opening balance as the whole balance). `settings.updated_at` is the
  as-of, and `cardBalances` adds rows dated **on or after** it: over-stating what
  a card is owed is the safe error, the same one `/cash-position` makes by
  including the as-of day's spending. No balance ever typed falls back to the sum
  of every imported row, which is what this was before, so migration 018 degraded
  to the old behaviour rather than to zero. A future-dated card row is counted,
  unlike in the checking tile, for the same safe-error reason.
- **A part inherits `import_batch_id` from the charge.** `nonCashBatchIds` reads
  the batch to tell a card charge from money out of checking; batchless parts
  would be counted against the checking balance forever. Same trap
  `absorbManual` already documents.
- **`POST /api/classify` proposes and `POST /api/expenses/categorize` writes,
  and they are two routes on purpose.** A model that invents a category id must
  not be able to reach the ledger without a person having looked at the row.
  `readProposals` in `llm/src/classify.ts` drops an id that does not exist,
  `categorizeMerchants` in `api/src/store.ts` checks again against the
  categories it just read, and the UPDATE carries `category_id IS NULL` -- it
  only ever fills a category in, so a merchant somebody categorised between the
  proposal and the approval keeps the category a person gave it. A merchant that
  came back with no usable answer lands in `unresolved`, never silently gone.
- **`uncategorizedMerchants` groups on the merchant string and
  `categorizeMerchants` matches on it, so the collation decides both.** MySQL
  folds case and ignores trailing spaces, which makes `Kusshi` and `kusshi ` one
  row in the list *and* one UPDATE -- the two agreeing is what stops an approval
  reaching rows the list never showed. The same trap migration 008 is written
  around, pointed the useful way for once. A test pins it.
- **`GROUP_CONCAT ... SEPARATOR` takes a string literal, not a placeholder.**
  The unit separator in `uncategorizedMerchants` is spliced into the SQL as a
  constant for that reason; it is never anything a request carries. Passing it
  as a parameter is a 1064 at runtime and passes typecheck.
- **The classifier's conventions come off the ledger, not out of the prompt.**
  `store.categorizedExamples` reads what this household already filed and
  `pickExamples` thins it per category, because whether an Uber is Travel or
  Transportation is a habit, not a fact. The prompt states only what is not a
  habit: the sign rule, refund versus income, a card payment being a transfer.
  Write a household's habit into the prompt and every other household gets
  argued with.
- **`services/llm/eval/cases.json` must stay disjoint from `examples.json`.** An
  example that is also a case is a test passed by copying and a score that means
  nothing. `bun run eval:build` writes both from one deterministic split and
  prints the overlap, which must be 0. The three fixture files are gitignored --
  real merchant strings off a real ledger -- so a fresh clone builds them before
  the eval can run.
- **The eval fixture drops a merchant filed under more than one category.** It
  is ambiguous ground truth: `Bilt Rewards` is Housing on one row and Travel on
  another, so it arrives as two cases of which at most one can be right, and as
  an example it teaches the prompt a contradiction. Dropping the three in this
  ledger moved the score 93.8% -> 95.0% with no prompt change, which is what says
  it was measuring the ledger. The remaining misses are the same thing one level
  down (`DD *DOORDASH WEGMANS` is Groceries, `DD *DOORDASH HARRISTEE` is Dining);
  chasing those with prompt edits is chasing a coin flip.
- **A rule written by the categorizer is the whole merchant string, not
  `suggestRule`'s two-word head.** Approving a decision about one merchant must
  not write a needle that claims merchants nobody looked at; the broader rule is
  still one click on the expenses page, where what it catches is visible. The
  web page only offers a rule for a merchant seen more than once, because a rule
  for a one-off is a row that can never fire.
- **The static handler is mounted in `server.ts`, never in `app.ts`.** `spa()`
  (`services/api/src/static.ts`) is a `/*` wildcard, and `app.ts` is what
  `apps/web` imports as `App` for Eden: a wildcard in that type is a route the
  client can be talked into believing in. It is also why `spa()` 404s `/api/*`
  itself -- an unknown API path has to read as missing JSON, not as index.html
  with a 200 the client then fails to parse. Mounted only when `apps/web/dist`
  exists, so development is unchanged and the container serves both on one port.
  `services/api/test/static.test.ts` pins the precedence and the encoded-`..`
  guard; it needs no database, which is why it does not import `setup.ts`.

## Two lanes

Gate (`bun test`, `bun run scenarios`): deterministic, local, free, sub-second.
Scenarios are the deterministic half of the eval lane — whole households through
the engine with invariants checked every run (a month's paychecks sum to its
income, every split sums to its total).

The paid half is `bun run eval:classify`: the merchant categorizer against 80
held-out merchants and what this household actually filed, threshold 85%. Not in
`bun run check` because it costs money and calls a real model. Everything around
the model is in the gate lane -- `services/llm/test` stubs the request, so the
prompt, the answer-reading and the chunking are all free and deterministic.
