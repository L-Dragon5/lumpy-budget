# Lumpy Budget

A budgeting app for the two things a monthly budget hides.

**The within-month crunch.** A monthly total can look fine while rent is due
three days before you get paid. Every fixed cost here is parked on a specific
paycheck: the last one that lands in time *and* is big enough to carry it.

**The lumpy costs.** Car insurance, property taxes, registrations, domain
renewals, annual fees. They are knowable a year out and still arrive as
surprises. This app amortizes each into a monthly contribution, tells you when
you are behind, and shows a 12-month runway of what leaves the account and what
has to be sitting in it on the first of each month.

Only after both of those does it answer the question the dashboard exists for:
**what is actually free to spend.**

## Running it

Needs [Bun](https://bun.com) and a MySQL-compatible server on `127.0.0.1:3306`
(developed against MariaDB 10.11).

```bash
bun install
cp .env.example .env          # edit DATABASE_URL if yours differs
bun run migrate               # creates the database and its tables
bun run seed                  # 24 categories and ~94 merchant rules
bun run api                   # http://localhost:3001
bun run web                   # http://localhost:5173
```

`bun run dev` starts both. The web app proxies `/api` to port 3001, so it is
same-origin in development and needs no CORS.

To see it full of data without typing anything in:

```bash
bun run demo                  # a realistic household + 3 months of transactions
bun run demo --reset          # delete the existing setup first
```

Re-running it is safe: setup rows are matched by name and updated rather than
added again, and the expense dedupe hash makes the import a no-op the second
time.

## Backing up

Everything lives in one MySQL database on one machine, and months of hand-entered
setup is not something the CSV importer can put back.

```bash
bun run backup                # ~/lumpy-backups/lumpy_budget-<timestamp>.sql
bun run backup /path/out.sql  # somewhere else
```

That is a `mysqldump` with `--databases`, so the file carries its own
`CREATE DATABASE` and restores on its own: the script prints the exact `mysql`
command when it finishes. It refuses to call a dump a success unless mysqldump
signed it off, because an exit code of 0 and a plausible file size are not proof
the thing restores.

## Moving data between environments

**Settings -> Download a backup** writes every table as one JSON file, named and
marked as an attachment by the server, so it is a plain link with no JavaScript
behind it. **Settings -> Restore a backup** loads that file back, here or into a
different database: build a household on your laptop, export, restore it on the
machine that actually runs it.

A restore replaces, it does not merge. The file becomes the new contents of every
table it covers, and a table it omits comes back empty, so a partial file
(categories and rules, no expenses) is a legitimate thing to hand someone. The
whole thing runs in one transaction: a file the validator rejects, or one the
database rejects, leaves what is already there untouched. Rows keep the ids they
were exported with, which is what makes every foreign key in the file still point
at the right record on the other side.

The API is the same pair: `GET /api/export` and `POST /api/restore`. Called
`/restore` rather than `/import` because `/api/import` is the CSV statement
importer, which adds rows; this one replaces them.

```bash
curl -s localhost:3001/api/export -o backup.json
curl -X POST localhost:3001/api/restore -H 'Content-Type: application/json' \
  --data-binary @backup.json
```

`mysqldump` and the JSON are for different jobs. The `.sql` carries the schema
and is how you get *this* database back; the JSON carries the data the app knows
about and is how you get it into *another* one.

### Taking only the formats or the rules

Replacing everything is the wrong move when the destination already has a year of
spending on it and you only want the column mapping you worked out for a bank.
**Settings -> Import formats -> Add from a backup** takes the same file and reads
only `tables.import_profiles` from it. Nothing is deleted: a format whose name you
already have gets its mapping updated in place, the rest are added, and the file's
ids are dropped, because id 1 already means something here.

```bash
curl -X POST localhost:3001/api/import-profiles/merge \
  -H 'Content-Type: application/json' --data-binary @backup.json
# -> {"added":["Airline Card"],"updated":["Big Bank"]}
```

Everything outside `tables.import_profiles` is stripped before validation, so a
file whose expenses are malformed still merges its formats. A merge is one
transaction too: a bad mapping is a 422 naming the field, and a file that lists
the same profile twice is a 409, and neither leaves half a merge behind.

**Settings -> Rules -> Add from a backup** does the same for categorization
rules, with the one complication a rule brings: it points at a category, and the
file's category ids mean nothing here. The file's categories ride along as an
`id -> name` lookup, each rule is re-pointed at the local category wearing that
name, and a rule whose category you do not have comes back in `skipped` rather
than taking the other forty down with it.

```bash
curl -X POST localhost:3001/api/category-rules/merge \
  -H 'Content-Type: application/json' --data-binary @backup.json
# -> {"added":["farm stand"],"updated":["wegmans"],
#     "skipped":[{"pattern":"alpaca feed","category":"Livestock"}]}
```

Rules are matched on `pattern.toLowerCase().trim()`, which is what `applyRules`
matches on: two rules that reduce to the same needle can never both fire, so that
is the engine's own notion of one rule. Merging the same file twice is the same
database. Patterns are stored trimmed, by that route and by the ordinary editor
both, since the padding never reached the matcher anyway.

Both are their own route rather than a flag on `/restore`, because one replaces
everything and the other replaces nothing, and a flag that flips between those is
a flag somebody gets wrong.

## Checks

```bash
bun run check                 # typecheck + tests + scenarios; what the commit hook runs
bun test                      # 198 tests, no network, under a second
bun run scenarios             # whole-household fixtures, diffed against expectations
bun run scenarios:update      # accept a change, after reading the diff
```

The commit hook lives in `.githooks/pre-commit` and is wired up with
`git config core.hooksPath .githooks`.

**Gate lane** (`bun test`): pure, local, free. The engine's arithmetic, the CSV
parser, and the API against a separate `lumpy_budget_test` database.

**Scenario lane** (`bun run scenarios`): whole households run end to end through
the engine and compared to a stored expectation, with invariants checked every
run — a month's paychecks must sum to its income, and every split must sum to
its total. There is no model in this app, so a prompt-eval suite would be
theater; this is the honest equivalent, and it has already caught two real bugs.

## Talking to the API

Every write is checked against the zod schema in `contracts/types.ts`, and every
read is checked against it on the way out, so a column the contract does not
describe cannot reach the client unannounced.

A bad request is a **422** in Elysia's own shape, not a 400. `errors[]` is the
part worth reading; `path` is an array, one segment per level:

```jsonc
{
  "type": "validation",
  "on": "body",              // or "query", or "response" if the server broke its own contract
  "property": "name",
  "message": "String must contain at least 1 character(s)",
  "errors": [{ "path": ["name"], "message": "String must contain at least 1 character(s)" }]
}
```

A recorded copy lives in `services/api/test/fixtures/validation-error.json` and
is asserted, so an Elysia upgrade that moves this shape fails a test rather than
the error toast that renders it.

Other statuses worth knowing: **409** for a duplicate or a row something else
still references, **405** on writes to `import-batches` (the importer owns it),
**404** for an unknown id. CORS is restricted to localhost on any port, which
only matters if you point a browser straight at port 3001 -- the app itself goes
through the Vite proxy and is same-origin.

## Layout

```
contracts/types.ts      zod schemas + types, imported by the API and the web app
services/budget-core/   the engine: pure functions, no DB, no HTTP, no I/O
services/db/            Bun.sql client, numbered .sql migrations, seed data
                        001_init.sql is the whole schema; next migration is 011
services/api/           Elysia routes; exports its own type, which Eden gives the web app
services/csv-import/    CSV parse / normalize / dedupe; runs in the browser too
apps/web/               Vite + React + Tailwind v4 + shadcn/ui + React Bits
scripts/demo.ts         fills a running instance through the public API
scripts/backup.ts       mysqldump wrapper; the restore path the migrations do not have
```

Each service has its own tests and no shared mutable state, so two sessions can
work in two of them without colliding.

## The rules that keep it correct

**Money is always an integer number of cents.** No floats, no `DECIMAL` (which
MySQL hands back as a string and invites parse bugs). Splitting a contribution
across paychecks uses largest-remainder allocation, so the parts sum to exactly
the total and a penny is never lost.

**Dates are always `YYYY-MM-DD` strings**, with arithmetic on UTC internals. A
`DATE` column read normally comes back as a `Date` at local midnight —
`2026-03-15` arrives as `2026-03-15T04:00:00.000Z` — so every date column is
selected as `DATE_FORMAT(col,'%Y-%m-%d')` and no `Date` object ever crosses the
DB or HTTP boundary. A `TIMESTAMP` keeps its time, so it becomes a full ISO
string instead. There is a test for exactly this.

The HTTP client has the same trap on the other side: Eden's JSON reviver turns
any date-shaped string back into a `Date` by default, and the inferred type
still says `string`, so the compiler cannot see the lie. It is switched off in
`apps/web/src/lib/eden-options.ts` and pinned by a test.

**Only discretionary spending reduces what is available.** Every category
carries a bucket (and an icon, so a fifty-row dropdown is scannable instead of a
wall of similar-length words). Once you import a bank statement the mortgage appears both as
a planned fixed cost and as a real transaction; subtracting both would double
count it. Fixed, lumpy and savings transactions are reconciliation, never a
second subtraction.

**A re-imported statement is a no-op.** Every expense carries a unique hash of
its date, amount and normalized merchant, so overlapping statements insert only
what is new. Imports are grouped in batches and an import can be deleted whole.

## How the pieces work

**Pay schedules.** Weekly, every two weeks, twice a month, monthly and annual
are all first class. Day `0` means the last day of the month, and a day past the
end of a short month clamps rather than rolling over — the 31st is the 30th in
April and the 28th in February. Only weekly and biweekly pay can produce an
extra-paycheck month; twice-a-month pay never does, whatever the calendar looks
like. The income page shows each month's actual against the normalized average,
so the extra paycheck reads as surplus instead of as money you quietly spend.

**Safety first.** Bills are assigned soonest-due first. Each goes to the latest
paycheck that lands at least `lead_days` before the due date and still has room
for it. The lumpy and savings transfers are carved out of each paycheck *before*
any bill is assigned, so a small rental cheque is never handed a mortgage. When
nothing can cover a bill it is flagged rather than hidden.

**The lumpy fund.** Steady state is `amount / cycle_months`. Catch-up is the
honest number right now: a $1,200 annual bill due in three months needs $400 a
month, not $100, because you did not start saving for it a year ago. Money
already in the account is claimed by whatever comes due first. The timeline runs
12 months and names the first month the fund would run dry.

**Budgeted, and what it really cost.** A fixed cost is one flat number, which is
right for rent and wrong for gas and electric. Tell a bill how it posts on a
statement ("NATIONAL GRID", any part of the name, matched the same way the
importer matches its own rules) and it gets its own line: budgeted $215, actually
$253, 18% over. A bill without one is compared alongside everything else in its
category, which is honest but blunt -- four bills under one Utilities category,
three of them never imported, reads as a category miles under budget rather than
as three missing statements. A transaction claimed by a bill is not counted again
under its category, and the row names the merchants actually seen rather than the
pattern you typed, so a pattern matching the wrong thing shows up as wrong.

Only complete months count, the current one is half billed. The average divides
by months that have a transaction, not by the length of the window: an empty month
is a statement you have not imported, not a month the gas company forgot to bill.

**A hand-kept balance says when it went stale.** The lumpy fund's balance is
typed in by a person, and the schedule heals itself where the balance cannot: a
passed due date rolls forward on its own, but the day the insurance is actually
paid the balance still claims the money is sitting there, and the app quietly
tells you to save less. So `settings` records when each value last really
changed, and the tile shows what has left the lumpy bucket since. Transactions
dated ahead of today do not count, because that money has not left yet.

**Savings goals are buckets.** Each one holds its own balance and can carry its
own target. With a target it shows how far along it is — past 100% when it is
overfunded, rather than capping and pretending it is merely full — and the month
it lands in at the current rate. Without one it is open-ended and the balance is
the whole story. Balances are kept up to date by hand on the page that reads
them, not on a settings page two clicks away; the same is true of the lumpy
fund's balance.

**Available to spend**, both ways. Over the whole month, and per paycheck period
— from the day money lands until the next paycheck arrives, which is how it is
actually spent. The month can look fine while one period inside it does not.

## Importing statements

The file is parsed in the browser and posted as normalized rows: one parse, no
upload plumbing, and the server still validates everything it stores.

Columns are matched automatically and you can correct any of them. It handles
what real statements contain: quoted commas, newlines inside a field, a UTF-8
BOM, `$1,234.56`, `(12.34)` for negatives, separate debit and credit columns,
banks that write spending as negative, and `MM/DD` versus `DD/MM` (settled by
scanning the column for a value over 12, not by guessing). Rows it cannot read
are reported by line number instead of being silently dropped.

Save the column mapping under a name and next month's statement from the same
bank is one click. Categorization runs on merchant keyword rules, lowest
priority number first; anything unmatched lands in a review queue on the
expenses page.

A rule is a case-insensitive substring by default. Turn on **match as a whole
word** and it needs a non-letter on each side, so `bp` finds `BP #4021` and
`BP1234` and passes over `BPOST`. A letter boundary rather than a word boundary
on purpose: a merchant descriptor glues the store number straight onto the name,
so a digit has to count as the end of the word. It is off unless you ask for it,
because most rules want the opposite — `trader joe` has to keep finding
`TRADER JOES`, which a whole-word match would not.

A fixed cost's **shows up on the statement as** carries the same switch, matched
by the same code (`matchesPattern` in `contracts/types.ts`), because a bill that
reconciles has to be a transaction the importer would have categorised the same
way. It is worth more there than on a rule: a rule that over-matches puts a
charge in the wrong category, while a bill that over-matches quietly rewrites
what the bill costs. A $50 fuel card that also swallows one $999 charge from a
company whose name starts the same way reads as $366.67 a month. Both the category and the note are edited in place in that table
— Enter keeps the change, Escape drops it — because fixing a hundred imported
rows through a dialog is not fixing them at all.

## Charts

Colors come from the `dataviz` reference palette and were validated against this
app's own surfaces (`#ffffff` light, `#262626` dark): lightness band, chroma
floor, adjacent CVD separation and normal-vision floor all pass in both modes.
Three light-mode slots fall under 3:1 contrast, so every chart also ships its
numbers as text — a legend with values, or the breakdown table beside it — and
each category's icon sits beside its swatch, so identity never rests on hue
alone. A category keeps the same color whatever else is on screen, and past
eight the tail folds into one grey "Other" rather than repeating hues.

## Known limits

- Single user, no login. It is meant to run on localhost.
- Fixed costs are assumed monthly and roughly constant. A bill that varies (gas
  and electric) is still budgeted at the amount you enter, but the fixed costs
  page shows what it has actually cost, so the gap is visible instead of silently
  eating discretionary money. See below.
- Migrations are forward-only, and DDL in MySQL cannot roll back: a migration
  that fails halfway leaves the database partly changed and needs a manual fix.
