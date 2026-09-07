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

## Checks

```bash
bun run check                 # typecheck + tests + scenarios; what the commit hook runs
bun test                      # 98 tests, no network, under a second
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

## Layout

```
contracts/types.ts      zod schemas + types, imported by the API and the web app
services/budget-core/   the engine: pure functions, no DB, no HTTP, no I/O
services/db/            Bun.sql client, numbered .sql migrations, seed data
services/api/           Bun.serve routes
services/csv-import/    CSV parse / normalize / dedupe; runs in the browser too
apps/web/               Vite + React + Tailwind v4 + shadcn/ui + React Bits
scripts/demo.ts         fills a running instance through the public API
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
DB or HTTP boundary. There is a test for exactly this.

**Only discretionary spending reduces what is available.** Every category
carries a bucket. Once you import a bank statement the mortgage appears both as
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

## Charts

Colors come from the `dataviz` reference palette and were validated against this
app's own surfaces (`#ffffff` light, `#262626` dark): lightness band, chroma
floor, adjacent CVD separation and normal-vision floor all pass in both modes.
Three light-mode slots fall under 3:1 contrast, so every chart also ships its
numbers as text — a legend with values, or the breakdown table beside it. A
category keeps the same color whatever else is on screen, and past eight the
tail folds into one grey "Other" rather than repeating hues.

## Known limits

- Single user, no login. It is meant to run on localhost.
- Fixed costs are assumed monthly and roughly constant. A bill that varies (gas
  and electric) is budgeted at the amount you enter.
- Migrations are forward-only, and DDL in MySQL cannot roll back: a migration
  that fails halfway leaves the database partly changed and needs a manual fix.
