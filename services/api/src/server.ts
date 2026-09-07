import { bulkExpenseInput } from "@lumpy/contracts";
import * as core from "@lumpy/budget-core";
import { byId, insert, remove, rows, sql, update } from "@lumpy/db";
import { z } from "zod";
import { fail, guard, intParam, isDate, isMonth, json, parseBody, preflight } from "./http";
import { RESOURCES } from "./resources";
import * as store from "./store";

const port = Number(process.env.API_PORT ?? 3001);
const lumpyMode = (v: string | null): "steady" | "recommended" => (v === "steady" ? "steady" : "recommended");

// ------------------------------------------------------------------ CRUD

async function listResource(name: string, url: URL): Promise<Response> {
  const res = RESOURCES[name];
  if (!res) return fail(`unknown resource: ${name}`, 404);
  if (res.table !== "expenses") return json(await rows(res.table));

  // Expenses are the only table big enough to need filtering.
  const where: string[] = [];
  const params: unknown[] = [];
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const category = url.searchParams.get("category_id");
  const q = url.searchParams.get("q");
  if (isDate(start)) { where.push("txn_date >= ?"); params.push(start); }
  if (isDate(end)) { where.push("txn_date <= ?"); params.push(end); }
  if (category === "none") where.push("category_id IS NULL");
  else if (category) { where.push("category_id = ?"); params.push(Number(category)); }
  if (q) { where.push("(merchant LIKE ? OR description LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
  const limit = Math.min(5000, Math.max(1, intParam(url.searchParams.get("limit"), 500)));
  return json(await rows(res.table, where.join(" AND "), params).then((r) => r.slice(0, limit)));
}

async function createResource(name: string, req: Request): Promise<Response> {
  const res = RESOURCES[name];
  if (!res) return fail(`unknown resource: ${name}`, 404);
  if (res.readonly) return fail(`${name} is not writable`, 405);
  const body = await parseBody(req, res.schema);
  if (!body.ok) return body.response;
  const id =
    res.table === "expenses"
      ? await store.insertExpense(body.data)
      : await insert(res.table, body.data as Record<string, unknown>);
  return json(await byId(res.table, id), 201);
}

async function updateResource(name: string, id: number, req: Request): Promise<Response> {
  const res = RESOURCES[name];
  if (!res) return fail(`unknown resource: ${name}`, 404);
  if (res.readonly) return fail(`${name} is not writable`, 405);
  const existing = await byId(res.table, id);
  if (!existing) return fail("not found", 404);
  const body = await parseBody(req, res.schema);
  if (!body.ok) return body.response;
  await update(res.table, id, body.data as Record<string, unknown>);
  return json(await byId(res.table, id));
}

async function deleteResource(name: string, id: number): Promise<Response> {
  const res = RESOURCES[name];
  if (!res) return fail(`unknown resource: ${name}`, 404);
  const affected = await remove(res.table, id);
  return affected ? json({ deleted: id }) : fail("not found", 404);
}

// ------------------------------------------------------------- computed

async function summary(url: URL): Promise<Response> {
  const month = url.searchParams.get("month");
  if (!isMonth(month)) return fail("month must be YYYY-MM");
  const input = await store.budgetInputs(month, lumpyMode(url.searchParams.get("lumpy_mode")));
  return json(core.monthSummary(input));
}

async function incomeCalendar(url: URL): Promise<Response> {
  const year = intParam(url.searchParams.get("year"), new Date().getFullYear());
  if (year < 1970 || year > 2999) return fail("year out of range");
  const s = await store.streams();
  return json({
    year,
    months: core.incomeCalendar(s, year),
    streams: s.map((x) => ({
      id: x.id,
      name: x.name,
      frequency: x.frequency,
      amount_cents: x.amount_cents,
      extra_paycheck_months: core.extraPaycheckMonths(x, year),
    })),
  });
}

async function allocation(url: URL): Promise<Response> {
  const month = url.searchParams.get("month");
  if (!isMonth(month)) return fail("month must be YYYY-MM");
  const mode = lumpyMode(url.searchParams.get("lumpy_mode"));
  const [s, f, l, g, opening] = await Promise.all([
    store.streams(), store.fixedCosts(), store.lumpyItems(), store.savingsGoals(),
    store.setting("lumpy_opening_balance_cents", "0"),
  ]);
  const income = core.monthlyActual(s, month);
  return json(
    core.allocateMonth({
      streams: s,
      fixedCosts: f,
      month,
      lumpyMonthlyCents:
        mode === "steady"
          ? core.steadyMonthlyTotal(l, month)
          : core.recommendedMonthlyTotal(l, month, Number(opening) || 0),
      savingsMonthlyCents: core.savingsMonthlyTotal(g, income),
    }),
  );
}

async function lumpyTimeline(url: URL): Promise<Response> {
  const start = url.searchParams.get("start") ?? core.monthOf(core.todayISO());
  if (!isMonth(start)) return fail("start must be YYYY-MM");
  const months = Math.min(60, Math.max(1, intParam(url.searchParams.get("months"), 12)));
  const stored = Number(await store.setting("lumpy_opening_balance_cents", "0"));
  const openingParam = url.searchParams.get("opening");
  const opening = openingParam === null ? stored : intParam(openingParam, stored);
  const items = await store.lumpyItems();
  return json({
    ...core.timeline(items, start, months, opening, lumpyMode(url.searchParams.get("lumpy_mode"))),
    opening_balance_cents: opening,
    plan: core.plan(items, start, opening),
  });
}

async function reports(url: URL): Promise<Response> {
  const granularity = url.searchParams.get("granularity") === "week" ? "week" : "month";
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!isDate(start) || !isDate(end)) return fail("start and end must be YYYY-MM-DD");
  const bucketParam = url.searchParams.get("bucket") ?? "all";
  const bucket = ["discretionary", "fixed", "lumpy", "savings", "transfer", "all"].includes(bucketParam)
    ? (bucketParam as never)
    : "all";
  const [expenses, cats] = await Promise.all([store.expensesBetween(start, end), store.categories()]);
  return json({
    start, end, granularity, bucket,
    breakdown: core.breakdown(expenses, cats, { start, end, bucket }),
    series: core.series(expenses, { granularity, start, end, bucket }, cats),
    totals: core.totalsByBucket(expenses.filter((e) => core.inWindow(e, start, end)), cats),
  });
}

async function runImport(req: Request): Promise<Response> {
  const body = await parseBody(req, bulkExpenseInput);
  if (!body.ok) return body.response;
  return json(await store.importExpenses(body.data), 201);
}

const settingSchema = z.object({ name: z.string().min(1).max(60), value: z.string().max(500) });

async function settings(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const out = (await sql.unsafe("SELECT name, value FROM settings")) as { name: string; value: string }[];
    return json(Object.fromEntries(out.map((r) => [r.name, r.value])));
  }
  const body = await parseBody(req, settingSchema);
  if (!body.ok) return body.response;
  await store.setSetting(body.data.name, body.data.value);
  return json({ [body.data.name]: body.data.value });
}

