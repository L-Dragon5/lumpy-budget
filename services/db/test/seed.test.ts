/**
 * Own database, set before @lumpy/db loads: the client reads DATABASE_URL once,
 * at module load. Self-contained rather than borrowing the API suite's setup,
 * because db has no business importing from a package that depends on it.
 */
import { expect, test } from "bun:test";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "mysql://root@127.0.0.1:3306/lumpy_budget_test";

const { migrate } = await import("../src/migrate");
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
