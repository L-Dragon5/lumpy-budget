import { beforeEach, describe, expect, test } from "bun:test";
import { allowedOrigin, api, corsHeaders, del, post, put, raw, resetDb, sql } from "./setup";

const semiMonthly = {
  name: "Day job", amount_cents: 300000, frequency: "semimonthly",
  anchor_date: null, day_1: 15, day_2: 0, day_of_month: null, active: true,
};

describe("crud", () => {
  beforeEach(() => resetDb());

  test("an income stream round-trips without a date drifting", async () => {
    const created = await post("/api/income-streams", { ...semiMonthly, anchor_date: "2026-03-15" });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeGreaterThan(0);
    // The DATE column comes back as the same string that went in, not shifted a day.
    expect(created.body.anchor_date).toBe("2026-03-15");
    expect(created.body.active).toBe(true);

    const fetched = await api(`/api/income-streams/${created.body.id}`);
    expect(fetched.body).toEqual(created.body);

    const updated = await put(`/api/income-streams/${created.body.id}`, {
      ...semiMonthly, anchor_date: "2026-03-15", amount_cents: 310000, active: false,
    });
    expect(updated.body.amount_cents).toBe(310000);
    expect(updated.body.active).toBe(false);

    expect((await del(`/api/income-streams/${created.body.id}`)).status).toBe(200);
    expect((await api(`/api/income-streams/${created.body.id}`)).status).toBe(404);
  });

  test("a one-off income stores and reads back as one_time", async () => {
    // Also the proof the ENUM migration landed: MySQL rejects an unlisted value.
    const gift = await post("/api/income-streams", {
      ...semiMonthly, name: "Birthday gift", frequency: "one_time",
      anchor_date: "2026-03-14", day_1: null, day_2: null, amount_cents: 50000,
    });
    expect(gift.status).toBe(201);
    expect((await api(`/api/income-streams/${gift.body.id}`)).body).toMatchObject({
      frequency: "one_time", anchor_date: "2026-03-14", amount_cents: 50000,
    });

    // It counts in March and nowhere else, and never lifts the average.
    const cal = await api("/api/income-calendar?year=2026");
    const byMonth = (m: string) => cal.body.months.find((x: { month: string }) => x.month === m);
    expect(byMonth("2026-03").total_cents).toBe(50000);
    expect(byMonth("2026-04").total_cents).toBe(0);
    expect(byMonth("2026-03").normalized_cents).toBe(0);
  });

  test("a rule pattern is stored trimmed, whichever route wrote it", async () => {
    // This block resets without the seed, so the category the rule needs is ours.
    const cat = await post("/api/categories", { name: "Groceries", bucket: "discretionary", icon: null, color: null });
    const groceries = cat.body.id as number;

    const made = await post("/api/category-rules", { pattern: "  wegmans  ", category_id: groceries, priority: 10 });
    expect(made.status).toBe(201);
    // The padding never did anything: applyRules matches on the trimmed needle,
    // so storing it only put whitespace in the rules table.
    expect(made.body.pattern).toBe("wegmans");

    const edited = await put(`/api/category-rules/${made.body.id}`, {
      pattern: "\ttrader joe\n", category_id: groceries, priority: 10,
    });
    expect(edited.body.pattern).toBe("trader joe");

    // Trimmed before the length check, so padding cannot buy a shorter needle.
    const tooShort = await post("/api/category-rules", { pattern: "  a  ", category_id: groceries, priority: 10 });
    expect(tooShort.status).toBe(422);
    expect(tooShort.body.errors[0]!.path).toEqual(["pattern"]);
  });

  test("a bad body is a 422 that names the field", async () => {
    const res = await post("/api/income-streams", { ...semiMonthly, frequency: "biweekly", anchor_date: null });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]!.path).toEqual(["anchor_date"]);

    const noDate = await post("/api/income-streams", { ...semiMonthly, frequency: "one_time", day_1: null, day_2: null });
    expect(noDate.status).toBe(422);
    expect(noDate.body.errors[0]!.path).toEqual(["anchor_date"]);

    const bad = await post("/api/fixed-costs", { name: "", amount_cents: -5, due_day: 99 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((i: { path: string[] }) => i.path.join(".")).sort())
      .toEqual(["amount_cents", "due_day", "name"]);
    // The shape apps/web/src/lib/api.ts parses. Recorded in fixtures/validation-error.json;
    // if an Elysia upgrade moves it, this fails before the error toast does.
    expect(bad.body).toMatchObject({ type: "validation", on: "body" });
    expect(typeof bad.body.errors[0]!.message).toBe("string");
  });

  test("unknown resources and ids 404 instead of leaking SQL", async () => {
    expect((await api("/api/robots")).status).toBe(404);
    expect((await api("/api/income-streams/999999")).status).toBe(404);
    expect((await del("/api/income-streams/999999")).status).toBe(404);
  });

  test("import batches are read-only", async () => {
    expect((await post("/api/import-batches", { name: "x", mapping: {} })).status).toBe(405);
  });

  test("a lumpy item keeps its due date exactly", async () => {
    const res = await post("/api/lumpy-items", {
      name: "Car registration", amount_cents: 12500, frequency_months: 24,
      next_due_date: "2027-01-31", category_id: null, active: true,
    });
    expect(res.body.next_due_date).toBe("2027-01-31");
    expect((await api("/api/lumpy-items")).body[0]!.next_due_date).toBe("2027-01-31");
  });

  test("a percent savings goal keeps its decimal", async () => {
    const res = await post("/api/savings-goals", {
      name: "Vacation", mode: "percent", amount_cents: null, percent: 7.5, active: true,
    });
    expect(res.body.percent).toBe(7.5);
  });
});