// ---------------------------------------------------------------- server

export const server = Bun.serve({
  port,
  routes: {
    "/api/health": () => json({ ok: true, service: "lumpy-budget" }),
    "/api/summary": (req) => (req.method === "OPTIONS" ? preflight() : summary(new URL(req.url))),
    "/api/income-calendar": (req) => incomeCalendar(new URL(req.url)),
    "/api/allocation": (req) => allocation(new URL(req.url)),
    "/api/lumpy-timeline": (req) => lumpyTimeline(new URL(req.url)),
    "/api/reports": (req) => reports(new URL(req.url)),
    "/api/import": {
      POST: (req) => guard(() => runImport(req)),
      OPTIONS: () => preflight(),
    },
    "/api/settings": {
      GET: (req) => settings(req),
      PUT: (req) => settings(req),
      OPTIONS: () => preflight(),
    },
    "/api/:resource": {
      GET: (req) => listResource(req.params.resource, new URL(req.url)),
      POST: (req) => guard(() => createResource(req.params.resource, req)),
      OPTIONS: () => preflight(),
    },
    "/api/:resource/:id": {
      GET: async (req) => {
        const res = RESOURCES[req.params.resource];
        if (!res) return fail("unknown resource", 404);
        const row = await byId(res.table, Number(req.params.id));
        return row ? json(row) : fail("not found", 404);
      },
      PUT: (req) => guard(() => updateResource(req.params.resource, Number(req.params.id), req)),
      DELETE: (req) => guard(() => deleteResource(req.params.resource, Number(req.params.id))),
      OPTIONS: () => preflight(),
    },
  },
  error(err) {
    console.error(err);
    return fail(err.message ?? "internal error", 500);
  },
  fetch: () => fail("not found", 404),
});

if (import.meta.main) console.log(`lumpy-budget api on http://localhost:${server.port}`);
