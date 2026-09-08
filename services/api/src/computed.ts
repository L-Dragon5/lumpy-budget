import { Elysia } from "elysia";
import { backup, bulkExpenseInput, isoDate, isoMonth, restoreResult } from "@lumpy/contracts";
import * as core from "@lumpy/budget-core";
import { rows, sql, TABLES, type TableName } from "@lumpy/db";
import { z } from "zod";
import * as store from "./store";

/**
 * Query schemas stay `.optional()` and default in the handler. A zod `.default()`
 * lands in the schema's *output* type, and Eden builds the client's query type
 * from the output -- so a defaulted param becomes one the caller is forced to
 * pass. Optional in, defaulted below, and the client can omit it.
 */
const lumpyMode = z.enum(["steady", "recommended"]).optional();
const MODE = (v: "steady" | "recommended" | undefined) => v ?? "recommended";

/** Out-of-range numbers clamp rather than 422, which is how these have always behaved. */
const clamp = (v: number | undefined, fallback: number, lo: number, hi: number) =>
  v === undefined || Number.isNaN(v) ? fallback : Math.min(hi, Math.max(lo, v));
const num = z.coerce.number().int().optional();

const bucketQuery = z.enum(["discretionary", "fixed", "lumpy", "savings", "transfer", "all"]).optional();

const settingInput = z.object({ name: z.string().min(1).max(60), value: z.string().max(500) });

