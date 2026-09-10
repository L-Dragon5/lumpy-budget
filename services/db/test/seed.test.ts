/**
 * Own database, set before @lumpy/db loads: the client reads DATABASE_URL once,
 * at module load. Self-contained rather than borrowing the API suite's setup,
 * because db has no business importing from a package that depends on it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "mysql://root@127.0.0.1:3306/lumpy_budget_test";

const { migrate, splitStatements } = await import("../src/migrate");
await migrate(process.env.DATABASE_URL);
const { sql } = await import("../src/client");
const { seed } = await import("../src/seed");

const count = async (t: string) =>
  Number(((await sql.unsafe(`SELECT COUNT(*) AS n FROM \`${t}\``)) as { n: number }[])[0]!.n);

const empty = async () => {
  await sql.unsafe("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of ["category_rules", "categories"]) await sql.unsafe(`TRUNCATE TABLE \`${t}\``);
  await sql.unsafe("SET FOREIGN_KEY_CHECKS = 1");
};

test("categories can be seeded without the merchant rules that come with them", async () => {
  await empty();
  const r = await seed({ rules: false });
  expect(r.addedCategories).toBeGreaterThan(0);
  expect(r.addedRules).toBe(0);
  expect(await count("categories")).toBe(r.addedCategories);
  // The point: the buckets are there to categorise against, and not one guess
  // about which merchant means which was written for you.
  expect(await count("category_rules")).toBe(0);
});

test("the rules can be added later without a second copy of every category", async () => {
  await empty();
  await seed({ rules: false });
  const categories = await count("categories");

  const second = await seed();
  expect(second.addedCategories).toBe(0);
  expect(second.addedRules).toBeGreaterThan(0);
  expect(await count("categories")).toBe(categories);
});

test("seeding twice adds nothing the second time, rules included", async () => {
  await empty();
  await seed();
  expect(await seed()).toEqual({ addedCategories: 0, addedRules: 0 });
});

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

/**
 * Migration 013 against a database seeded before it existed. The test database
 * has already applied it, so its two statements are run again here by hand:
 * both are written to be safe twice, which is also what makes this possible.
 */
const rerun013 = async () => {
  const body = readFileSync(join(import.meta.dir, "..", "migrations", "013_income_bucket.sql"), "utf8");
  for (const stmt of splitStatements(body)) await sql.unsafe(stmt);
};
const bucketOf = async (name: string) =>
  ((await sql.unsafe("SELECT bucket FROM categories WHERE name = ?", [name])) as { bucket: string }[])[0]!.bucket;

test("migration 013 moves the Income category the old seed parked under transfer", async () => {
  await empty();
  await sql.unsafe(
    `INSERT INTO categories (name, bucket, icon) VALUES
       ('Income', 'transfer', 'banknote'), ('Credit Card Payment', 'transfer', 'credit-card')`,
  );
  await rerun013();
  expect(await bucketOf("Income")).toBe("income");
  // The other neutral category is a card payment, and stays one.
  expect(await bucketOf("Credit Card Payment")).toBe("transfer");
});

test("migration 013 leaves an Income category somebody deliberately moved", async () => {
  // Scoped to name *and* bucket: a person who put Income somewhere else on
  // purpose made a decision the migration has no business reversing.
  await empty();
  await sql.unsafe("INSERT INTO categories (name, bucket, icon) VALUES ('Income', 'savings', 'banknote')");
  await rerun013();
  expect(await bucketOf("Income")).toBe("savings");
});
