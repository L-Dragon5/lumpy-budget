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
bun run seed                  # 24 categories and ~95 merchant rules
bun run seed --no-rules       # the categories only, rules left to you
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

## Hosting it

Development stays on the host: `bun run dev` against your own MySQL, exactly as
above. `compose.yaml` is for the homelab, where a Komodo Stack clones this repo,
builds the image and runs it (see "Deploying with Komodo"). It runs the same
code with no second environment to keep in sync. Anywhere without Komodo, the
same file works by hand:

```bash
cp .env.example .env               # MYSQL_ROOT_PASSWORD and TZ are both required
docker network ls                  # find the network your proxy is on
docker compose up -d --build
docker compose logs -f app
```

Two containers: `mariadb:10.11` with a named volume, and the app. The version is
deliberate -- it is the server the tests and migrations were written against. The image builds
`apps/web/dist` and the API serves it on its own port, so there is no second
container and nothing to proxy internally -- `apps/web/src/lib/api.ts` asks
`window.location.origin`, which is already how a local `bun run build` behaves.
Migrations run on boot; they are forward-only and recorded in `_migrations`, so a
rebuild applies whatever the new image added and does nothing otherwise.

### Proving the image

```bash
scripts/docker-smoke.sh        # ~1 minute warm; builds, boots, checks, tears down
```