export const computed = new Elysia({ prefix: "/api" })
  .get("/health", () => ({ ok: true, service: "lumpy-budget" }))

  .get(
    "/summary",
    async ({ query }) => core.monthSummary(await store.budgetInputs(query.month, MODE(query.lumpy_mode))),
    { query: z.object({ month: isoMonth, lumpy_mode: lumpyMode }) },
  )

  .get(
    "/income-calendar",
    async ({ query }) => {
      const year = clamp(query.year, new Date().getFullYear(), 1970, 2999);
      const streams = await store.streams();
      return {
        year,
        months: core.incomeCalendar(streams, year),
        streams: streams.map((x) => ({
          id: x.id,
          name: x.name,
          frequency: x.frequency,
          amount_cents: x.amount_cents,
          extra_paycheck_months: core.extraPaycheckMonths(x, year),
        })),
      };
    },
    { query: z.object({ year: num }) },
  )

  .get(
    "/allocation",
    async ({ query }) => {
      const [s, f, l, g, opening] = await Promise.all([
        store.streams(), store.fixedCosts(), store.lumpyItems(), store.savingsGoals(),
        store.setting("lumpy_opening_balance_cents", "0"),
      ]);
      const income = core.monthlyActual(s, query.month);
      return core.allocateMonth({
        streams: s,
        fixedCosts: f,
        month: query.month,
        lumpyMonthlyCents:
          MODE(query.lumpy_mode) === "steady"
            ? core.steadyMonthlyTotal(l, query.month)
            : core.recommendedMonthlyTotal(l, query.month, Number(opening) || 0),
        savingsMonthlyCents: core.savingsMonthlyTotal(g, income),
      });
    },
    { query: z.object({ month: isoMonth, lumpy_mode: lumpyMode }) },
  )

  .get(
    "/lumpy-timeline",
    async ({ query }) => {
      const stored = Number(await store.setting("lumpy_opening_balance_cents", "0"));
      const opening = query.opening ?? stored;
      const start = query.start ?? core.monthOf(core.todayISO());
      const months = clamp(query.months, 12, 1, 60);
      const items = await store.lumpyItems();
      return {
        ...core.timeline(items, start, months, opening, MODE(query.lumpy_mode)),
        opening_balance_cents: opening,
        plan: core.plan(items, start, opening),
      };
    },
    {
      query: z.object({
        start: isoMonth.optional(),
        months: num,
        opening: num,
        lumpy_mode: lumpyMode,
      }),
    },
  )

  .get(
    "/reports",
    async ({ query }) => {
      const { start, end } = query;
      const granularity = query.granularity ?? "month";
      const bucket = query.bucket ?? "all";
      const [expenses, cats] = await Promise.all([store.expensesBetween(start, end), store.categories()]);
      return {
        start, end, granularity, bucket,
        breakdown: core.breakdown(expenses, cats, { start, end, bucket }),
        series: core.series(expenses, { granularity, start, end, bucket }, cats),
        totals: core.totalsByBucket(expenses.filter((e) => core.inWindow(e, start, end)), cats),
      };
    },
    {
      query: z.object({
        start: isoDate,
        end: isoDate,
        granularity: z.enum(["month", "week"]).optional(),
        bucket: bucketQuery,
      }),
    },
  )

  .post("/import", async ({ body, status }) => status(201, await store.importExpenses(body)), {
    body: bulkExpenseInput,
  })

  .get("/settings", async () => {
    const out = (await sql.unsafe("SELECT name, value FROM settings")) as { name: string; value: string }[];
    return Object.fromEntries(out.map((r) => [r.name, r.value])) as Record<string, string>;
  })

  .put("/settings", async ({ body }) => {
    await store.setSetting(body.name, body.value);
    return { [body.name]: body.value } as Record<string, string>;
  }, { body: settingInput })

  /**
   * How much has left the lumpy fund since its balance was last typed in.
   *
   * The schedule heals itself -- nextDueOnOrAfter rolls a passed due date forward --
   * but the balance cannot. The day the annual insurance is paid, the item jumps to
   * next year while the balance still claims the money is sitting there, so it gets
   * claimed against the next item and the recommended contribution quietly drops.
   * This is the number that makes that drift visible on the page that reads it.
   */
  .get("/lumpy-drift", async () => {
    const row = await store.settingRow("lumpy_opening_balance_cents");
    const today = core.todayISO();
    const since = row?.updated_on ?? today;
    // Bounded at today on purpose: a statement can carry a transaction dated ahead
    // of itself, and money that has not left the account yet is not drift.
    const [cats, expenses] = await Promise.all([
      store.categories(),
      store.expensesBetween(since, today),
    ]);
    const byId = core.categoryIndex(cats);
    const out = expenses.filter((e) => core.bucketOf(e, byId) === "lumpy");
    return {
      since,
      set_at: row?.updated_at ?? null,
      balance_cents: Number(row?.value ?? "0") || 0,
      total_cents: core.sum(out.map((e) => e.amount_cents)),
      count: out.length,
      items: out
        .slice(0, 20)
        .map((e) => ({ id: e.id, txn_date: e.txn_date, merchant: e.merchant, amount_cents: e.amount_cents })),
    };
  })

  /** Budgeted versus what the bills have actually cost. See budget-core/variance.ts. */
  .get(
    "/fixed-cost-actuals",
    async ({ query }) => {
      const through = query.through ?? core.todayISO().slice(0, 7);
      const months = clamp(query.months, 3, 1, 24);
      const [costs, cats] = await Promise.all([store.fixedCosts(), store.categories()]);
      // One month of slack on each end so a bill posted a day late still lands in its month.
      const start = core.monthStart(core.addMonths(through, -(months + 1)));
      const expenses = await store.expensesBetween(start, core.monthEnd(through));
      return {
        through,
        months,
        rows: core.fixedCostVariance(costs, cats, expenses, { through, months }),
      };
    },
    { query: z.object({ through: isoMonth.optional(), months: num }) },
  )

  /**
   * Every table as JSON, in one file, with a filename the browser will save under.
   * POST it back to /import to restore it, here or in another environment. Not a
   * substitute for scripts/backup.ts and mysqldump, which capture the schema too;
   * this captures the data the app knows about, which is the part you typed in.
   */
  .get("/export", async () => {
    const tables: Record<string, unknown[]> = {};
    for (const t of Object.keys(TABLES) as TableName[]) tables[t] = await rows(t);
    tables.settings = (await sql.unsafe("SELECT name, value FROM settings")) as unknown[];
    const body = { version: 1, exported_at: new Date().toISOString(), tables };
    return new Response(JSON.stringify(body, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="lumpy-backup-${core.todayISO()}.json"`,
      },
    });
  })

  /**
   * The other half of /export: take that file back, into a different database or
   * over the top of this one. A replace, not a merge -- the file becomes the new
   * contents of every table -- in one transaction, so a file that fails half way
   * leaves the database exactly as it was.
   *
   * Named /restore rather than /import because /import is already the CSV
   * statement importer, which adds rows; this one replaces them.
   *
   * Validated against the same row schemas /export is checked against, so a real
   * export always loads and a hand-edited one fails at the boundary with the
   * offending field named.
   */
  .post("/restore", async ({ body }) => store.restore(body.tables), {
    body: backup,
    response: restoreResult,
  });
