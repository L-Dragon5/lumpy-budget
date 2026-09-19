import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, post, resetDb, sql } from "./setup";

/**
 * The two halves of the classifier that touch the database. The model itself is
 * not here: `services/llm` tests the prompt and the answer-reading with a stub,
 * and `services/llm/eval` measures whether the answers are any good. What this
 * file pins is that the backlog is grouped honestly and that approving a
 * decision writes exactly the rows it claims to.
 */

const charge = (merchant: string, over: Partial<{ amount_cents: number; txn_date: string; description: string; category_id: number }> = {}) =>
  post("/api/expenses", {
    txn_date: "2026-04-10",
    amount_cents: 1200,
    merchant,
    description: "",
    category_id: null,
    source: "manual",
    ...over,
  });

const cat = async (name: string, bucket = "discretionary") =>
  (await post("/api/categories", { name, bucket, icon: null, color: null })).body.id as number;

const backlog = async () => (await api("/api/uncategorized-merchants")).body as {
  merchant: string; description: string; count: number; total_cents: number; first_seen: string; last_seen: string;
}[];

describe("GET /api/uncategorized-merchants", () => {
  beforeEach(() => resetDb());

  test("one row per merchant, with the count, the signed total and the dates it spans", async () => {
    await charge("BoBaPoP Tea Bar", { amount_cents: 799, txn_date: "2026-03-02" });
    await charge("BoBaPoP Tea Bar", { amount_cents: 850, txn_date: "2026-05-09" });
    await charge("EVERTRUE INC", { amount_cents: -450000, txn_date: "2026-04-15" });

    const rows = await backlog();
    const boba = rows.find((r) => r.merchant === "BoBaPoP Tea Bar")!;
    expect(boba).toMatchObject({ count: 2, total_cents: 1649, first_seen: "2026-03-02", last_seen: "2026-05-09" });
    // The sign survives the trip. A paycheck nobody categorised is the one row
    // in this list that is not spending, and the minus is how anybody can tell.
    expect(rows.find((r) => r.merchant === "EVERTRUE INC")!.total_cents).toBe(-450000);
  });

  test("busiest merchant first, then by how much money is riding on it", async () => {
    await charge("Once Big", { amount_cents: 90000 });
    await charge("Once Small", { amount_cents: 100 });
    await charge("Twice", { amount_cents: 100 });
    await charge("Twice", { amount_cents: 100 });

    expect((await backlog()).map((r) => r.merchant)).toEqual(["Twice", "Once Big", "Once Small"]);
  });

  test("the longest bank description wins, because the short one is usually blank", async () => {
    await charge("SQ *X", { description: "" });
    await charge("SQ *X", { description: "COFFEE AND PASTRY" });
    await charge("SQ *X", { description: "COFFEE" });

    expect((await backlog())[0]!.description).toBe("COFFEE AND PASTRY");
  });

  test("a row that already has a category is not in the backlog", async () => {
    const dining = await cat("Dining");
    await charge("Categorised", { category_id: dining });
    await charge("Not categorised");

    expect((await backlog()).map((r) => r.merchant)).toEqual(["Not categorised"]);
  });

  test("a split parent is not in the backlog: it is hidden from every report, so it is not a decision", async () => {
    const parent = (await charge("Costco", { amount_cents: 18000 })).body.id as number;
    await post(`/api/expenses/${parent}/split`, {
      parts: [
        { amount_cents: 12000, category_id: null, description: "food" },
        { amount_cents: 6000, category_id: null, description: "tyres" },
      ],
    });

    const rows = await backlog();
    // The parts are uncategorised and carry the parent's merchant, so the
    // merchant is here -- counted twice, once per part, never three times.
    expect(rows.find((r) => r.merchant === "Costco")).toMatchObject({ count: 2, total_cents: 18000 });
  });

  test("case and trailing space are one merchant, here and in the UPDATE alike", async () => {
    // MySQL's collation decides both, and it decides them the same way: the
    // GROUP BY folds these into one row, so the UPDATE that matches on the
    // merchant string cannot reach rows the list never showed.
    await charge("Kusshi");
    await charge("kusshi ");

    const rows = await backlog();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });

  test("nothing uncategorised is an empty list, not an error", async () => {
    expect(await backlog()).toEqual([]);
  });
});

