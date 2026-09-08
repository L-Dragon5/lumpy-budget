/**
 * Runs against the test database, like the API tests: importing their setup is
 * what points DATABASE_URL somewhere safe and migrates it, and it has to happen
 * before ./reset pulls in @lumpy/db, which reads that variable once at load.
 */
import { expect, test } from "bun:test";
import { resetDb, sql } from "../services/api/test/setup";
import { TABLES } from "@lumpy/db/tables";

const { counts, refusesDatabase, wipe, wipeOrder, ZEROED_SETTINGS } = await import("./reset");

const rowCount = async (t: string) =>
  Number(((await sql.unsafe(`SELECT COUNT(*) AS n FROM \`${t}\``)) as { n: number }[])[0]!.n);

test("the wipe list is every table the app declares, and nothing else", () => {
  expect(new Set(wipeOrder())).toEqual(new Set(Object.keys(TABLES)));
  // The two that must survive it. `_migrations` empty would re-run 001_init.sql
  // against a schema that already exists; `settings` is shared with the
  // migrations and holds balances a person typed, so it is zeroed, not dropped.
  expect(wipeOrder()).not.toContain("_migrations");
  expect(wipeOrder()).not.toContain("settings");
});

test("a test database is refused, so a stray --yes cannot take the suite with it", () => {
  expect(refusesDatabase("lumpy_budget_test")).toBe(true);
  expect(refusesDatabase("anything_test")).toBe(true);
  expect(refusesDatabase("lumpy_budget")).toBe(false);
});

test("a wipe empties the ledger, keeps the schema, and zeroes what was typed", async () => {
  await resetDb();
  const cat = Number(
    ((await sql.unsafe(
      "INSERT INTO categories (name, bucket, icon) VALUES ('Temp', 'discretionary', 'tag') RETURNING id",
    )) as { id: number }[])[0]!.id,
  );
  await sql.unsafe(
    `INSERT INTO expenses (txn_date, amount_cents, merchant, description, category_id, source, dedupe_hash)
     VALUES ('2026-03-14', 1234, 'SHOP', '', ?, 'manual', 'reset-test-hash')`,
    [cat],
  );
  for (const name of ZEROED_SETTINGS) {
    await sql.unsafe("INSERT INTO settings (name, value) VALUES (?, '54321') ON DUPLICATE KEY UPDATE value = '54321'", [name]);
  }

  const before = await counts();
  expect(before.expenses).toBe(1);
  expect(before.categories).toBeGreaterThan(0);

  const migrationsBefore = await rowCount("_migrations");
  await wipe();

  for (const t of wipeOrder()) expect([t, await rowCount(t)]).toEqual([t, 0]);
  expect(await counts()).toEqual(Object.fromEntries(wipeOrder().map((t) => [t, 0])));

  // The schema stays applied: a wipe is not a reason to run 001_init.sql again.
  expect(await rowCount("_migrations")).toBe(migrationsBefore);

  const settings = (await sql.unsafe("SELECT name, value FROM settings")) as { name: string; value: string }[];
  for (const name of ZEROED_SETTINGS) {
    expect(settings.find((s) => s.name === name)?.value).toBe("0");
  }
});