describe("expenses and import", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  const rows = [
    { txn_date: "2026-03-14", amount_cents: 8421, merchant: "WEGMANS #123", description: "Groceries", category_id: null, source: "import" },
    { txn_date: "2026-03-16", amount_cents: 1549, merchant: "NETFLIX.COM", description: "", category_id: null, source: "import" },
    { txn_date: "2026-03-20", amount_cents: -25000, merchant: "PAYMENT THANK YOU", description: "", category_id: null, source: "import" },
  ];

  test("an import categorizes by rule and refuses to double-load", async () => {
    const first = await post("/api/import", { filename: "chase.csv", profile_id: null, rows });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ row_count: 3, inserted: 3, skipped: 0 });

    const stored = (await api("/api/expenses")).body;
    expect(stored).toHaveLength(3);
    const cats = (await api("/api/categories")).body as { id: number; name: string }[];
    const byName = (n: string) => cats.find((c) => c.name === n)!.id;
    const wegmans = stored.find((e: { merchant: string }) => e.merchant === "WEGMANS #123");
    expect(wegmans.category_id).toBe(byName("Groceries"));
    expect(stored.find((e: { merchant: string }) => e.merchant === "NETFLIX.COM").category_id).toBe(byName("Subscriptions"));
    expect(stored.find((e: { merchant: string }) => e.merchant === "PAYMENT THANK YOU").category_id).toBe(byName("Credit Card Payment"));

    // Re-importing the same statement inserts nothing at all.
    const second = await post("/api/import", { filename: "chase.csv", profile_id: null, rows });
    expect(second.body).toMatchObject({ row_count: 3, inserted: 0, skipped: 3 });
    expect((await api("/api/expenses")).body).toHaveLength(3);

    // An overlapping statement adds only what is new.
    const third = await post("/api/import", {
      filename: "chase-april.csv", profile_id: null,
      rows: [...rows, { ...rows[0]!, txn_date: "2026-04-01" }],
    });
    expect(third.body).toMatchObject({ inserted: 1, skipped: 3 });
  });

  test("an import batch timestamp crosses the wire as a string, not a Date", async () => {
    await post("/api/import", { filename: "chase.csv", profile_id: null, rows });
    const [batch] = (await api("/api/import-batches")).body as { created_at: string }[];
    // A TIMESTAMP column arrives from the driver as a Date. services/db coerces
    // it, because every date in this app is a string end to end.
    expect(typeof batch!.created_at).toBe("string");
    expect(batch!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(batch!.created_at))).toBe(false);
  });

  test("deleting an import batch takes its expenses with it", async () => {
    const batch = await post("/api/import", { filename: "chase.csv", profile_id: null, rows });
    expect((await api("/api/expenses")).body).toHaveLength(3);
    expect((await del(`/api/import-batches/${batch.body.batch_id}`)).status).toBe(200);
    expect((await api("/api/expenses")).body).toEqual([]);
  });

  test("expenses filter by date, category and text", async () => {
    await post("/api/import", { filename: "chase.csv", profile_id: null, rows });
    expect((await api("/api/expenses?start=2026-03-15&end=2026-03-31")).body).toHaveLength(2);
    expect((await api("/api/expenses?q=WEGMANS")).body).toHaveLength(1);
    const groceries = ((await api("/api/categories")).body as { id: number; name: string }[])
      .find((c) => c.name === "Groceries")!.id;
    expect((await api(`/api/expenses?category_id=${groceries}`)).body).toHaveLength(1);
    await post("/api/expenses", {
      txn_date: "2026-03-18", amount_cents: 999, merchant: "Cash", description: "", category_id: null, source: "manual",
    });
    expect((await api("/api/expenses?category_id=none")).body).toHaveLength(1);
  });

  test("a malformed filter is refused rather than quietly ignored", async () => {
    await post("/api/import", { filename: "chase.csv", profile_id: null, rows });
    // Dropping an unparseable filter would answer a question nobody asked: you
    // ask for March and get the whole ledger, with nothing to say it went wrong.
    expect((await api("/api/expenses?start=March")).status).toBe(422);
    expect((await api("/api/expenses?end=2026-3-1")).status).toBe(422);
    // Absent is still absent, and a valid filter still filters.
    expect((await api("/api/expenses")).body).toHaveLength(3);
    expect((await api("/api/expenses?start=2026-03-15")).body).toHaveLength(2);
  });

  test("two identical charges on one day are two expenses, not one", async () => {
    // Two $6.50 coffees at one shop on one morning are one identity and two real
    // transactions. Refusing the second undercounts exactly the discretionary
    // spending this app exists to protect, so a hand-entered row takes the next
    // free occurrence rather than colliding.
    const body = { txn_date: "2026-03-18", amount_cents: 650, merchant: "Corner Coffee", description: "", category_id: null, source: "manual" };
    const first = await post("/api/expenses", body);
    const second = await post("/api/expenses", body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.dedupe_hash).not.toBe(first.body.dedupe_hash);
    expect((await api("/api/expenses")).body).toHaveLength(2);
    expect((await api("/api/summary?month=2026-03")).body.spent.discretionary).toBe(1300);
  });

  test("an edit onto another row is allowed, and keeps both rows reachable", async () => {
    const base = { description: "", category_id: null, source: "manual" };
    const a = await post("/api/expenses", { ...base, txn_date: "2026-03-18", amount_cents: 999, merchant: "Cash" });
    const b = await post("/api/expenses", { ...base, txn_date: "2026-03-19", amount_cents: 500, merchant: "Kiosk" });
    expect(b.status).toBe(201);

    // Correcting B's date onto A's is the same statement as entering it twice:
    // it says two withdrawals happened, and the second one takes occurrence 1.
    const clash = await put(`/api/expenses/${b.body.id}`, {
      ...base, txn_date: "2026-03-18", amount_cents: 999, merchant: "Cash",
    });
    expect(clash.status).toBe(200);
    expect(clash.body.dedupe_hash).not.toBe(a.body.dedupe_hash);
    expect((await api("/api/expenses")).body).toHaveLength(2);

    // An edit that changes nothing must not renumber the row onto a free index
    // it does not need: its own hash is not a duplicate of itself.
    const same = await put(`/api/expenses/${b.body.id}`, {
      ...base, txn_date: "2026-03-18", amount_cents: 999, merchant: "Cash",
    });
    expect(same.body.dedupe_hash).toBe(clash.body.dedupe_hash);

    // And an edit that moves the row away rewrites the hash to describe what the
    // row now says, so the statement it came from re-imports it.
    const moved = await put(`/api/expenses/${b.body.id}`, {
      ...base, txn_date: "2026-03-19", amount_cents: 500, merchant: "Corner Kiosk",
    });
    expect(moved.status).toBe(200);
    expect(moved.body.merchant).toBe("Corner Kiosk");
    expect(moved.body.dedupe_hash).not.toBe(b.body.dedupe_hash);
    expect(a.body.dedupe_hash).not.toBe(moved.body.dedupe_hash);
  });

  test("a statement listing one charge twice imports it twice, and re-imports as a no-op", async () => {
    const coffee = {
      txn_date: "2026-03-18", amount_cents: 650, merchant: "CORNER COFFEE #4",
      description: "", category_id: null, source: "import",
    };
    const file = { filename: "chase.csv", profile_id: null, rows: [coffee, coffee, { ...coffee, amount_cents: 1200 }] };

    const first = await post("/api/import", file);
    expect(first.body.inserted).toBe(3);
    expect(first.body.skipped).toBe(0);

    // The indices come from the file's own order, so the same file produces the
    // same three hashes and the second run is the no-op it has always been.
    const again = await post("/api/import", file);
    expect(again.body.inserted).toBe(0);
    expect(again.body.skipped).toBe(3);
    expect((await api("/api/expenses")).body).toHaveLength(3);
  });

  test("re-importing a row whose expense was edited away inserts it again", async () => {
    const first = await post("/api/import", { filename: "chase.csv", profile_id: null, rows });
    expect(first.body.inserted).toBe(3);

    const stored = (await api("/api/expenses")).body as { id: number; merchant: string }[];
    const wegmans = stored.find((e) => e.merchant === "WEGMANS #123")!;
    await put(`/api/expenses/${wegmans.id}`, {
      txn_date: "2026-03-14", amount_cents: 8421, merchant: "Wegmans Rochester",
      description: "Groceries", category_id: null, source: "import",
    });

    // The edited row is no longer the row the statement describes, so the
    // statement's version is new. A stale hash would have skipped it.
    const again = await post("/api/import", { filename: "chase.csv", profile_id: null, rows });
    expect(again.body).toMatchObject({ inserted: 1, skipped: 2 });
  });

  test("a duplicate category name is a 409, not a 500", async () => {
    expect((await post("/api/categories", { name: "Groceries", bucket: "discretionary", color: null })).status).toBe(409);
  });
});

describe("computed endpoints", () => {
  beforeEach(async () => {
    await resetDb({ withSeed: true });
    await post("/api/income-streams", semiMonthly);
    await post("/api/income-streams", {
      name: "Rental", amount_cents: 180000, frequency: "monthly",
      anchor_date: null, day_1: null, day_2: null, day_of_month: 5, active: true,
    });
    await post("/api/fixed-costs", { name: "Rent", amount_cents: 150000, due_day: 1, lead_days: 3, category_id: null, merchant_pattern: null, active: true });
    await post("/api/fixed-costs", { name: "Internet", amount_cents: 8000, due_day: 20, lead_days: 3, category_id: null, merchant_pattern: null, active: true });
    await post("/api/lumpy-items", { name: "Car insurance", amount_cents: 120000, frequency_months: 12, next_due_date: "2027-03-01", category_id: null, active: true });
    await post("/api/savings-goals", { name: "Emergency", mode: "fixed", amount_cents: 50000, percent: null, active: true });
  });

  test("the summary matches the same numbers computed by hand", async () => {
    const res = await api("/api/summary?month=2026-03");
    expect(res.status).toBe(200);
    expect(res.body.income_cents).toBe(780000);
    expect(res.body.fixed_cents).toBe(158000);
    expect(res.body.lumpy_cents).toBe(10000);
    expect(res.body.savings_cents).toBe(50000);
    expect(res.body.planned_free_cents).toBe(780000 - 158000 - 10000 - 50000);
    expect(res.body.available_cents).toBe(562000);
    expect(res.body.periods).toHaveLength(3);
    // Rent is due the 1st, so February's paycheck is the one holding it.
    expect(res.body.paychecks.find((p: { prior_month: boolean }) => p.prior_month).date).toBe("2026-02-15");
  });

  test("spending only moves the number when it is discretionary", async () => {
    const cats = (await api("/api/categories")).body as { id: number; name: string }[];
    const id = (n: string) => cats.find((c) => c.name === n)!.id;
    await post("/api/import", {
      filename: "x.csv", profile_id: null,
      rows: [
        { txn_date: "2026-03-10", amount_cents: 25000, merchant: "WEGMANS", description: "", category_id: null, source: "import" },
        { txn_date: "2026-03-01", amount_cents: 150000, merchant: "MORTGAGE CO", description: "mortgage", category_id: null, source: "import" },
      ],
    });
    const res = await api("/api/summary?month=2026-03");
    expect(res.body.spent.total).toBe(175000);
    expect(res.body.spent.discretionary).toBe(25000);
    expect(res.body.spent.fixed).toBe(150000);
    expect(res.body.available_cents).toBe(562000 - 25000);
    expect(id("Housing")).toBeGreaterThan(0);
  });

  test("the allocation names which paycheck holds which bill", async () => {
    const res = await api("/api/allocation?month=2026-03");
    const held = res.body.paychecks.flatMap((p: { date: string; holds: { name: string }[] }) =>
      p.holds.map((h) => [p.date, h.name]),
    );
    expect(held).toEqual([["2026-02-15", "Rent"], ["2026-03-15", "Internet"]]);
    expect(res.body.unfunded).toEqual([]);
  });

  test("the lumpy timeline runs 12 months and respects the opening balance", async () => {
    const res = await api("/api/lumpy-timeline?start=2026-03&months=12");
    expect(res.body.rows).toHaveLength(12);
    expect(res.body.monthly_contribution_cents).toBe(10000);
    expect(res.body.rows[0]!.month).toBe("2026-03");
    expect(res.body.opening_balance_cents).toBe(0);

    await put("/api/settings", { name: "lumpy_opening_balance_cents", value: "50000" });
    const withBalance = await api("/api/lumpy-timeline?start=2026-03&months=12");
    expect(withBalance.body.opening_balance_cents).toBe(50000);
    expect(withBalance.body.rows[0]!.balance_start_cents).toBe(50000);
  });

  test("the income calendar flags extra-paycheck months for biweekly pay only", async () => {
    await post("/api/income-streams", {
      name: "Side gig", amount_cents: 100000, frequency: "biweekly",
      anchor_date: "2026-01-02", day_1: null, day_2: null, day_of_month: null, active: true,
    });
    const res = await api("/api/income-calendar?year=2026");
    expect(res.body.months).toHaveLength(12);
    expect(res.body.months.filter((m: { extra_paycheck: boolean }) => m.extra_paycheck).map((m: { month: string }) => m.month))
      .toEqual(["2026-01", "2026-07"]);
    const semi = res.body.streams.find((s: { name: string }) => s.name === "Day job");
    expect(semi.extra_paycheck_months).toEqual([]);
  });

  test("reports break down by category and by week", async () => {
    await post("/api/import", {
      filename: "x.csv", profile_id: null,
      rows: [
        { txn_date: "2026-03-02", amount_cents: 5000, merchant: "WEGMANS", description: "", category_id: null, source: "import" },
        { txn_date: "2026-03-03", amount_cents: 3000, merchant: "STARBUCKS", description: "", category_id: null, source: "import" },
        { txn_date: "2026-03-10", amount_cents: 2000, merchant: "WEGMANS", description: "", category_id: null, source: "import" },
      ],
    });
    const monthly = await api("/api/reports?granularity=month&start=2026-03-01&end=2026-03-31");
    expect(monthly.body.breakdown.total_cents).toBe(10000);
    expect(monthly.body.breakdown.slices.map((s: { name: string }) => s.name)).toEqual(["Groceries", "Dining"]);
    expect(monthly.body.breakdown.slices[0]!.amount_cents).toBe(7000);

    const weekly = await api("/api/reports?granularity=week&start=2026-03-01&end=2026-03-31");
    expect(weekly.body.series[0]!.start).toBe("2026-03-01");
    expect(weekly.body.series[0]!.amount_cents).toBe(8000);
    expect(weekly.body.series[1]!.amount_cents).toBe(2000);
  });

  test("computed endpoints reject a malformed month instead of guessing", async () => {
    const bad = await api("/api/summary?month=March");
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ type: "validation", on: "query" });
    expect((await api("/api/summary")).status).toBe(422);
    expect((await api("/api/allocation?month=2026-3")).status).toBe(422);
    expect((await api("/api/reports?start=2026-03-01")).status).toBe(422);
  });

  // Replaces the intParam unit tests: out-of-range numbers clamp, they do not 422.
  test("an out-of-range range clamps instead of failing", async () => {
    expect((await api("/api/lumpy-timeline?start=2026-03&months=999")).body.rows).toHaveLength(60);
    expect((await api("/api/lumpy-timeline?start=2026-03&months=0")).body.rows).toHaveLength(1);
    expect((await api("/api/expenses?limit=99999")).status).toBe(200);
    expect((await api("/api/income-calendar?year=0")).body.year).toBe(1970);
  });
});