describe("POST /api/expenses/categorize", () => {
  beforeEach(() => resetDb());

  test("fills every uncategorised row for the merchant and reports the count", async () => {
    const dining = await cat("Dining");
    await charge("Kusshi");
    await charge("Kusshi");
    await charge("Elsewhere");

    const res = await post("/api/expenses/categorize", {
      assignments: [{ merchant: "Kusshi", category_id: dining, make_rule: false }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 2, rules_created: 0, skipped: [] });

    const list = (await api("/api/expenses")).body as { merchant: string; category_id: number | null }[];
    expect(list.filter((e) => e.merchant === "Kusshi").every((e) => e.category_id === dining)).toBe(true);
    expect(list.find((e) => e.merchant === "Elsewhere")!.category_id).toBeNull();
  });

  test("never changes a category a person already set", async () => {
    const dining = await cat("Dining");
    const groceries = await cat("Groceries");
    const settled = (await charge("Wegmans", { category_id: groceries })).body.id as number;
    await charge("Wegmans");

    const res = await post("/api/expenses/categorize", {
      assignments: [{ merchant: "Wegmans", category_id: dining, make_rule: false }],
    });
    expect(res.body.updated).toBe(1);
    expect((await api(`/api/expenses/${settled}`)).body.category_id).toBe(groceries);
  });

  test("make_rule writes the merchant string itself, so it can never claim a merchant nobody looked at", async () => {
    const dining = await cat("Dining");
    await charge("DD *DOORDASH JERSEYMIK");

    const res = await post("/api/expenses/categorize", {
      assignments: [{ merchant: "DD *DOORDASH JERSEYMIK", category_id: dining, make_rule: true }],
    });
    expect(res.body.rules_created).toBe(1);

    const rules = (await api("/api/category-rules")).body as { pattern: string; category_id: number; whole_word: boolean }[];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: "DD *DOORDASH JERSEYMIK", category_id: dining, whole_word: false });
    // Not widened to "dd doordash": the sibling merchant is a different meal.
    expect(rules[0]!.pattern).not.toBe("dd doordash");
  });

  test("a rule whose needle already exists is not written twice", async () => {
    const dining = await cat("Dining");
    await post("/api/category-rules", { pattern: "  kusshi  ", whole_word: false, category_id: dining, priority: 100 });
    await charge("Kusshi");

    const res = await post("/api/expenses/categorize", {
      assignments: [{ merchant: "Kusshi", category_id: dining, make_rule: true }],
    });
    // Rows still land; the rule is what was already there.
    expect(res.body).toMatchObject({ updated: 1, rules_created: 0 });
    expect((await api("/api/category-rules")).body).toHaveLength(1);
  });

  test("one assignment covers the merchant's other spellings, and the rule is written once", async () => {
    const dining = await cat("Dining");
    await charge("Kusshi");
    await charge("kusshi");

    // The backlog showed these as one row, so one decision has to settle both.
    // The collation does it: `merchant = 'Kusshi'` matches `kusshi` too.
    const res = await post("/api/expenses/categorize", {
      assignments: [{ merchant: "Kusshi", category_id: dining, make_rule: true }],
    });
    expect(res.body).toMatchObject({ updated: 2, rules_created: 1 });
  });

  test("a category that has been deleted since the proposal is skipped and said out loud", async () => {
    const dining = await cat("Dining");
    await charge("Kusshi");
    await charge("Gone");

    const res = await post("/api/expenses/categorize", {
      assignments: [
        { merchant: "Kusshi", category_id: dining, make_rule: false },
        { merchant: "Gone", category_id: 9999, make_rule: true },
      ],
    });
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toEqual([{ merchant: "Gone", reason: "category 9999 does not exist" }]);
    expect((await api("/api/category-rules")).body).toHaveLength(0);
  });

  test("a split parent keeps its null category: its parts are the rows that count", async () => {
    const dining = await cat("Dining");
    const parent = (await charge("Costco", { amount_cents: 18000 })).body.id as number;
    await post(`/api/expenses/${parent}/split`, {
      parts: [
        { amount_cents: 12000, category_id: null, description: "food" },
        { amount_cents: 6000, category_id: null, description: "tyres" },
      ],
    });

    const res = await post("/api/expenses/categorize", {
      assignments: [{ merchant: "Costco", category_id: dining, make_rule: false }],
    });
    expect(res.body.updated).toBe(2);
    const [row] = (await sql.unsafe("SELECT category_id FROM expenses WHERE id = ?", [parent])) as { category_id: number | null }[];
    expect(row!.category_id).toBeNull();
  });

  test("an empty assignment list is a 422, not a no-op that looks like success", async () => {
    expect((await post("/api/expenses/categorize", { assignments: [] })).status).toBe(422);
  });

  test('"categorize" is never read as an expense id', async () => {
    await charge("Anything");
    // The static segment wins whichever way the routes were registered. If an
    // Elysia upgrade changes that, this is the test that says so.
    expect((await post("/api/expenses/categorize", { assignments: [] })).status).toBe(422);
    expect((await api("/api/expenses/categorize")).status).not.toBe(200);
  });
});

describe("POST /api/classify", () => {
  const KEY = "GEMINI_API_KEY";
  let saved: string | undefined;

  beforeEach(async () => {
    await resetDb();
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("an empty backlog answers without a model and without a key", async () => {
    const res = await post("/api/classify", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ proposals: [], unresolved: [], model: "" });
  });

  test("no key is a 503 naming the setting, not a 500", async () => {
    await charge("Something");
    const res = await post("/api/classify", {});
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("GEMINI_API_KEY");
  });
});