Eighteen checks against a real build of the image, as its own compose project on
its own port, network and volume, so it is safe to run on the server beside the
real stack: which Bun the image pulled (and a warning if it differs from the
host's, since the tests ran on that one), a fresh database gets every
migration, the app and its fallbacks serve, an encoded `..` stays inside `dist`,
the app is loopback-only, NPM's network reaches `lumpy:3001` and cannot see the
database, the app and MariaDB agree on today's date, a backup taken inside the
container restores to the same rows and prunes old dumps, and the healthcheck Komodo reads says
healthy with the database up and fails with it stopped. Run it after touching
the Dockerfile, `compose.yaml` or the Bun version, and before the server sees
the change.

The backup checks exist because the first real run failed them. Every backup
failed: Debian's MariaDB 11.8 client demands TLS by default and `mariadb:10.11`
has none, so the dump the Stack's `pre_deploy` takes would have blocked every
deploy. The image turns that default off; the traffic never leaves the stack's
private network.

### Behind Nginx Proxy Manager

The app joins the proxy's own Docker network (`PROXY_NETWORK`, default `proxy`)
under the alias **`lumpy`**, and publishes nothing but a loopback port for
curling it on the server. In NPM, add a proxy host:

| Field | Value |
| --- | --- |
| Domain Names | whatever you are serving it as |
| Scheme | `http` |
| Forward Hostname / IP | `lumpy` |
| Forward Port | `3001` |
| Websockets Support | off, nothing here uses them |
| SSL | request a cert, and force it |

The alias is per stack and deliberate. Convert a second app this way and its
service will also be called `app`; two containers answering to `app` on one
network is a proxy that round-robins between unrelated sites. `internal` is a
second network holding only the database, which the proxy therefore cannot see.

**Put an NPM Access List in front of it.** This app has no login (see Known
limits), so the proxy is the only thing between the internet and your ledger.
Basic auth, or an allow-list of LAN ranges, or don't give it a public DNS name at
all.

**`TZ` is not optional and must not be UTC unless you are.** MySQL dates rows on
its own clock and the app compares those dates against its local today, so a UTC
container files anything entered after 8pm under tomorrow. Compose refuses to
start without it rather than guessing. The same value goes to both containers.

### Getting at the database

Containerised is not walled off. Four ways in, roughly in the order you will want
them. Run them from the Stack's directory on the server,
`/etc/komodo/stacks/lumpy-budget`, which is where Komodo keeps its clone, its
`.env` and `./backups`; `export $(grep MYSQL_ROOT_PASSWORD .env)` puts the
password in your shell:

```bash
# 1. A SQL prompt, no ports, no client to install.
docker compose exec db mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" lumpy_budget

# 2. A real backup. The app image carries mysqldump and $HOME/lumpy-backups is
#    mounted at ./backups, so the file lands outside the container.
docker compose exec app bun run backup     # -> ./backups/lumpy_budget-<stamp>.sql

# 3. Restore one, or any .sql file, over the running database.
docker compose exec -T db mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" < backups/<file>.sql

# 4. A query's rows, tab-separated, without leaving the shell.
docker compose exec db mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" -B -e \
  "select * from expenses order by txn_date desc limit 50" lumpy_budget
```

For a GUI -- TablePlus, DBeaver, Sequel Ace -- the database publishes
`127.0.0.1:3307` on the server, loopback only. From your laptop, tunnel to it
over SSH and point the client at localhost:

```bash
ssh -N -L 3307:127.0.0.1:3307 you@homelab       # leave it running
# then connect to 127.0.0.1:3307, user root, database lumpy_budget
```

That is the honest answer for editing rows by hand, and it is the same client you
already use against the dev database. Three things to know before you do:

- **Money is integer cents and dates are `DATE` strings.** `12.34` in
  `amount_cents` is twelve cents, silently. A charge is positive, a credit is
  negative.
- **`expenses.dedupe_hash` is load-bearing.** It is what makes re-importing the
  same statement a no-op. Change an amount, a date or a merchant by hand and the
  hash no longer describes the row, so the next import of that statement adds it
  again. Editing through the app recomputes it; editing in SQL does not.
- **A split charge is a parent row plus children** (`parent_id`), and the parent
  is hidden from every report rather than deleted. Deleting a parent by hand
  orphans its parts.

`/api/export` and `/api/restore` are the other route: whole-database JSON,
readable, and `restore` puts the rows back with the ids they were exported with.
See "Moving data between environments".

**The data lives in the `dbdata` volume, not in the container.** `docker compose
down` and a rebuild keep it; `docker compose down -v` deletes it, and that is the
one command in this file that can lose your ledger.

### Deploying with Komodo

Komodo clones this repo onto the server, writes `.env` from the Stack's
Environment field (`env_file_path`, default `.env`), builds, and runs `docker
compose up`. The Stack settings that matter:

| Setting | Value | Why |
| --- | --- | --- |
| Repo | `L-Dragon5/lumpy-budget`, branch `main` | |
| `git_account` | empty | the repo is public; a private one needs a token here -- Komodo clones over HTTPS, not with an SSH deploy key |
| `project_name` | `lumpy-budget` | the volume is `<project>_dbdata`. Empty means the Stack's name, so renaming the Stack would start an empty database beside your ledger |
| Environment | `MYSQL_ROOT_PASSWORD`, `TZ`, `PROXY_NETWORK` | the first two are required by `compose.yaml`; the last names NPM's network |
| `run_build` | **on** | off by default. The image is built from source, so without it a redeploy runs `up` on the old image and changes nothing, silently |
| `reclone` | **off** (default) | off means `git pull`. On deletes the folder every deploy, and `./backups` with it |
| `pre_deploy` | the backup below | migrations run on boot and are forward-only, so the dump is the only way back |
| `post_deploy` | `docker image prune -f` | every build leaves the previous image behind until the disk notices |

```sh
[ -z "$(docker compose -p lumpy-budget ps --status running -q app)" ] || docker compose -p lumpy-budget exec -T app bun run backup
```

Komodo runs `pre_deploy` before it builds, and a command that fails ends the
deploy there (`bin/periphery/src/api/compose.rs` in Komodo's source), so a
backup that cannot finish means nothing is rebuilt and no migration runs. It
backs up on every deploy, not only on a migration: a dump is seconds, and
knowing which deploys carry one would take a diff Komodo does not hand the
command. The guard skips the dump when no app container is *running*: on the very
first deploy there is none, and after a deploy that left the app crash-looping
the container is `restarting`, where `exec` fails. Without `--status running` that
failure would end every later deploy too, including the push that fixes it --
and the deploy that broke it already took its dump. The dumps land in
`/etc/komodo/stacks/lumpy-budget/backups`, and each one prunes the folder (see
"Backing up").

**Deployed means healthy, not started.** Komodo reports a deploy done once the
containers start, and a crash-looping app is started over and over. The
`healthcheck` in `compose.yaml` asks `/api/categories`, a request that needs the
database, so a deploy that did not take shows the container as unhealthy in the
Stack's view within about a minute of starting. Look there after a deploy, or on
the server:

```bash
docker inspect -f '{{.State.Health.Status}}' lumpy-budget-app-1    # healthy
```

**A push reaches the server through a scheduled Action, not a webhook.** Komodo
here is on the LAN only, so GitHub has no way to call it, and nothing should be
opened up so that it can. The server asks instead: an Action that compares the
commit Komodo last deployed with the one on `main`, on a schedule of `Every 5
minutes`:

```ts
// Komodo > Actions > deploy-lumpy-budget
const stack = "lumpy-budget";
await komodo.write("RefreshStackCache", { stack });
const { info } = await komodo.read("GetStack", { stack });
if (info.latest_hash && info.latest_hash !== info.deployed_hash) {
  console.log(`deploying ${info.deployed_hash} -> ${info.latest_hash}`);
  await komodo.execute_and_poll("DeployStack", { stack });
}
```

Set **`schedule_alert` off** on it and leave `failure_alert` on: the first
defaults to true and would alert on every tick, which is 288 alerts a day that
say nothing happened.

It compares commits on purpose. `DeployStackIfChanged`, the built-in that looks
like this job, diffs the compose file and any `config_files` against what was
last deployed (`resolve_deploy_if_changed_action` in Komodo's
`bin/core/src/api/execute/stack.rs`). This stack builds from source, so a push
that changes code and not `compose.yaml` reads to it as "no changes detected"
and never deploys. A plain `DeployStack` on the schedule would work, but it
takes a `pre_deploy` dump every five minutes. The Action takes one per push.

`deployed_hash` only moves when a deploy succeeds, so a push that fails to build
or whose backup fails is retried every tick until it deploys or the next push
replaces it. `failure_alert` is what tells you; the Stack's update log says why.

**A nightly Action backs up whether or not anything was pushed.** A dump per
deploy protects migrations; it does nothing for a fortnight of typing between
pushes. Same pattern, schedule `Every day at 03:00`, `schedule_alert` off,
`failure_alert` on:

```ts
// Komodo > Actions > backup-lumpy-budget
let code = "";
await komodo.execute_stack_service_terminal(
  {
    stack: "lumpy-budget",
    service: "app",
    terminal: "nightly-backup",
    command: "bun run backup",
    // Always: a deploy replaces the container, and a terminal kept from the old
    // one would be talking to a container that no longer exists.
    init: { command: "sh", recreate: "Always" },
  },
  { onLine: (line) => console.log(line), onFinish: (c) => { code = c.trim(); } },
);
// A terminal reports its exit code rather than throwing, so a failed dump has to
// be turned into a failed Action here, or failure_alert never hears of it.
if (code !== "0") throw new Error(`backup exited ${code}`);
```

**Change `.env` in the Stack's Environment field, never `compose.yaml` on the
server.** Komodo rewrites `.env` on every deploy, so a hand edit to it lasts until
the next one. `compose.yaml` is tracked, and Komodo's pull starts with `git checkout -f`
(`lib/git/src/pull.rs`), which throws a local edit away without a word. A change
to the file is a commit.

Doing it by hand, on a machine without Komodo, is `git pull && docker compose up
-d --build`, after a `docker compose exec app bun run backup` if the pull carries
a migration. Without `--build` the old image is reused and the pull deploys
nothing, silently. Build on the server either way, so the image matches its
architecture and no registry is involved -- `bun.lock` is tracked and the build
is `--frozen-lockfile`, so it resolves the tree that was tested here.

The database also publishes `127.0.0.1:3307` for the case where you would rather
develop against it than a local install: point `DATABASE_URL` at
`mysql://root:<password>@127.0.0.1:3307/lumpy_budget`. `bun test` still wants its
own server, and `bun run check` is a host command either way.

## Starting over

When the demo data or a run of test imports has to go and the real statements
are about to come in:

```bash
bun run reset                 # counts every table, deletes nothing
bun run reset --yes           # backs up, wipes, re-seeds categories and rules
bun run reset --yes --no-rules  # categories only, no merchant rules
```

Dry by default: the bare command prints a row count per table and exits, so the
destructive spelling is one you have to type on purpose. `--yes` takes a full
`bun run backup` first and stops without deleting anything if that dump does not
finish, because the file is the only way back.

It truncates every table in `services/db/src/tables.ts`, which is why a table
added there cannot be quietly left behind, and truncates rather than deletes so
the first expense in the fresh database is id 1. `_migrations` is left alone --
emptying it would tell `migrate` to run `001_init.sql` against a schema that is
already there -- and `settings` is zeroed rather than dropped, because the lumpy
opening balance row is inserted by that migration and the reports read it. The
exception is each card's balance, which is deleted: it is keyed by the card
format's id, the truncate hands that id out again, and the first card set up
afterwards would open with a balance somebody typed for another one. The bills
account's balance is deleted for a different reason -- the row existing at all is
what says this household has a second checking account, so a zero would be an
empty bills account rather than no bills account. A
database whose name ends in `_test` is refused outright: that one belongs to the
test suite, which truncates it on every test.

`--no-rules` on either command leaves out the ~95 merchant rules and keeps the
24 categories. The rules are guesses about which merchant means which category:
useful on day one, and wrong for anybody whose bank writes different descriptors
or who would rather build them from what actually shows up on their statements.
The categories are the buckets everything else references, so those always land.
`bun run seed` later fills the rules in without duplicating a category.

Not to be confused with `bun run demo --reset`, which deletes the demo household
and its import batches through the running API and leaves your categories, rules
and hand-entered expenses where they are.

## Backing up

Everything lives in one MySQL database on one machine, and months of hand-entered
setup is not something the CSV importer can put back.

```bash
bun run backup                # ~/lumpy-backups/lumpy_budget-<timestamp>.sql, then prune
bun run backup /path/out.sql  # somewhere else, and nothing is pruned
```

**A default-path backup prunes the folder after it succeeds**: a dump older
than 30 days goes, unless it is one of the newest seven. By age rather than by
count, because the deploy Action retries a failed deploy every five minutes and
dumps each time -- "keep the last 30" would let one bad afternoon push out every
backup older than two and a half hours. By age, a burst costs disk (a dump is a
few hundred KB) and never history. Only files named the way the script names
them are candidates, so a dump you named yourself, or anything else in the
folder, is never touched; the age comes from the name, not the file's mtime,
which a copy resets. A failed dump prunes nothing, so it cannot cost you the last
good one. `toPrune` in `scripts/backup.ts` is the whole rule.

The dumps sit on the same disk as the database. That covers a bad migration or a
bad afternoon of edits, not a dead disk -- copy the folder somewhere else for
that.

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
at the right record on the other side. Settings are written over rather than
replaced, except the card balances: those hang off an import format's id, so they
are replaced along with the formats, and the file's come back with them. A
backup carries a setting's value and not the day it was typed, so a restored card
balance reads as having been typed on the day of the restore.

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
bun test                      # 449 tests, no network, under a second
bun run scenarios             # whole-household fixtures, diffed against expectations
bun run scenarios:update      # accept a change, after reading the diff
bun run eval:build            # build the fixture from this database (gitignored)
bun run eval:classify         # paid: the categorizer against that ground truth
```

The commit hook lives in `.githooks/pre-commit` and is wired up with
`git config core.hooksPath .githooks`.

**Gate lane** (`bun test`): pure, local, free. The engine's arithmetic, the CSV
parser, and the API against a separate `lumpy_budget_test` database.

**Scenario lane** (`bun run scenarios`): whole households run end to end through
the engine and compared to a stored expectation, with invariants checked every
run — a month's paychecks must sum to its income, every split must sum to its
total, and the forecast's first month must be the month summary, since two ways
to compute one number is one way to drift. It has already caught two real bugs.

**Eval lane** (`bun run eval:classify`): the one part of this app that is not
deterministic. The merchant categorizer is scored against what this household
actually filed -- 80 held-out merchants, threshold 85%, currently 95.0% on
`gemini-3.5-flash-lite` -- because a prompt change can pass every unit test and
still get ten points worse. The fixture is built from the live ledger and
gitignored, so `bun run eval:build` comes first on a fresh clone. Paid, so it is not in
`bun run check`; run it before shipping a prompt change. Everything around the
model is in the gate lane instead: `services/llm/test` stubs the request and
pins the plumbing.

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
                        recurring.ts finds lumpy items in imported statements,
                        forecast.ts runs the month forward, cash.ts reads the
                        balance against the next bills
services/db/            Bun.sql client, numbered .sql migrations, seed data
                        001_init.sql is the whole schema; next migration is 019
services/api/           Elysia routes; exports its own type, which Eden gives the web app
services/csv-import/    CSV parse / normalize / dedupe; runs in the browser too
services/llm/           the merchant categorizer: one HTTP call, everything else pure
                        gate tests stub the request; eval/ scores a real model
apps/web/               Vite + React + Tailwind v4 + shadcn/ui + React Bits
scripts/demo.ts         fills a running instance through the public API
scripts/backup.ts       mysqldump wrapper; the restore path the migrations do not have
scripts/build-eval-cases.ts  rebuilds services/llm/eval/ from the live database
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
its date, amount, normalized merchant, and which occurrence of those it is, so
overlapping statements insert only what is new. Imports are grouped in batches
and an import can be deleted whole.

The occurrence index is what makes two $6.50 coffees at one shop on one morning
two transactions instead of one. They are the same identity and the second used
to be dropped as a duplicate and counted as "skipped": a silent undercount of
exactly the discretionary spending this app exists to protect. The index is
assigned per statement in file order, so re-importing that same file produces the
same hashes and is still the no-op it always was, and a row typed by hand takes
the next index nobody is using rather than colliding.

**A charge you typed in before the statement arrived is merged, not duplicated.**
The hash cannot catch this one: you type "Corner Coffee" on the day you spend
it, the bank writes "SQ *CORNER COFFEE 4821" and posts it a day later, so the
date and the merchant both disagree and only the amount survives. The importer
pairs statement rows against hand-entered ones on the amount to the cent within
four days, nearest day first and strictly one-to-one, and shows every pair
before it writes anything. Confirm one and the row you typed keeps its id, its
note and the category you chose, takes the statement's date and merchant, and
takes the hash a plain import would have written for it -- so next month's
overlapping statement is a no-op again, with nothing to re-confirm.

Four days because a card authorises on the day and posts one to three business
days later, and a weekend stretches that to four. It is a good guess, never a
fact: two $12 lunches four days apart at different places pair too, which is why
the review step exists and why nothing merges without the checkbox beside it.
The pair is checked again on the server before it is written, because what
arrives is a request and a merge of two unrelated rows would overwrite one of
them with nothing left to say so.

**One charge can be more than one category.** Half the Costco run is groceries
and half is shelving. Split it and the charge gains parts: ordinary transactions
carrying the date, the merchant and the batch of the charge they came from, each
with its own category and note. The parts have to add up to the cent, checked
while you type and again on the server.

The charge itself is kept, not deleted, and simply never read again. It is
holding the dedupe hash: delete it and next month's overlapping statement
re-inserts the whole charge beside the halves you already split it into, and the
month is counted twice. Unsplit and it comes back at the amount the bank actually
charged. Unsplit asks first, because the parts' categories and notes go with
them.

A part's identity is which part it is, not its date and amount, so a $120 part of
a $180 charge can never make a genuine $120 charge at that shop that day look
like a duplicate.

A charge you typed in and split before the statement arrived still merges with
the row the bank posts, because the importer pairs the statement with the charge
you typed, not with its parts. The bank posted $180, not $120 and $60. The parts
take the statement's date, merchant and batch and keep their own amounts and
categories, so the month counts the charge once and deleting the import takes
the whole charge with it. A part is never offered as a match and the server
refuses one: a $60 statement row that happens to match a $60 part is some other
charge.

## How the pieces work

**Pay schedules.** Weekly, every two weeks, twice a month, monthly and annual
are all first class. Day `0` means the last day of the month, and a day past the
end of a short month clamps rather than rolling over — the 31st is the 30th in
April and the 28th in February. Only weekly and biweekly pay can produce an
extra-paycheck month; twice-a-month pay never does, whatever the calendar looks
like. The income page shows each month's actual against the normalized average,
so the extra paycheck reads as surplus instead of as money you quietly spend.

**When a stream ran.** A pay schedule counts backwards from its anchor as
happily as it counts forwards, so a job started in June used to pay all the way
back through January: every month before the hire date read as a paycheck that
never landed, with a red delta on the income page and a surplus of minus the
whole monthly average. `First paid` and `Last paid` are the window, both
optional, and a stream without them pays forever in both directions the way it
always did. Use `Last paid` for a job that ended rather than the Active switch,
which takes its past deposits away with it. The month a stream starts or ends
counts in full: half a flat average is a number nobody can check against a
payslip.

**Planned income, and what the bank actually deposited.** Every allocation in
this app rests on pay schedules somebody typed in once. Give a category the
`income` bucket -- the seeded `Income` category has it -- and the income page
compares each month's schedule against the deposits that really landed, so a
raise, a short cheque or a paycheck that never arrived is visible rather than
assumed. A month with no statement imported is reported as exactly that, not as
a month you were not paid.

A deposit is stored the way the importer writes it, as a credit, which is a
negative expense. Its bucket keeps it out of every spending number, and the sign
is flipped once, in `budget-core/src/income.ts`, so the page can say it out loud. A
credit nobody has categorized is kept out too: it counts as `transfer`, neutral,
until somebody says what it is, because read as discretionary a paycheck would
pay the whole month back into what is available.

**Safety first.** Bills are assigned soonest-due first. Each goes to the latest
paycheck that lands at least `lead_days` before the due date and still has room
for it. The lumpy and savings transfers are carved out of each paycheck *before*
any bill is assigned, so a small rental cheque is never handed a mortgage. When
nothing can cover a bill it is flagged rather than hidden.

**The lumpy fund.** Steady state is `amount / cycle_months`, added up: the flat
long-run cost. Catch-up is what the calendar says on top of it, and it is a cash
flow question, not a per-item one. `fundPlan` walks every occurrence from this
month to the last item's next due date and asks what constant monthly
contribution keeps the balance from ever going negative: a contribution `C` has
paid `balance + C * (k + 1)` by the end of month `k`, so each month sets a floor
of `(cumulative outflow - balance) / (k + 1)` and the answer is the largest
floor, or the flat cost when none of them is bigger. The timeline runs 12 months
and names the first month the fund would run dry.

Asked item by item and added up -- which is what this did until it was measured
against a real fund -- it over-collects and never stops. Each item was told to
fund itself from scratch by its own due date, ignoring the contributions that
arrive before then, and the balance could only be claimed once, by whatever came
due first. On one real household that was about $1,200 a year above the bills,
with a balance that climbed from $1,071 to a $3,300 plateau and never came back
down. Cash flow first, the same fund asks for the flat $449.94 and nothing more.

The page keeps those two apart. "Save each month" is the flat cost and nothing
else, so it does not swing with whichever bill happens to be badly timed this
month, and the per-item column adds up to it. Being behind is one card: the
whole hole in dollars, and the extra per month that closes it. That is a debt
with an end date, not part of what the fund costs to carry.

**Lumpy items the statements already know about.** The setup is the one job
this app cannot do for you, except that after an import the evidence is already
in the expenses table: a charge that arrived last March and again this March,
for about the same money, is an annual bill whether or not anybody wrote it
down. The lumpy fund page lists what it found -- cycle, amount, next due date,
and the category those charges already carry -- and Add opens the ordinary form
filled in. Nothing is written without a person pressing it, which is exactly
what lets the merchant matching be a heuristic here (the first two words of the
normalized merchant, so `GEICO *AUTO 8829` and `GEICO AUTO PAY 9134` are one
bill) where the variance report has to use an exact pattern. Charges a bill
already claims, items already in the fund, monthly charges, transfers and
anything under $50 are left out; so are amounts that disagree by more than half
and spacings that disagree by more than a month, because those are two things
happening at one merchant rather than one bill. A suggestion that is simply not
a bill is dismissed with the x beside Add, which silences that merchant key the
same way tracking it would; the card then says how many are ignored and one
press brings all of them back.

**The next twelve months.** The month summary run forward: what each month is
scheduled to leave free once the bills, the fund and the goals have taken their
share, which month is leanest, and whether a one-off purchase fits in one month
or has to be saved for. Deliberately plan-only -- a month that has not happened
has no transactions in it -- so an extra-paycheck month shows up as the roomiest
month in the year rather than as a number you have to work out.

**Which statement a charge came from.** A saved import format says whether
spending on it leaves the checking account when it posts. On for a bank
statement; off for a credit card, where a purchase is spending on the day it
happens but is not money out of checking until the card is paid. Only the cash
position and the card balances below read it -- every other number counts a card
purchase on the day it happened, as it always has. It is two booleans rather than
an accounts table on purpose: an import format is already the thing a statement
arrives under, and the only questions worth answering are whether a row has left
the bank yet and which of the two accounts it left.

**Two checking accounts.** A household that keeps its bills in one account and
spends out of another is asking two different questions of two different
balances: whether the bills account survives the next eleven days, and how much
of the other one is free. Pooled, both answers are wrong in the same direction --
the bills read as a claim on spending money that is already funded somewhere
else.

Add a balance for the bills account on the dashboard and the tile splits in two.
That balance existing is the whole switch: a household with one account never
sees a second tile, and deleting the balance pools them again. Bills due before
the next paycheck are then charged to the bills account and to nothing else,
counted once. Which account a charge came out of is the format it was imported
under (**Settings -> Import formats -> Bills account**); a row typed by hand has
no format and lands on the everyday account, which is the one a person spends
against and so the safe place for an unknown.

**What the cards will ask for.** A card statement writes purchases as charges and
the payment as a credit, so the sum of everything imported under a card format is
how the balance has moved. Type in what the card says it owes today -- the one
number anybody can actually check -- and everything imported since is added on
top. The tile's headline is the payoff number: what it would take to clear that
card to zero.

`settings.updated_at` is the day the balance was read, and only rows dated on or
after that day are added. On or after, not after, because over-stating what a
card is owed is the safe error in the same way the checking tile over-states what
has been spent. With no balance ever typed, the tile falls back to the running
sum of every row imported and says so: a card with statements in it is not a card
that owes nothing.

It is as current as the last thing you told it, so the tile prints both dates --
when the balance was read, and the last statement imported. A month of charges
nobody has imported is a month this number does not know about, and it is better
to see the date than to read a stale balance as a quiet card.

**What is actually in the account.** Everything else in the app is derived from
a plan; the checking balance is the one number that says whether the account
survives the next eleven days. It is typed in, like the lumpy fund's, and read
beside what the plan is about to ask of it: the bills due between today and the
next paycheck, and what is left after them. A hand-kept number goes stale, so
the tile also says how long ago it was typed and what has been recorded as spent
since -- a balance that says you are fine on the strength of a week-old fact is
worse than no balance at all.

**Am I okay right now.** Inside the current paycheck period the dashboard shows
the pace: day 3 of 9, what an even burn would have spent by now, and how far
ahead or behind that you are. Every other number in the app compares a plan to a
month that is over or a month that has not started; this is the one that arrives
while there is still something to do about it.

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

A month where a bill did not post while other things did is named on the row:
either the payment did not happen or that statement is missing. A month where
*nothing* posted is named once at the top of the card instead, because a month
nobody imported is one fact about the window rather than a fault of every bill in
it. And where a bill has run consistently over what it was entered at, the row
offers to write the real number back -- the same edit the dialog does, one click,
so the report ends in a decision instead of retyping.

Only complete months count, the current one is half billed. The average divides
by months that have a transaction, not by the length of the window: an empty month
is a statement you have not imported, not a month the gas company forgot to bill.

**Lumpy bills the statements say are already paid.** A lumpy item can name how
it posts on a statement, the same way a fixed cost can and matched by the same
code. `next_due_date` in the database is the occurrence nobody has recorded yet:
the engine rolls a passed due date forward when it reads, but the stored column
only moves when a person moves it, and the balance never moves at all. So the day
the insurance is actually paid, the fund still claims the money is sitting there
and quietly tells you to save less. The page finds the charge that proves
otherwise -- matching the pattern, landing near the due date, already imported --
and offers one button that rolls the item to its next occurrence and takes the
charge off the balance. Nothing is written until it is pressed, which is what
lets the match be a pattern rather than a proof, and the row shows what was
actually charged next to what was planned, so a bill that went up is visible in
the same glance.

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

**This month, so far.** Groceries and restaurants have no budgeted number and
never will, because nobody knows what they should cost until they have seen what
they do cost. So the target is your own history: every discretionary category
against the middle of the last three months, both sides cut at today's day of the
month. A full month's average against five days of spending would say you are 80%
under budget every month until the 25th, which is worse than saying nothing. The
median rather than the mean, so one annual car repair booked to Maintenance does
not become the number the other eleven months are judged against, and a month
nobody imported is left out rather than averaged in as a month you spent nothing.

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

Because the first match wins, a broad rule in front of a specific one makes the
specific one dead code, and nothing used to say so: `amazon` at priority 100
means `amazon fresh` at 150 never runs, and every grocery order lands in
Shopping. Settings -> Rules names every rule that can never fire and the rule
taking its traffic. A shadow inside one category is listed too and marked as
such: the answer is still right, the row is just never used.

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

Categorizing an uncategorized row by hand offers to write the rule for it: the
merchant up to its second real word, without the store number, printed on the
button so you can see what you are agreeing to. Taking the offer also runs the
new rule over everything already imported that is still uncategorized, because a
rule that only fixes next month leaves the rows that prompted it sitting there.
Nothing is offered when a rule already catches the row, and nothing is written
until the button is pressed. It is the whole answer to "should this guess the
category for me": four or five of these and the tail is gone.

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
- An uncategorized credit is neutral rather than discretionary. That is the safe
  reading, but it means a refund nobody has categorized does not yet credit the
  category it came out of. Categorize it and it does.
- The income page counts only deposits in an `income` category. A paycheck
  whose descriptor no rule knows (the seed ships `payroll`, `direct dep` and
  `dir dep`) sits uncategorized and is not counted as deposited, so its month
  still reads short. It says why: a short month that holds uncategorized
  credits shows their total under the gap, with a link to the expenses page to
  categorize them, which opens that page on the short month's uncategorized
  rows (`/expenses?month=YYYY-MM&category=none`). The app does not guess which credit is the
  missing paycheck, for the same reason `bucketOf` holds them neutral.
- A card balance is what you last typed plus the statements imported since.
  Import the checking statement and not the card's, and the payment is visible
  while the charges it paid for are not. Typing the balance off the issuer's site
  is the fix, and the tile says how many days old that number is.
- With two checking accounts, a charge is attributed by the format it was
  imported under. A bill paid out of the everyday account by mistake still counts
  against the everyday balance, which is right, but it is not flagged as a bill
  that left the wrong account.