describe("cors", () => {
  test("only a local origin is allowed to read this unauthenticated API", async () => {
    expect(await allowedOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    // Vite increments the port when 5173 is taken, so any local port has to work.
    expect(await allowedOrigin("http://localhost:5174")).toBe("http://localhost:5174");
    expect(await allowedOrigin("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");

    expect(await allowedOrigin("https://evil.example.com")).toBeNull();
    // The anchors matter: a hostname that merely contains "localhost" is not local.
    expect(await allowedOrigin("https://localhost.evil.com")).toBeNull();
    expect(await allowedOrigin("https://evil.com/?x=http://localhost")).toBeNull();
  });

  test("no credentials are advertised, because there are none to send", async () => {
    // The plugin default is Allow-Credentials: true. Combined with an origin it
    // reflects, that hands any site a credentialed read of this API.
    expect((await corsHeaders("http://localhost:5173")).get("access-control-allow-credentials")).toBeNull();
  });
});

describe("backup export", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  test("every table is in the export, with a filename the browser will save under", async () => {
    const res = await raw("/api/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="lumpy-backup-\d{4}-\d{2}-\d{2}\.json"/);

    const body = await res.json();
    expect(body.version).toBe(1);
    // Every table the app reads through, plus settings, which is not in TABLES.
    expect(Object.keys(body.tables).sort()).toEqual([
      "categories", "category_rules", "expenses", "fixed_costs", "import_batches",
      "import_profiles", "income_streams", "lumpy_items", "savings_goals", "settings",
    ]);
    expect(body.tables.categories).toHaveLength(24);
    // Membership, not position: settings is a key/value table that grows a row
    // every time a hand-kept balance is added, and the export orders by name.
    expect(body.tables.settings.map((r: { name: string }) => r.name)).toContain("lumpy_opening_balance_cents");
  });

  test("rows come out as the contract describes them, not as raw driver output", async () => {
    await post("/api/lumpy-items", {
      name: "Car insurance", amount_cents: 120000, frequency_months: 12,
      next_due_date: "2027-03-01", category_id: null, active: true,
    });
    const body = await (await raw("/api/export")).json();
    const item = body.tables.lumpy_items[0];
    // A backup full of local-midnight Date objects would restore a day off.
    expect(item.next_due_date).toBe("2027-03-01");
    expect(item.active).toBe(true);
  });
});

describe("backup restore", () => {
  /** A household with one row in every table, including the linked ones. */
  async function household() {
    await resetDb({ withSeed: true });
    const cats = (await api("/api/categories")).body as { id: number; name: string; bucket: string }[];
    const groceries = cats.find((c) => c.bucket === "discretionary")!.id;
    const utilities = cats.find((c) => c.bucket === "fixed")!.id;

    await post("/api/income-streams", {
      name: "Day job", amount_cents: 300000, frequency: "semimonthly",
      anchor_date: null, day_1: 15, day_2: 0, day_of_month: null, active: true,
    });
    await post("/api/fixed-costs", {
      name: "Power", amount_cents: 14000, due_day: 12, lead_days: 3,
      category_id: utilities, merchant_pattern: "national grid", active: true,
    });
    await post("/api/lumpy-items", {
      name: "Car insurance", amount_cents: 120000, frequency_months: 6,
      next_due_date: "2027-03-01", category_id: utilities, active: true,
    });
    await post("/api/savings-goals", {
      name: "Emergency", mode: "percent", amount_cents: null, percent: 10,
      target_cents: 1000000, balance_cents: 250000, active: true,
    });
    await post("/api/import-profiles", {
      name: "Big Bank", mapping: {
        date_column: "Date", amount_column: "Amount", debit_column: null, credit_column: null,
        merchant_column: "Description", description_column: null,
        date_format: "MM/DD/YYYY", flip_sign: true, skip_rows: 0,
      },
    });
    await post("/api/category-rules", { pattern: "wegmans", category_id: groceries, priority: 10 });
    // Goes through the CSV importer, so there is a batch with expenses hanging off it.
    await post("/api/import", {
      filename: "march.csv", profile_id: null,
      rows: [
        { txn_date: "2026-03-02", amount_cents: 8412, merchant: "Wegmans", description: "", category_id: null, source: "import" },
        { txn_date: "2026-03-09", amount_cents: 13990, merchant: "National Grid", description: "", category_id: utilities, source: "import" },
      ],
    });
    await post("/api/expenses", {
      txn_date: "2026-03-11", amount_cents: 2200, merchant: "Corner cafe",
      description: "", category_id: groceries, source: "manual",
    });
    await put("/api/settings", { name: "lumpy_opening_balance_cents", value: "480000" });
  }

  const dump = async () => (await raw("/api/export")).json();

  test("an export restores byte for byte into an empty database", async () => {
    await household();
    const before = await dump();

    // The destination is a different shape entirely: seeded, but nothing else.
    await resetDb({ withSeed: true });
    const res = await post("/api/restore", before);
    expect(res.status).toBe(200);
    expect(res.body.restored.expenses).toBe(3);
    expect(res.body.restored.categories).toBe(24);
    expect(res.body.total).toBe(
      Object.values(before.tables as Record<string, unknown[]>).reduce((n, t) => n + t.length, 0),
    );

    const after = await dump();
    // Ids included: a restore that renumbered rows would still pass a row count.
    expect(after.tables).toEqual(before.tables);
  });

  test("restoring replaces, it does not merge", async () => {
    await household();
    const before = await dump();

    // Same database, plus a row that is not in the file. It must be gone after.
    await post("/api/expenses", {
      txn_date: "2026-03-20", amount_cents: 999, merchant: "Should not survive",
      description: "", category_id: null, source: "manual",
    });
    await post("/api/restore", before);

    const after = await dump();
    expect(after.tables).toEqual(before.tables);
    expect((after.tables.expenses as { merchant: string }[]).some((e) => e.merchant === "Should not survive")).toBe(false);
  });

  test("the engine reads the restored rows the same way it read the originals", async () => {
    await household();
    const summaryBefore = (await api("/api/summary?month=2026-03")).body;
    const before = await dump();

    await resetDb();
    await post("/api/restore", before);

    expect((await api("/api/summary?month=2026-03")).body).toEqual(summaryBefore);
  });

  test("a foreign key still points at the row it pointed at", async () => {
    await household();
    const before = await dump();
    await resetDb();
    await post("/api/restore", before);

    const after = await dump();
    const batch = (after.tables.import_batches as { id: number }[])[0]!;
    const imported = (after.tables.expenses as { import_batch_id: number | null }[])
      .filter((e) => e.import_batch_id !== null);
    expect(imported).toHaveLength(2);
    expect(imported.every((e) => e.import_batch_id === batch.id)).toBe(true);
    // The CSV batch's timestamp survives the round trip on the same clock it was written on.
    expect((after.tables.import_batches as { created_at: string }[])[0]!.created_at)
      .toBe((before.tables.import_batches as { created_at: string }[])[0]!.created_at);
  });

  test("the next manual row gets a free id, not a collision", async () => {
    await household();
    const before = await dump();
    await resetDb();
    await post("/api/restore", before);

    // AUTO_INCREMENT has to have been lifted past the ids the restore wrote.
    const created = await post("/api/expenses", {
      txn_date: "2026-04-01", amount_cents: 500, merchant: "After the restore",
      description: "", category_id: null, source: "manual",
    });
    expect(created.status).toBe(201);
    const maxBefore = Math.max(...(before.tables.expenses as { id: number }[]).map((e) => e.id));
    expect(created.body.id).toBeGreaterThan(maxBefore);
  });

  test("a file written before a column existed restores on the column's default", async () => {
    await household();
    const before = await dump();

    // Exactly what an older export is: rows with no merchant_pattern and no
    // cash_account. Both columns are NOT NULL, so the schema's defaults are the
    // only thing between an old backup and a constraint error -- which is the
    // fourth place in the add-a-column checklist earning its keep.
    const strip = (rows: Record<string, unknown>[], keys: string[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k))));

    const res = await post("/api/restore", {
      ...before,
      tables: {
        ...before.tables,
        lumpy_items: strip(before.tables.lumpy_items, ["merchant_pattern", "merchant_whole_word"]),
        import_profiles: strip(before.tables.import_profiles, ["cash_account"]),
      },
    });
    expect(res.status).toBe(200);

    const after = await dump();
    expect(after.tables.lumpy_items).toHaveLength(before.tables.lumpy_items.length);
    expect(after.tables.lumpy_items.every((i: { merchant_pattern: unknown }) => i.merchant_pattern === null)).toBe(true);
    expect(after.tables.lumpy_items.every((i: { merchant_whole_word: unknown }) => i.merchant_whole_word === false)).toBe(true);
    expect(after.tables.import_profiles).toHaveLength(before.tables.import_profiles.length);
    expect(after.tables.import_profiles.length).toBeGreaterThan(0);
    expect(after.tables.import_profiles.every((p: { cash_account: unknown }) => p.cash_account === true)).toBe(true);
  });

  test("a partial file is legitimate: what it omits comes back empty", async () => {
    await household();
    const before = await dump();

    const res = await post("/api/restore", {
      version: 1,
      tables: { categories: before.tables.categories, settings: before.tables.settings },
    });
    expect(res.status).toBe(200);
    expect(res.body.restored.expenses).toBe(0);

    const after = await dump();
    expect(after.tables.categories).toEqual(before.tables.categories);
    expect(after.tables.expenses).toEqual([]);
    expect(after.tables.fixed_costs).toEqual([]);
  });

  test("a bad file is a 422 that names the field, and changes nothing", async () => {
    await household();
    const before = await dump();

    const bad = structuredClone(before);
    bad.tables.lumpy_items[0].next_due_date = "March 1st";
    const res = await post("/api/restore", bad);
    expect(res.status).toBe(422);
    expect(res.body.errors[0]!.path).toEqual(["tables", "lumpy_items", 0, "next_due_date"]);

    expect((await dump()).tables).toEqual(before.tables);
  });

  test("a file the database rejects rolls back whole", async () => {
    await household();
    const before = await dump();

    // Schema-valid, database-invalid: a rule pointing at a category that is not
    // in the file. If the restore were not one transaction this would land with
    // the tables ahead of it already emptied.
    const bad = structuredClone(before);
    bad.tables.category_rules[0].category_id = 999999;
    const res = await post("/api/restore", bad);
    expect(res.status).toBe(409);

    expect((await dump()).tables).toEqual(before.tables);
  });

  test("a version this build does not understand is refused", async () => {
    await household();
    const before = await dump();
    const res = await post("/api/restore", { ...before, version: 2 });
    expect(res.status).toBe(422);
    expect((await dump()).tables).toEqual(before.tables);
  });
});

