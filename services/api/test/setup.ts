/**
 * API tests run against a real MySQL, on their own database, so the queries
 * being tested are the queries that ship. Import this before anything that
 * touches @lumpy/db: the client reads DATABASE_URL once, at module load.
 */
export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "mysql://root@127.0.0.1:3306/lumpy_budget_test";
process.env.DATABASE_URL = TEST_URL;
process.env.API_PORT = process.env.API_TEST_PORT ?? "3999";

const { migrate } = await import("@lumpy/db/migrate");
await migrate(TEST_URL);

const { sql } = await import("@lumpy/db");
const { seed } = await import("@lumpy/db/seed");

const TABLES = [
  "expenses", "import_batches", "import_profiles", "category_rules", "categories",
  "income_streams", "fixed_costs", "lumpy_items", "savings_goals",
];

export async function resetDb({ withSeed = false } = {}) {
  await sql.unsafe("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of TABLES) await sql.unsafe(`TRUNCATE TABLE \`${t}\``);
  await sql.unsafe("SET FOREIGN_KEY_CHECKS = 1");
  await sql.unsafe("UPDATE settings SET value = '0' WHERE name = 'lumpy_opening_balance_cents'");
  if (withSeed) await seed();
}

const { server } = await import("../src/server");
export const base = `http://localhost:${server.port}`;

export const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

export const post = (path: string, body: unknown) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
export const put = (path: string, body: unknown) =>
  api(path, { method: "PUT", body: JSON.stringify(body) });
export const del = (path: string) => api(path, { method: "DELETE" });
