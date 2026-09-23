/**
 * API tests run against a real MySQL, on their own database, so the queries
 * being tested are the queries that ship. Import this before anything that
 * touches @lumpy/db: the client reads DATABASE_URL once, at module load.
 */
/**
 * `bun test` forces TZ=UTC on the process. MySQL dates rows on the machine's
 * clock (`time_zone` is SYSTEM), so from 8pm local until midnight a JS "today"
 * and a `DATE()` off the same instant are a day apart, and tests comparing the
 * two failed every evening with nothing wrong in the app. Put the process back
 * on the zone the API actually runs in, which is what makes the comparison mean
 * anything. A machine with no /etc/localtime symlink -- a CI box -- is UTC on
 * both sides already, so the fallback agrees too.
 */
process.env.TZ = (() => {
  try {
    const link = require("node:fs").readlinkSync("/etc/localtime") as string;
    return link.split("zoneinfo/")[1] ?? "UTC";
  } catch {
    return "UTC";
  }
})();

export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "mysql://root@127.0.0.1:3306/lumpy_budget_test";
process.env.DATABASE_URL = TEST_URL;

const { migrate } = await import("@lumpy/db/migrate");
await migrate(TEST_URL);

const { sql } = await import("@lumpy/db");
/** For the handful of tests that need a starting state no route can produce. */
export { sql };
const { seed } = await import("@lumpy/db/seed");
const { CARD_BALANCE_PREFIX, DISMISSED_RECURRING } = await import("../src/store");

const TABLES = [
  "expenses", "import_batches", "import_profiles", "category_rules", "categories",
  "income_streams", "fixed_costs", "lumpy_items", "savings_goals",
];

/**
 * The tables a test has written to since they were last truncated. TRUNCATE is
 * DDL and costs ~1.5ms whether the table is empty or not; most tests touch two
 * or three of nine, so truncating only those is most of the suite's runtime.
 * AUTO_INCREMENT > 1 means something was inserted since the last TRUNCATE --
 * even a row that was deleted again, whose id would otherwise not restart and
 * would move every id-keyed setting. The row check is the backstop for a table
 * whose counter reads stale; MariaDB reads it live.
 */
async function dirtyTables(): Promise<string[]> {
  const ai = await sql.unsafe(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND AUTO_INCREMENT > 1`,
  ) as { t: string }[];
  const touched = new Set(ai.map((r) => r.t));
  const [rows] = await sql.unsafe(
    `SELECT ${TABLES.map((t) => `EXISTS(SELECT 1 FROM \`${t}\`) AS \`${t}\``).join(", ")}`,
  ) as Record<string, number | boolean>[];
  return TABLES.filter((t) => touched.has(t) || Number(rows![t]) === 1);
}

export async function resetDb({ withSeed = false } = {}) {
  const dirty = await dirtyTables();
  if (dirty.length) {
    await sql.unsafe("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of dirty) await sql.unsafe(`TRUNCATE TABLE \`${t}\``);
    await sql.unsafe("SET FOREIGN_KEY_CHECKS = 1");
  }
  // settings is not truncated -- it is a key/value table shared with the
  // migrations -- so the hand-kept balances are zeroed instead, or one test's
  // typed-in balance is the next test's starting state.
  await sql.unsafe(
    "UPDATE settings SET value = '0' WHERE name IN ('lumpy_opening_balance_cents', 'checking_balance_cents')",
  );
  // Deleted, not zeroed: a card's balance is keyed by profile id, and TRUNCATE
  // just started those ids over, so a key left here is read as the balance of
  // the next test's first card.
  await sql.unsafe("DELETE FROM settings WHERE LEFT(name, CHAR_LENGTH(?)) = ?", [CARD_BALANCE_PREFIX, CARD_BALANCE_PREFIX]);
  // Deleted for a third reason: the row existing at all is what tells the cash
  // position this household keeps its bills in a second account, so zeroing it
  // would leave every later test split in two.
  await sql.unsafe("DELETE FROM settings WHERE name = 'fixed_balance_cents'");
  // Same reason: the expenses a dismissal was about were just truncated.
  await sql.unsafe("DELETE FROM settings WHERE name = ?", [DISMISSED_RECURRING]);
  if (withSeed) await seed();
}

const { app } = await import("../src/app");
export const base = "http://localhost";

/** Straight through the app, no socket: same routing, same hooks, no port to pick. */
export const api = async (path: string, init?: RequestInit) => {
  const res = await app.handle(new Request(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

export const post = (path: string, body: unknown) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
export const put = (path: string, body: unknown) =>
  api(path, { method: "PUT", body: JSON.stringify(body) });
export const del = (path: string) => api(path, { method: "DELETE" });

/** The whole Response, for the routes whose headers are the point. */
export const raw = (path: string): Promise<Response> => app.handle(new Request(`${base}${path}`));

/** The CORS headers the API returns to a browser at a given Origin. */
export const corsHeaders = async (origin: string): Promise<Headers> => {
  const res = await app.handle(new Request(`${base}/api/categories`, { headers: { Origin: origin } }));
  return res.headers;
};

export const allowedOrigin = async (origin: string): Promise<string | null> =>
  (await corsHeaders(origin)).get("access-control-allow-origin");