describe("merging import profiles", () => {
  const mapping = {
    date_column: "Posted Date", amount_column: "Amount", debit_column: null, credit_column: null,
    merchant_column: "Payee", description_column: "Memo",
    date_format: "MM/DD/YYYY", flip_sign: true, skip_rows: 1,
  };
  /** A file carrying profiles, shaped exactly like a real export. */
  const file = (profiles: unknown[]) => ({ version: 1, tables: { import_profiles: profiles } });
  const profiles = async () => (await api("/api/import-profiles")).body as
    { id: number; name: string; mapping: typeof mapping }[];

  beforeEach(() => resetDb({ withSeed: true }));

  test("profiles arrive without the rest of the file coming with them", async () => {
    await post("/api/fixed-costs", {
      name: "Power", amount_cents: 14000, due_day: 12, lead_days: 3,
      category_id: null, merchant_pattern: null, active: true,
    });

    const res = await post("/api/import-profiles/merge", file([
      { id: 7, name: "Big Bank", mapping },
      { id: 9, name: "Card", mapping: { ...mapping, flip_sign: false } },
    ]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: ["Big Bank", "Card"], updated: [] });

    // The point of a merge: everything already here is still here.
    expect((await api("/api/categories")).body).toHaveLength(24);
    expect((await api("/api/fixed-costs")).body).toHaveLength(1);

    const after = await profiles();
    expect(after.map((p) => p.name)).toEqual(["Big Bank", "Card"]);
    expect(after[0]!.mapping).toEqual(mapping);
    // The file's ids are dropped: 7 and 9 mean something else in this database.
    expect(after.every((p) => p.id !== 7 && p.id !== 9)).toBe(true);
  });

  test("a name you already have is updated in place, not duplicated", async () => {
    const mine = await post("/api/import-profiles", { name: "Big Bank", mapping });
    expect(mine.status).toBe(201);

    const fixed = { ...mapping, skip_rows: 3, merchant_column: "Description" };
    const res = await post("/api/import-profiles/merge", file([
      { name: "Big Bank", mapping: fixed },
      { name: "Card", mapping },
    ]));
    expect(res.body).toEqual({ added: ["Card"], updated: ["Big Bank"] });

    const after = await profiles();
    expect(after).toHaveLength(2);
    const big = after.find((p) => p.name === "Big Bank")!;
    // Same row, so anything pointing at it still points at it.
    expect(big.id).toBe(mine.body.id);
    expect(big.mapping).toEqual(fixed);
  });

  test("a whole backup file merges only its profiles, however bad the rest is", async () => {
    // The file you already have on disk is the file you get to use. Everything
    // outside tables.import_profiles is stripped before it is ever validated.
    const res = await post("/api/import-profiles/merge", {
      version: 1,
      exported_at: "2026-03-01T00:00:00.000Z",
      tables: {
        import_profiles: [{ id: 3, name: "Big Bank", mapping }],
        expenses: [{ txn_date: "not a date", amount_cents: "lots" }],
        categories: [{ bucket: "invented" }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: ["Big Bank"], updated: [] });
    expect((await profiles())).toHaveLength(1);
    expect((await api("/api/expenses")).body).toEqual([]);
  });

  test("a broken mapping is a 422 that names the field, and nothing lands", async () => {
    const res = await post("/api/import-profiles/merge", file([
      { name: "Big Bank", mapping },
      { name: "Card", mapping: { ...mapping, date_format: "YYYY/DD/MM" } },
    ]));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]!.path).toEqual(["tables", "import_profiles", 1, "mapping", "date_format"]);
    expect(await profiles()).toEqual([]);
  });

  test("a file that names the same profile twice is a 409, and takes nothing with it", async () => {
    await post("/api/import-profiles", { name: "Card", mapping });
    const res = await post("/api/import-profiles/merge", file([
      { name: "Big Bank", mapping },
      { name: "Big Bank", mapping: { ...mapping, skip_rows: 2 } },
    ]));
    expect(res.status).toBe(409);
    // One transaction: the first "Big Bank" is not sitting there half-merged.
    expect((await profiles()).map((p) => p.name)).toEqual(["Card"]);
  });

  test("a file with no profiles in it changes nothing", async () => {
    await post("/api/import-profiles", { name: "Card", mapping });
    const res = await post("/api/import-profiles/merge", { version: 1, tables: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: [], updated: [] });
    expect((await profiles()).map((p) => p.name)).toEqual(["Card"]);
  });

  test("merge does not shadow the crud routes it sits next to", async () => {
    const made = await post("/api/import-profiles", { name: "Big Bank", mapping });
    expect((await api(`/api/import-profiles/${made.body.id}`)).status).toBe(200);
    // "merge" is a word, not an id, and the id route must still say so.
    expect((await api("/api/import-profiles/merge")).status).toBe(422);
    expect((await del(`/api/import-profiles/${made.body.id}`)).status).toBe(200);
  });
});

