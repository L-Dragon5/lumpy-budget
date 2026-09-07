import { beforeEach, describe, expect, test } from "bun:test";
import { api, del, post, put, resetDb } from "./setup";

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

  test("a bad body is a 400 that names the field", async () => {
    const res = await post("/api/income-streams", { ...semiMonthly, frequency: "biweekly", anchor_date: null });
    expect(res.status).toBe(400);
    expect(res.body.issues[0]!.path).toBe("anchor_date");

    const bad = await post("/api/fixed-costs", { name: "", amount_cents: -5, due_day: 99 });
    expect(bad.status).toBe(400);
    expect(bad.body.issues.map((i: { path: string }) => i.path).sort()).toEqual(["amount_cents", "due_day", "name"]);
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

  test("a manual expense cannot be entered twice by accident", async () => {
    const body = { txn_date: "2026-03-18", amount_cents: 999, merchant: "Cash", description: "", category_id: null, source: "manual" };
    expect((await post("/api/expenses", body)).status).toBe(201);
    const dupe = await post("/api/expenses", body);
    expect(dupe.status).toBe(409);
    expect(dupe.body.error).toBe("that record already exists");
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
    await post("/api/fixed-costs", { name: "Rent", amount_cents: 150000, due_day: 1, lead_days: 3, category_id: null, active: true });
    await post("/api/fixed-costs", { name: "Internet", amount_cents: 8000, due_day: 20, lead_days: 3, category_id: null, active: true });
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
    expect((await api("/api/summary?month=March")).status).toBe(400);
    expect((await api("/api/summary")).status).toBe(400);
    expect((await api("/api/allocation?month=2026-3")).status).toBe(400);
    expect((await api("/api/reports?start=2026-03-01")).status).toBe(400);
  });
});
