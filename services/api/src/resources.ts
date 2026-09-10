import { Elysia, status } from "elysia";
import {
  category, categoryInput, categoryRule, categoryRuleInput, categoryRuleMergeInput, expenseInput, expenseSplitInput,
  fixedCost, fixedCostInput, importProfile, importProfileInput, importProfileMergeInput,
  incomeStream, incomeStreamInput, expense, importBatch, isoDate, lumpyItem, lumpyItemInput,
  mergeResult, ruleMergeResult, savingsGoal, savingsGoalInput,
} from "@lumpy/contracts";
import type { Expense, ImportBatch } from "@lumpy/contracts";
import { byId, remove, rows } from "@lumpy/db";
import { z } from "zod";
import { crud, deleted, errorBody, idParam, notFound } from "./crud";
import * as store from "./store";

/** Expenses are the only table big enough to need filtering. */
const expenseQuery = z.object({
  start: isoDate.optional(),
  end: isoDate.optional(),
  category_id: z.union([z.literal("none"), z.coerce.number().int().positive()]).optional(),
  q: z.string().optional(),
  // Optional, not defaulted: a zod default lands in the output type, which is what
  // Eden hands the client, and a defaulted param becomes one the caller must pass.
  limit: z.coerce.number().int().optional(),
});

const expenses = new Elysia({ name: "expenses" })
  .get(
    "/expenses",
    async ({ query }) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.start) { where.push("txn_date >= ?"); params.push(query.start); }
      if (query.end) { where.push("txn_date <= ?"); params.push(query.end); }
      if (query.category_id === "none") where.push("category_id IS NULL");
      else if (query.category_id !== undefined) { where.push("category_id = ?"); params.push(query.category_id); }
      if (query.q) { where.push("(merchant LIKE ? OR description LIKE ?)"); params.push(`%${query.q}%`, `%${query.q}%`); }
      where.push(store.NOT_SPLIT_PARENT);
      // Clamped rather than rejected: an out-of-range limit is a caller being loose,
      // not a caller being wrong, and that is how it has always behaved.
      const limit = Math.min(5000, Math.max(1, query.limit ?? 500));
      const found = await rows<Expense>("expenses", where.join(" AND "), params);
      return found.slice(0, limit);
    },
    { query: expenseQuery, response: z.array(expense) },
  )
  .get("/expenses/:id", async ({ params }) => (await byId<Expense>("expenses", params.id)) ?? notFound(), {
    params: idParam,
    response: { 200: expense, 404: errorBody },
  })
  // A manual expense still gets a dedupe hash, so the generic insert will not do.
  .post(
    "/expenses",
    async ({ body }) => status(201, (await byId<Expense>("expenses", await store.insertExpense(body))) as Expense),
    { body: expenseInput, response: { 201: expense } },
  )
  .put(
    "/expenses/:id",
    async ({ params, body }) => {
      if (!(await byId("expenses", params.id))) return notFound();
      await store.updateExpense(params.id, body);
      return (await byId<Expense>("expenses", params.id)) as Expense;
    },
    { params: idParam, body: expenseInput, response: { 200: expense, 404: errorBody } },
  )
  .delete("/expenses/:id", async ({ params }) => ((await remove("expenses", params.id)) ? { deleted: params.id } : notFound()), {
    params: idParam,
    response: { 200: deleted, 404: errorBody },
  })
  /**
   * One charge, more than one category. The charge stays put and gains parts;
   * see `store.splitExpense` for why it is not deleted.
   *
   * `/expenses/:id/split` cannot be read as an id, so unlike `/merge` it needs
   * no ordering care -- it is a second segment, not a value in the first.
   */
  .post(
    "/expenses/:id/split",
    async ({ params, body }) => {
      const res = await store.splitExpense(params.id, body.parts);
      return res.ok ? status(201, res.rows) : status(res.status, { error: res.error });
    },
    {
      params: idParam,
      body: expenseSplitInput,
      response: { 201: z.array(expense), 404: errorBody, 409: errorBody, 422: errorBody },
    },
  )
  .delete(
    "/expenses/:id/split",
    async ({ params }) => ((await store.unsplitExpense(params.id)) > 0 ? { deleted: params.id } : notFound()),
    { params: idParam, response: { 200: deleted, 404: errorBody } },
  );

/** Batches are written by the importer, never by a client. Deleting one takes its expenses with it. */
const importBatches = new Elysia({ name: "import-batches" })
  .get("/import-batches", () => rows<ImportBatch>("import_batches"), { response: z.array(importBatch) })
  .get("/import-batches/:id", async ({ params }) => (await byId<ImportBatch>("import_batches", params.id)) ?? notFound(), {
    params: idParam,
    response: { 200: importBatch, 404: errorBody },
  })
  .delete(
    "/import-batches/:id",
    async ({ params }) => ((await remove("import_batches", params.id)) ? { deleted: params.id } : notFound()),
    { params: idParam, response: { 200: deleted, 404: errorBody } },
  )
  // 405 is a truer answer than the 404 an undeclared route would give.
  .post("/import-batches", () => status(405, { error: "import-batches is not writable" }));

/**
 * Import formats out of a backup file, without the rest of the file coming with
 * them. /restore replaces every table, which is right for cloning a whole
 * environment and wrong for carrying one bank's column mapping to a machine that
 * already has a year of spending on it.
 *
 * Its own route rather than a `?mode=merge` on /restore: one replaces everything
 * and one replaces nothing, and a flag that flips between those two is a flag
 * somebody gets wrong.
 */
const importProfileMerge = new Elysia({ name: "import-profile-merge" })
  .post(
    "/import-profiles/merge",
    ({ body }) => store.mergeImportProfiles(body.tables.import_profiles),
    { body: importProfileMergeInput, response: mergeResult },
  );

/**
 * The same trade for categorization rules, with one difference the shape has to
 * carry: a rule points at a category, so the file's categories ride along as an
 * id -> name lookup and each rule is re-pointed at the local category of that
 * name. A rule whose category is not here comes back in `skipped` rather than
 * taking the other forty down with it.
 */
const categoryRuleMerge = new Elysia({ name: "category-rule-merge" })
  .post(
    "/category-rules/merge",
    ({ body }) => store.mergeCategoryRules(body.tables),
    { body: categoryRuleMergeInput, response: ruleMergeResult },
  );

export const resources = new Elysia({ prefix: "/api" })
  .use(crud("income-streams", "income_streams", incomeStreamInput, incomeStream))
  .use(crud("fixed-costs", "fixed_costs", fixedCostInput, fixedCost))
  .use(crud("lumpy-items", "lumpy_items", lumpyItemInput, lumpyItem))
  .use(crud("savings-goals", "savings_goals", savingsGoalInput, savingsGoal))
  .use(crud("categories", "categories", categoryInput, category))
  // Before its crud block, like the merge below: `/category-rules/:id` would
  // otherwise try to read "merge" as an id.
  .use(categoryRuleMerge)
  .use(crud("category-rules", "category_rules", categoryRuleInput, categoryRule))
  // Before the crud block: `/import-profiles/:id` would otherwise try to read
  // "merge" as an id on any verb they share.
  .use(importProfileMerge)
  .use(crud("import-profiles", "import_profiles", importProfileInput, importProfile))
  .use(expenses)
  .use(importBatches);