describe("whole-word rules, end to end", () => {
  let fuel: number;

  beforeEach(async () => {
    await resetDb({ withSeed: true });
    await sql.unsafe("DELETE FROM category_rules");
    fuel = ((await api("/api/categories")).body as { id: number; name: string }[])
      .find((c) => c.name === "Gas & Fuel")!.id;
  });

  const importRows = (merchants: string[]) =>
    post("/api/import", {
      filename: "march.csv", profile_id: null,
      rows: merchants.map((merchant, i) => ({
        txn_date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        amount_cents: 1000 + i, merchant, description: "", category_id: null, source: "import",
      })),
    });

  test("the switch survives the round trip and reaches the importer", async () => {
    const made = await post("/api/category-rules", { pattern: "bp", whole_word: true, category_id: fuel, priority: 10 });
    expect(made.status).toBe(201);
    expect(made.body.whole_word).toBe(true);
    // A boolean column read back as 0/1 would still be truthy; this is the coercion.
    expect((await api(`/api/category-rules/${made.body.id}`)).body.whole_word).toBe(true);

    await importRows(["BP #4021 FUEL", "BPOST BRUSSELS", "BP1234"]);
    const spent = (await api("/api/expenses")).body as { merchant: string; category_id: number | null }[];
    const of = (m: string) => spent.find((e) => e.merchant === m)!.category_id;
    expect(of("BP #4021 FUEL")).toBe(fuel);
    expect(of("BP1234")).toBe(fuel);
    expect(of("BPOST BRUSSELS")).toBeNull();
  });

  test("off, the same rule is the substring it has always been", async () => {
    await post("/api/category-rules", { pattern: "bp", whole_word: false, category_id: fuel, priority: 10 });
    await importRows(["BPOST BRUSSELS"]);
    expect(((await api("/api/expenses")).body as { category_id: number | null }[])[0]!.category_id).toBe(fuel);
  });

  test("a rule written before the column existed defaults to off", async () => {
    // What an older client, or a backup file from before this build, sends.
    const made = await post("/api/category-rules", { pattern: "bp", category_id: fuel, priority: 10 });
    expect(made.body.whole_word).toBe(false);
  });

  test("a backup carries it, and a merge does too", async () => {
    await post("/api/category-rules", { pattern: "bp", whole_word: true, category_id: fuel, priority: 10 });
    const dumped = await (await raw("/api/export")).json();
    expect(dumped.tables.category_rules[0].whole_word).toBe(true);

    await sql.unsafe("DELETE FROM category_rules");
    const merged = await post("/api/category-rules/merge", dumped);
    expect(merged.body.added).toEqual(["bp"]);
    expect(((await api("/api/category-rules")).body as { whole_word: boolean }[])[0]!.whole_word).toBe(true);
  });

  test("the seed ships bp and amc strict, which is what their trailing space meant", async () => {
    await resetDb({ withSeed: true });
    const rules = (await api("/api/category-rules")).body as { pattern: string; whole_word: boolean }[];
    expect(rules.filter((r) => r.whole_word).map((r) => r.pattern).sort()).toEqual(["amc", "bp"]);
  });
});

describe("whole-word bills, end to end", () => {
  let utilities: number;

  beforeEach(async () => {
    await resetDb({ withSeed: true });
    utilities = ((await api("/api/categories")).body as { id: number; name: string; bucket: string }[])
      .find((c) => c.bucket === "fixed")!.id;
  });

  const bill = (body: Record<string, unknown>) =>
    post("/api/fixed-costs", {
      name: "Fuel card", amount_cents: 5000, due_day: 4, lead_days: 3,
      category_id: utilities, active: true, ...body,
    });

  const spend = (txn_date: string, amount_cents: number, merchant: string) =>
    post("/api/expenses", { txn_date, amount_cents, merchant, description: "", category_id: utilities, source: "manual" });

  const actualsFor = async (through: string) =>
    (await api(`/api/fixed-cost-actuals?through=${through}&months=3`)).body as {
      rows: { key: string; merchants: string[]; months_with_data: number; actual_avg_cents: number }[];
    };

  test("the switch survives the round trip", async () => {
    const made = await bill({ merchant_pattern: "bp", merchant_whole_word: true });
    expect(made.status).toBe(201);
    expect(made.body.merchant_whole_word).toBe(true);
    // A boolean column read back as 0/1 would still be truthy; this is the coercion.
    expect((await api(`/api/fixed-costs/${made.body.id}`)).body.merchant_whole_word).toBe(true);

    const off = await put(`/api/fixed-costs/${made.body.id}`, {
      name: "Fuel card", amount_cents: 5000, due_day: 4, lead_days: 3,
      category_id: utilities, merchant_pattern: "bp", merchant_whole_word: false, active: true,
    });
    expect(off.body.merchant_whole_word).toBe(false);
  });

  test("a bill written before the column existed defaults to off", async () => {
    const made = await bill({ merchant_pattern: "bp" });
    expect(made.body.merchant_whole_word).toBe(false);
  });

  test("the pattern is stored trimmed, and padding cannot buy a shorter needle", async () => {
    const made = await bill({ merchant_pattern: "  national grid  " });
    expect(made.body.merchant_pattern).toBe("national grid");
    expect((await bill({ merchant_pattern: "  a  " })).status).toBe(422);
  });

  test("budgeted versus actual stops counting a charge from a longer name", async () => {
    const made = await bill({ merchant_pattern: "bp", merchant_whole_word: true });
    await spend("2026-01-04", 5200, "BP #4021 FUEL");
    await spend("2026-02-04", 4900, "BP1234");
    await spend("2026-03-04", 99900, "BPOST BRUSSELS");

    // through="2026-04", because the window ends the month before: with "2026-03"
    // the March charge is outside it and this passes whatever the matcher does.
    const { rows } = await actualsFor("2026-04");
    const mine = rows.find((r) => r.key === `cost:${made.body.id}`)!;
    expect(mine.merchants.sort()).toEqual(["BP #4021 FUEL", "BP1234"]);
    expect(mine.months_with_data).toBe(2);
    // The BPOST charge would have dragged this from 5050 to 36666.
    expect(mine.actual_avg_cents).toBe(5050);
  });

  test("off, the same bill counts all three", async () => {
    const made = await bill({ merchant_pattern: "bp", merchant_whole_word: false });
    await spend("2026-01-04", 5200, "BP #4021 FUEL");
    await spend("2026-02-04", 4900, "BP1234");
    await spend("2026-03-04", 99900, "BPOST BRUSSELS");

    const { rows } = await actualsFor("2026-04");
    expect(rows.find((r) => r.key === `cost:${made.body.id}`)!.months_with_data).toBe(3);
  });

  test("a backup carries it", async () => {
    await bill({ merchant_pattern: "bp", merchant_whole_word: true });
    const dumped = await (await raw("/api/export")).json();
    expect(dumped.tables.fixed_costs[0].merchant_whole_word).toBe(true);

    await resetDb({ withSeed: true });
    expect((await post("/api/restore", dumped)).status).toBe(200);
    expect(((await api("/api/fixed-costs")).body as { merchant_whole_word: boolean }[])[0]!.merchant_whole_word)
      .toBe(true);
  });
});

describe("rule patterns carry no padding", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  test("the seed ships none, so a fresh database agrees with the contract", async () => {
    const padded = (await sql.unsafe(
      "SELECT pattern FROM category_rules WHERE CHAR_LENGTH(pattern) <> CHAR_LENGTH(TRIM(pattern))",
    )) as { pattern: string }[];
    expect(padded).toEqual([]);
  });

  test("MySQL will not find a trailing space by comparing strings", async () => {
    // Why migration 008 compares lengths. MySQL ignores trailing spaces when it
    // compares strings, so `pattern <> TRIM(pattern)` is false for 'bp ' -- the
    // exact shape the seed used to ship, and the one a value comparison misses.
    const cat = (await sql.unsafe("SELECT id FROM categories LIMIT 1")) as { id: number }[];
    await sql.unsafe("INSERT INTO category_rules (pattern, category_id, priority) VALUES (?, ?, 100)", [
      "bp ", cat[0]!.id,
    ]);

    const byValue = (await sql.unsafe(
      "SELECT pattern FROM category_rules WHERE pattern <> TRIM(pattern)",
    )) as unknown[];
    const byLength = (await sql.unsafe(
      "SELECT pattern FROM category_rules WHERE CHAR_LENGTH(pattern) <> CHAR_LENGTH(TRIM(pattern))",
    )) as { pattern: string }[];

    expect(byValue).toEqual([]);
    expect(byLength.map((r) => r.pattern)).toEqual(["bp "]);
  });
});

