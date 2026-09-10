#!/usr/bin/env bun
/**
 * Empties the ledger and leaves the database seeded, for starting over on real
 * data after a run of demo or test imports.
 *
 * Run:  bun run reset                    -> counts every table and deletes nothing
 *       bun run reset --yes              -> backs up first, then wipes and re-seeds
 *       bun run reset --yes --no-rules   -> categories only, no merchant rules
 *
 * Dry by default because this is the one script in the repo that destroys data
 * a person cannot get back except from the backup it takes on the way past.
 */
import { sql } from "@lumpy/db";
import { seed } from "@lumpy/db/seed";
import { TABLES } from "@lumpy/db/tables";

/**
 * Every table the app writes, taken from the spec rather than a list kept here.
 * A table added to `tables.ts` and forgotten here would survive a reset and turn
 * up as rows nobody expected in a database somebody believed was empty.
 *
 * `settings` and `_migrations` are deliberately not in it: `TABLES` does not
 * carry either. Truncating `_migrations` would tell `migrate` that
 * `001_init.sql` never ran, against a schema that is already there.
 */
export const wipeOrder = (): string[] => Object.keys(TABLES);

/**
 * Balances somebody typed in, zeroed rather than deleted. `settings` is a
 * key/value table shared with the migrations, and the row for the lumpy opening
 * balance is inserted by `001_init.sql` -- deleting it would leave the column
 * that reads it looking at nothing.
 */
export const ZEROED_SETTINGS = ["lumpy_opening_balance_cents", "checking_balance_cents"];

/**
 * Settings keyed by a row id, deleted rather than zeroed. A card's opening
 * balance is `card_opening_balance_cents:<profile id>` (`cardOpeningKey` in
 * services/api/src/store.ts), and the TRUNCATE below starts those ids over: a key
 * left behind would be read as the opening balance of the first card created
 * after the reset, a number nobody typed for it. reset.test.ts holds this string
 * to the store's.
 */
export const DELETED_SETTING_PREFIXES = ["card_opening_balance_cents:"];

/**
 * Refuses any database whose name ends in `_test`. The API suite migrates and
 * truncates `lumpy_budget_test` on every test, so a `--yes` typed against the
 * wrong DATABASE_URL would race a running suite rather than do anything useful.
 */
export const refusesDatabase = (db: string): boolean => /_test$/.test(db);

/** What is there now, so a dry run can say what a real one would delete. */
export async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of wipeOrder()) {
    const [row] = (await sql.unsafe(`SELECT COUNT(*) AS n FROM \`${t}\``)) as { n: number }[];
    out[t] = Number(row!.n);
  }
  return out;
}

/**
 * TRUNCATE rather than DELETE, so the auto-increment ids start over too: a fresh
 * database should not hand out id 1591 for its first expense.
 *
 * ponytail: foreign keys off for the duration instead of sorting the tables into
 * dependency order. The order would be one more thing to keep true as tables are
 * added, and this runs against a database with nobody else in it.
 */
export async function wipe(): Promise<void> {
  await sql.unsafe("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const t of wipeOrder()) await sql.unsafe(`TRUNCATE TABLE \`${t}\``);
  } finally {
    await sql.unsafe("SET FOREIGN_KEY_CHECKS = 1");
  }
  await sql.unsafe(
    `UPDATE settings SET value = '0' WHERE name IN (${ZEROED_SETTINGS.map(() => "?").join(", ")})`,
    ZEROED_SETTINGS,
  );
  // LEFT rather than LIKE: an underscore in a LIKE pattern is a wildcard.
  for (const prefix of DELETED_SETTING_PREFIXES) {
    await sql.unsafe("DELETE FROM settings WHERE LEFT(name, CHAR_LENGTH(?)) = ?", [prefix, prefix]);
  }
}

if (import.meta.main) {
  const url = new URL(process.env.DATABASE_URL ?? "mysql://root@127.0.0.1:3306/lumpy_budget");
  const db = url.pathname.replace(/^\//, "");
  if (refusesDatabase(db)) {
    console.error(`refusing to reset ${db}: a database named *_test belongs to the test suite`);
    process.exit(1);
  }

  const before = await counts();
  const total = Object.values(before).reduce((a, b) => a + b, 0);
  const width = Math.max(...wipeOrder().map((t) => t.length));
  console.log(`${db} @ ${url.host}\n`);
  for (const t of wipeOrder()) console.log(`  ${t.padEnd(width)}  ${String(before[t]).padStart(6)}`);
  console.log(`  ${"total".padEnd(width)}  ${String(total).padStart(6)}\n`);

  const rules = !process.argv.includes("--no-rules");
  if (!process.argv.includes("--yes")) {
    console.log("nothing was deleted. to wipe all of it and re-seed categories and rules:\n  bun run reset --yes");
    console.log("to leave the merchant rules out and write your own:\n  bun run reset --yes --no-rules");
    await sql.end();
    process.exit(0);
  }

  // Through the existing script so there is one definition of what a backup is,
  // and its output is the path to print. A backup that did not finish means the
  // wipe does not start: that file is the only way back.
  console.log("backing up first...");
  const backup = Bun.spawn(["bun", "run", "backup"], { stdout: "inherit", stderr: "inherit" });
  if ((await backup.exited) !== 0) {
    console.error("\nbackup failed, so nothing was deleted");
    await sql.end();
    process.exit(1);
  }

  await wipe();
  await seed({ rules });
  const after = await counts();
  console.log(`\nwiped ${total} row(s) from ${db}`);
  console.log(
    rules
      ? `re-seeded ${after.categories} categories and ${after.category_rules} merchant rules`
      : `re-seeded ${after.categories} categories, no rules (--no-rules)`,
  );
  console.log("hand-kept balances zeroed, card opening balances deleted; everything else is empty");
  await sql.end();
}
