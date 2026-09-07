import { Elysia } from "elysia";
import { bulkExpenseInput, isoDate, isoMonth } from "@lumpy/contracts";
import * as core from "@lumpy/budget-core";
import { sql } from "@lumpy/db";
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
  }, { body: settingInput });