describe("merging category rules", () => {
  let groceries: number;
  let dining: number;

  beforeEach(async () => {
    await resetDb({ withSeed: true });
    // The seed ships 94 rules; a merge has to work against a populated set, but
    // starting from empty is what makes each assertion readable.
    await sql.unsafe("DELETE FROM category_rules");
    const cats = (await api("/api/categories")).body as { id: number; name: string }[];
    groceries = cats.find((c) => c.name === "Groceries")!.id;
    dining = cats.find((c) => c.name === "Dining")!.id;
  });

  /**
   * A file from another machine. Its category ids are deliberately nothing like
   * this database's, because that is the whole problem the route solves.
   */
  const file = (rules: unknown[], cats: unknown[] = [{ id: 801, name: "Groceries" }, { id: 802, name: "Dining" }]) =>
    ({ version: 1, tables: { categories: cats, category_rules: rules } });

  const merge = (body: unknown) => post("/api/category-rules/merge", body);
  const rules = async () => (await api("/api/category-rules")).body as
    { id: number; pattern: string; category_id: number; priority: number }[];

  test("rules are re-pointed at the local category of the same name", async () => {
    const res = await merge(file([
      { id: 5, pattern: "wegmans", category_id: 801, priority: 10 },
      { id: 6, pattern: "chipotle", category_id: 802, priority: 20 },
    ]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: ["wegmans", "chipotle"], updated: [], skipped: [] });

    const after = await rules();
    // 801 and 802 do not exist here; the names are what carried across.
    expect(after.find((r) => r.pattern === "wegmans")!.category_id).toBe(groceries);
    expect(after.find((r) => r.pattern === "chipotle")!.category_id).toBe(dining);
  });

  test("a rule you already have is updated in place, however it was capitalised", async () => {
    const mine = await post("/api/category-rules", { pattern: "Wegmans", category_id: dining, priority: 100 });

    const res = await merge(file([{ pattern: "  WEGMANS  ", category_id: 801, priority: 5 }]));
    // Reported as it is stored, which is trimmed.
    expect(res.body).toEqual({ added: [], updated: ["WEGMANS"], skipped: [] });

    const after = await rules();
    // One rule, not two: the matcher lowercases and trims, so these are the same
    // rule and a second one could never have fired.
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(mine.body.id);
    expect(after[0]!.pattern).toBe("WEGMANS");
    expect(after[0]!.category_id).toBe(groceries);
    expect(after[0]!.priority).toBe(5);
  });

  test("a merged pattern is stored trimmed, not as the file spelled it", async () => {
    const res = await merge(file([{ pattern: "  farm stand  ", category_id: 801, priority: 15 }]));
    expect(res.body.added).toEqual(["farm stand"]);
    expect((await rules())[0]!.pattern).toBe("farm stand");
  });

  test("a pattern that is only padding is two characters of nothing", async () => {
    // Trimmed before the length check, so " a " is a one-character needle that
    // would match nearly every merchant, not a three-character pattern.
    const res = await merge(file([{ pattern: "  a  ", category_id: 801, priority: 10 }]));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]!.path).toEqual(["tables", "category_rules", 0, "pattern"]);
    expect(await rules()).toEqual([]);
  });

  test("a rule whose category is not here is skipped, and says which", async () => {
    const res = await merge(file(
      [
        { pattern: "wegmans", category_id: 801, priority: 10 },
        { pattern: "petco", category_id: 803, priority: 10 },
      ],
      [{ id: 801, name: "Groceries" }, { id: 803, name: "Livestock" }],
    ));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      added: ["wegmans"],
      updated: [],
      skipped: [{ pattern: "petco", category: "Livestock" }],
    });
    // The other rule landed: one missing category does not cost you the file.
    expect((await rules()).map((r) => r.pattern)).toEqual(["wegmans"]);
  });

  test("a rule whose category the file did not carry names the id it wanted", async () => {
    const res = await merge(file([{ pattern: "petco", category_id: 999, priority: 10 }], []));
    expect(res.body.skipped).toEqual([{ pattern: "petco", category: "#999" }]);
    expect(await rules()).toEqual([]);
  });

  test("one needle twice in a file is one rule here, the last one", async () => {
    const res = await merge(file([
      { pattern: "wegmans", category_id: 801, priority: 50 },
      { pattern: "WEGMANS", category_id: 802, priority: 5 },
    ]));
    expect(res.body).toEqual({ added: ["WEGMANS"], updated: [], skipped: [] });

    const after = await rules();
    expect(after).toHaveLength(1);
    expect(after[0]!.priority).toBe(5);
    expect(after[0]!.category_id).toBe(dining);
  });

  test("merging the same file twice is the same database", async () => {
    const body = file([
      { pattern: "wegmans", category_id: 801, priority: 10 },
      { pattern: "chipotle", category_id: 802, priority: 20 },
    ]);
    await merge(body);
    const once = await rules();

    const twice = await merge(body);
    expect(twice.body).toEqual({ added: [], updated: ["wegmans", "chipotle"], skipped: [] });
    expect(await rules()).toEqual(once);
  });

  test("a whole backup file merges only its rules, however bad the rest is", async () => {
    const res = await merge({
      version: 1,
      tables: {
        // Enough of a category to be a lookup; the colour it gets wrong is never read.
        categories: [{ id: 801, name: "Groceries", bucket: "invented", color: "not a colour" }],
        category_rules: [{ pattern: "wegmans", category_id: 801, priority: 10 }],
        expenses: [{ txn_date: "garbage", amount_cents: "lots" }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.added).toEqual(["wegmans"]);
    expect((await api("/api/expenses")).body).toEqual([]);
  });

  test("a rule the schema rejects is a 422 that names the field, and nothing lands", async () => {
    const res = await merge(file([
      { pattern: "wegmans", category_id: 801, priority: 10 },
      { pattern: "x", category_id: 802, priority: 20 },
    ]));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]!.path).toEqual(["tables", "category_rules", 1, "pattern"]);
    expect(await rules()).toEqual([]);
  });

  test("a file with no rules in it changes nothing", async () => {
    await post("/api/category-rules", { pattern: "wegmans", category_id: groceries, priority: 100 });
    const res = await merge({ version: 1, tables: {} });
    expect(res.body).toEqual({ added: [], updated: [], skipped: [] });
    expect((await rules()).map((r) => r.pattern)).toEqual(["wegmans"]);
  });

  test("merge does not shadow the crud routes it sits next to", async () => {
    const made = await post("/api/category-rules", { pattern: "wegmans", category_id: groceries, priority: 100 });
    expect((await api(`/api/category-rules/${made.body.id}`)).status).toBe(200);
    expect((await api("/api/category-rules/merge")).status).toBe(422);
    expect((await del(`/api/category-rules/${made.body.id}`)).status).toBe(200);
  });
});

describe("lumpy fund drift", () => {
  let lumpyCategory: number;

  beforeEach(async () => {
    await resetDb({ withSeed: true });
    const cats = (await api("/api/categories")).body as { id: number; name: string; bucket: string }[];
    lumpyCategory = cats.find((c) => c.bucket === "lumpy")!.id;
  });

  const spend = (txn_date: string, amount_cents: number, category_id: number | null) =>
    post("/api/expenses", { txn_date, amount_cents, merchant: "Insurer", description: "", category_id, source: "manual" });

  test("nothing has left the fund until something in the lumpy bucket does", async () => {
    await put("/api/settings", { name: "lumpy_opening_balance_cents", value: "250000" });
    const before = (await api("/api/lumpy-drift")).body;
    expect(before.balance_cents).toBe(250000);
    expect(before.total_cents).toBe(0);
    expect(before.count).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    await spend(today, 120000, lumpyCategory);
    const after = (await api("/api/lumpy-drift")).body;
    expect(after.total_cents).toBe(120000);
    expect(after.count).toBe(1);
    expect(after.items[0].merchant).toBe("Insurer");
  });

  test("discretionary spending is not fund drift, whatever else it is", async () => {
    await put("/api/settings", { name: "lumpy_opening_balance_cents", value: "250000" });
    const cats = (await api("/api/categories")).body as { id: number; bucket: string }[];
    const groceries = cats.find((c) => c.bucket === "discretionary")!.id;
    await spend(new Date().toISOString().slice(0, 10), 9000, groceries);
    expect((await api("/api/lumpy-drift")).body.total_cents).toBe(0);
  });

  test("a transaction dated in the future has not left the account yet", async () => {
    await put("/api/settings", { name: "lumpy_opening_balance_cents", value: "250000" });
    const later = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    await spend(later, 120000, lumpyCategory);
    expect((await api("/api/lumpy-drift")).body.total_cents).toBe(0);
  });

  test("spending from before the balance was set is already accounted for", async () => {
    await put("/api/settings", { name: "lumpy_opening_balance_cents", value: "250000" });
    // You typed the balance in today, so it already reflects last month's payout.
    await spend("2020-01-15", 120000, lumpyCategory);
    const drift = (await api("/api/lumpy-drift")).body;
    expect(drift.total_cents).toBe(0);
    expect(drift.since).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("fixed cost actuals", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  test("a bill budgeted low reports what it has actually been costing", async () => {
    const cats = (await api("/api/categories")).body as { id: number; name: string }[];
    const utilities = cats.find((c) => c.name === "Utilities")!.id;
    await post("/api/fixed-costs", {
      name: "Gas and electric", amount_cents: 9000, due_day: 12, lead_days: 3,
      category_id: utilities, merchant_pattern: null, active: true,
    });
    for (const [date, cents] of [["2025-12-12", 13000], ["2026-01-12", 15000], ["2026-02-12", 14000]] as const) {
      await post("/api/expenses", {
        txn_date: date, amount_cents: cents, merchant: "Utility Co", description: "",
        category_id: utilities, source: "manual",
      });
    }

    const res = await api("/api/fixed-cost-actuals?through=2026-03&months=3");
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { category_name: string }) => r.category_name === "Utilities");
    expect(row.budgeted_cents).toBe(9000);
    expect(row.actual_avg_cents).toBe(14000);
    expect(row.delta_cents).toBe(5000);
    expect(row.months_with_data).toBe(3);
    expect(row.cost_names).toEqual(["Gas and electric"]);
  });

  test("a merchant pattern round-trips and answers for that bill alone", async () => {
    const cats = (await api("/api/categories")).body as { id: number; name: string }[];
    const utilities = cats.find((c) => c.name === "Utilities")!.id;
    const created = await post("/api/fixed-costs", {
      name: "Gas and electric", amount_cents: 9000, due_day: 12, lead_days: 3,
      category_id: utilities, merchant_pattern: "NATIONAL GRID", active: true,
    });
    expect(created.body.merchant_pattern).toBe("NATIONAL GRID");
    await post("/api/fixed-costs", {
      name: "Water", amount_cents: 7200, due_day: 25, lead_days: 3,
      category_id: utilities, merchant_pattern: null, active: true,
    });
    for (const [date, cents] of [["2025-12-12", 13000], ["2026-01-12", 15000], ["2026-02-12", 14000]] as const) {
      await post("/api/expenses", {
        txn_date: date, amount_cents: cents, merchant: "NATIONAL GRID", description: "",
        category_id: utilities, source: "manual",
      });
    }

    const rows = (await api("/api/fixed-cost-actuals?through=2026-03&months=3")).body.rows;
    const bill = rows.find((r: { key: string }) => r.key === `cost:${created.body.id}`);
    expect(bill.matched_by).toBe("merchant");
    expect(bill.actual_avg_cents).toBe(14000);
    expect(bill.delta_cents).toBe(5000);
    expect(bill.merchants).toEqual(["NATIONAL GRID"]);

    // Water is still a category row, and National Grid's money is not inside it.
    const lump = rows.find((r: { matched_by: string }) => r.matched_by === "category");
    expect(lump.cost_names).toEqual(["Water"]);
    expect(lump.months_with_data).toBe(0);
  });

  test("months defaults to 3 and clamps rather than 422s", async () => {
    expect((await api("/api/fixed-cost-actuals?through=2026-03")).body.months).toBe(3);
    expect((await api("/api/fixed-cost-actuals?through=2026-03&months=999")).body.months).toBe(24);
    expect((await api("/api/fixed-cost-actuals?through=2026-03&months=0")).body.months).toBe(1);
  });
});

describe("recurring candidates", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  const monthsAgo = (n: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return d.toISOString().slice(0, 10);
  };
  const spend = (txn_date: string, amount_cents: number, merchant: string) =>
    post("/api/expenses", { txn_date, amount_cents, merchant, description: "", category_id: null, source: "manual" });

  test("two annual charges become one suggestion, with the cycle worked out", async () => {
    await spend(monthsAgo(24), 118000, "ERIE INSURANCE 8829");
    await spend(monthsAgo(12), 124000, "ERIE INSURANCE 9134");

    const res = await api("/api/recurring-candidates");
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { key: string }) => r.key === "ERIE INSURANCE");
    expect(row.frequency_months).toBe(12);
    expect(row.amount_cents).toBe(124000);
    expect(row.occurrences).toHaveLength(2);
    // Never written by this route: it suggests, the Add dialog writes.
    expect((await api("/api/lumpy-items")).body).toEqual([]);
  });

  test("a suggestion stops being one once the item exists", async () => {
    await spend(monthsAgo(24), 60000, "CITY TAX OFFICE");
    await spend(monthsAgo(12), 61000, "CITY TAX OFFICE");
    expect((await api("/api/recurring-candidates")).body.rows).toHaveLength(1);

    await post("/api/lumpy-items", {
      name: "City tax", amount_cents: 61000, frequency_months: 12,
      next_due_date: "2027-01-05", category_id: null, active: true,
    });
    expect((await api("/api/recurring-candidates")).body.rows).toHaveLength(0);
  });

  test("the minimum amount and the window are the caller's to move", async () => {
    await spend(monthsAgo(24), 3000, "SMALL THING");
    await spend(monthsAgo(12), 3000, "SMALL THING");
    expect((await api("/api/recurring-candidates")).body.rows).toHaveLength(0);
    expect((await api("/api/recurring-candidates?min_amount_cents=1000")).body.rows).toHaveLength(1);
    // A twelve-month window cannot hold two sightings of an annual charge.
    expect((await api("/api/recurring-candidates?months=12&min_amount_cents=1000")).body.rows).toHaveLength(0);
  });
});

describe("forecast", () => {
  beforeEach(() => resetDb());

  test("twelve months, and the first one is the month summary", async () => {
    await post("/api/income-streams", { ...semiMonthly, anchor_date: null });
    await post("/api/fixed-costs", {
      name: "Rent", amount_cents: 150000, due_day: 1, lead_days: 3,
      category_id: null, merchant_pattern: null, merchant_whole_word: false, active: true,
    });

    const res = await api("/api/forecast");
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(12);
    expect(res.body.months).toBe(12);

    const month = res.body.rows[0].month as string;
    const summary = (await api(`/api/summary?month=${month}`)).body;
    expect(res.body.rows[0].planned_free_cents).toBe(summary.planned_free_cents);
    expect(res.body.rows[0].income_cents).toBe(summary.income_cents);
  });

  test("the window is the caller's, clamped rather than rejected", async () => {
    expect((await api("/api/forecast?months=3")).body.rows).toHaveLength(3);
    expect((await api("/api/forecast?months=9999")).body.rows).toHaveLength(60);
    expect((await api("/api/forecast?start=2026-03")).body.rows[0].month).toBe("2026-03");
    expect((await api("/api/forecast?start=nonsense")).status).toBe(422);
  });
});

describe("cash position", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  const today = () => new Date().toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  test("the balance is read with what the plan is about to ask of it", async () => {
    await put("/api/settings", { name: "checking_balance_cents", value: "180000" });
    // Weekly pay, so there is always a paycheck ahead inside the window.
    await post("/api/income-streams", {
      name: "Job", amount_cents: 90000, frequency: "weekly", anchor_date: today(),
      day_1: null, day_2: null, day_of_month: null, active: true,
    });

    const res = await api("/api/cash-position");
    expect(res.status).toBe(200);
    expect(res.body.balance_cents).toBe(180000);
    expect(res.body.as_of).toBe(today());
    expect(res.body.days_stale).toBe(0);
    expect(res.body.next_paycheck_date).not.toBeNull();
    expect(res.body.projected_cents).toBe(180000 - res.body.due_before_next_paycheck_cents);
  });

  test("spending recorded since the balance was typed in comes back with it", async () => {
    await put("/api/settings", { name: "checking_balance_cents", value: "180000" });
    const cats = (await api("/api/categories")).body as { id: number; bucket: string }[];
    const groceries = cats.find((c) => c.bucket === "discretionary")!.id;
    const fixed = cats.find((c) => c.bucket === "fixed")!.id;
    const transfer = cats.find((c) => c.bucket === "transfer")!.id;

    const spend = (amount_cents: number, category_id: number) =>
      post("/api/expenses", {
        txn_date: today(), amount_cents, merchant: "Shop", description: "",
        category_id, source: "manual",
      });
    await spend(4300, groceries);
    // A bill is reconciliation in the budget and a withdrawal in the account.
    await spend(21000, fixed);
    // A card payment is the same money leaving twice; counting it would be a lie.
    await spend(50000, transfer);
    // Money dated ahead of today has not moved.
    await post("/api/expenses", {
      txn_date: inDays(10), amount_cents: 99900, merchant: "Later", description: "",
      category_id: groceries, source: "manual",
    });

    const res = await api("/api/cash-position");
    expect(res.body.spent_since_cents).toBe(25300);
    expect(res.body.spent_since_count).toBe(2);
  });

  test("no balance typed in yet is zero, not a crash", async () => {
    const res = await api("/api/cash-position");
    expect(res.status).toBe(200);
    expect(res.body.balance_cents).toBe(0);
    expect(res.body.short).toBe(false);
  });
});

describe("budgeted versus actual, through the API", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  test("a month with no charge for a bill is named, and the bill can be corrected to its actual", async () => {
    const cats = (await api("/api/categories")).body as { id: number; bucket: string }[];
    const utilities = cats.find((c) => c.bucket === "fixed")!.id;
    const made = await post("/api/fixed-costs", {
      name: "Gas and electric", amount_cents: 9000, due_day: 18, lead_days: 2,
      category_id: utilities, merchant_pattern: "national grid", merchant_whole_word: false, active: true,
    });

    // Two of the three complete months before this one have a statement.
    const month = (n: number) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - n);
      return d.toISOString().slice(0, 10);
    };
    for (const n of [1, 3]) {
      await post("/api/expenses", {
        txn_date: month(n), amount_cents: 21000, merchant: "NATIONAL GRID",
        description: "", category_id: utilities, source: "manual",
      });
    }
    // The middle month was imported -- it just has no charge from this bill in
    // it, which is the difference between a missing statement and a missing bill.
    await post("/api/expenses", {
      txn_date: month(2), amount_cents: 8800, merchant: "WEGMANS",
      description: "", category_id: null, source: "manual",
    });

    const res = await api("/api/fixed-cost-actuals?months=3");
    const row = res.body.rows.find((r: { fixed_cost_id: number | null }) => r.fixed_cost_id === made.body.id);
    expect(row.months_with_data).toBe(2);
    // The month with no statement at all is named once, at the top; the month
    // this bill skipped while other bills posted is the row's own badge.
    expect(res.body.months_without_statements).toEqual([]);
    expect(row.missing_months).toHaveLength(1);
    expect(row.actual_avg_cents).toBe(21000);

    // What the "use the actual" button does: the same PUT the edit dialog does.
    const fixed = await put(`/api/fixed-costs/${made.body.id}`, {
      name: "Gas and electric", amount_cents: row.actual_avg_cents, due_day: 18, lead_days: 2,
      category_id: utilities, merchant_pattern: "national grid", merchant_whole_word: false, active: true,
    });
    expect(fixed.body.amount_cents).toBe(21000);
    const after = await api("/api/fixed-cost-actuals?months=3");
    expect(after.body.rows.find((r: { fixed_cost_id: number | null }) => r.fixed_cost_id === made.body.id).delta_cents).toBe(0);
  });
});

describe("a card statement is not the checking account", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  const today = () => new Date().toISOString().slice(0, 10);

  const statement = async (name: string, cash_account: boolean, amount_cents: number) => {
    const profile = await post("/api/import-profiles", {
      name,
      cash_account,
      mapping: {
        date_column: "Date", amount_column: "Amount", debit_column: null, credit_column: null,
        merchant_column: "Merchant", description_column: null, date_format: "auto",
        flip_sign: false, skip_rows: 0,
      },
    });
    expect(profile.status).toBe(201);
    expect(profile.body.cash_account).toBe(cash_account);
    return post("/api/import", {
      filename: `${name}.csv`,
      profile_id: profile.body.id,
      rows: [{
        txn_date: today(), amount_cents, merchant: `${name} purchase`,
        description: "", category_id: null, source: "import",
      }],
    });
  };

  test("a card charge is spending everywhere except the cash tile", async () => {
    await put("/api/settings", { name: "checking_balance_cents", value: "180000" });
    await statement("Big Bank", true, 4300);
    await statement("Airline Card", false, 21000);

    // Both are spending: a card purchase happened on the day it happened, and the
    // budget has always counted it there.
    const month = today().slice(0, 7);
    expect((await api(`/api/summary?month=${month}`)).body.spent.discretionary).toBe(25300);

    // Only the bank charge has left the account. The card is money owed until the
    // card is paid, and that payment is its own row on the bank statement.
    const cash = await api("/api/cash-position");
    expect(cash.body.spent_since_cents).toBe(4300);
    expect(cash.body.spent_since_count).toBe(1);
  });

  test("a format saved before the column existed reads as checking", async () => {
    // Zod defaults it, so a merge from an older backup file cannot arrive without
    // it and quietly stop counting against the balance.
    const merged = await post("/api/import-profiles/merge", {
      version: 1,
      tables: {
        import_profiles: [{
          name: "Old Bank",
          mapping: {
            date_column: "Date", amount_column: "Amount", debit_column: null, credit_column: null,
            merchant_column: "Merchant", description_column: null, date_format: "auto",
            flip_sign: false, skip_rows: 0,
          },
        }],
      },
    });
    expect(merged.body.added).toEqual(["Old Bank"]);
    const saved = ((await api("/api/import-profiles")).body as { name: string; cash_account: boolean }[])
      .find((p) => p.name === "Old Bank")!;
    expect(saved.cash_account).toBe(true);
  });
});

describe("lumpy payments the statements already prove", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  const today = () => new Date().toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  const insurance = (next_due_date: string) => ({
    name: "Car insurance", amount_cents: 120000, frequency_months: 12,
    next_due_date, category_id: null, merchant_pattern: "geico",
    merchant_whole_word: false, active: true,
  });

  test("recording a payment rolls the item forward and takes it off the fund", async () => {
    await put("/api/settings", { name: "lumpy_opening_balance_cents", value: "200000" });
    const item = await post("/api/lumpy-items", insurance(inDays(-3)));
    expect(item.body.merchant_pattern).toBe("geico");
    await post("/api/expenses", {
      txn_date: inDays(-1), amount_cents: 123400, merchant: "GEICO *AUTO 8829",
      description: "", category_id: null, source: "manual",
    });

    const found = await api("/api/lumpy-paid");
    expect(found.status).toBe(200);
    expect(found.body.rows).toHaveLength(1);
    const row = found.body.rows[0];
    expect(row.item.id).toBe(item.body.id);
    expect(row.due_date).toBe(inDays(-3));
    expect(row.expense.amount_cents).toBe(123400);
    expect(row.delta_cents).toBe(3400);
    expect(row.balance_after_cents).toBe(200000 - 123400);

    // The two writes the button makes. Nothing on the server does them for it:
    // the roll-forward is the ordinary PUT, and the balance is hand-kept.
    await put(`/api/lumpy-items/${item.body.id}`, { ...insurance(row.rolls_to) });
    await put("/api/settings", {
      name: "lumpy_opening_balance_cents", value: String(row.balance_after_cents),
    });

    const after = await api("/api/lumpy-paid");
    expect(after.body.rows).toEqual([]);
    expect(after.body.balance_cents).toBe(76600);
    expect((await api(`/api/lumpy-items/${item.body.id}`)).body.next_due_date).toBe(row.rolls_to);
  });

  test("nothing is suggested without a pattern, or without a charge", async () => {
    await post("/api/lumpy-items", { ...insurance(inDays(-3)), merchant_pattern: null });
    await post("/api/expenses", {
      txn_date: today(), amount_cents: 120000, merchant: "GEICO *AUTO 8829",
      description: "", category_id: null, source: "manual",
    });
    expect((await api("/api/lumpy-paid")).body.rows).toEqual([]);

    // A pattern with nothing matching it is just as quiet.
    await post("/api/lumpy-items", { ...insurance(inDays(-3)), name: "Property tax", merchant_pattern: "town of" });
    expect((await api("/api/lumpy-paid")).body.rows).toEqual([]);

    // The control: the same charge, and a pattern that does find it.
    await post("/api/lumpy-items", { ...insurance(inDays(-3)), name: "Insurance" });
    const found = (await api("/api/lumpy-paid")).body.rows;
    expect(found).toHaveLength(1);
    expect(found[0].item.name).toBe("Insurance");
  });
});

describe("this month against what it usually costs", () => {
  beforeEach(() => resetDb({ withSeed: true }));

  const monthsAgo = (n: number, day: number) => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day));
    return d.toISOString().slice(0, 10);
  };

  test("the median of the same stretch of earlier months is the target", async () => {
    const cats = (await api("/api/categories")).body as { id: number; name: string; bucket: string }[];
    const groceries = cats.find((c) => c.bucket === "discretionary")!.id;
    const spend = (txn_date: string, amount_cents: number) =>
      post("/api/expenses", {
        txn_date, amount_cents, merchant: "Shop", description: "", category_id: groceries, source: "manual",
      });

    // The 1st of each month, so the comparison holds whatever day this runs on.
    await spend(monthsAgo(3, 1), 10000);
    await spend(monthsAgo(2, 1), 20000);
    await spend(monthsAgo(1, 1), 30000);
    await spend(monthsAgo(0, 1), 50000);

    const pace = await api("/api/category-pace?months=3");
    expect(pace.status).toBe(200);
    expect(pace.body.months_compared).toHaveLength(3);
    const row = pace.body.rows.find((r: { category_id: number }) => r.category_id === groceries);
    expect(row.month_to_date_cents).toBe(50000);
    expect(row.typical_cents).toBe(20000);
    expect(row.delta_cents).toBe(30000);

    // Fixed bills are not in a discretionary comparison, and asking for them
    // gives their own.
    const fixed = cats.find((c) => c.bucket === "fixed")!.id;
    await spend(monthsAgo(0, 1), 1);
    expect(pace.body.rows.every((r: { bucket: string }) => r.bucket === "discretionary")).toBe(true);
    expect((await api(`/api/category-pace?bucket=fixed`)).body.rows
      .every((r: { bucket: string }) => r.bucket === "fixed")).toBe(true);
    expect(fixed).toBeGreaterThan(0);
  });
});
