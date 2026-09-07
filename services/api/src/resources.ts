import {
  categoryInput, categoryRuleInput, expenseInput, fixedCostInput, importProfileInput,
  incomeStreamInput, lumpyItemInput, savingsGoalInput,
} from "@lumpy/contracts";
import type { TableName } from "@lumpy/db";
import type { z } from "zod";

/** URL segment -> table + the schema every write to it must satisfy. */
export const RESOURCES: Record<string, { table: TableName; schema: z.ZodTypeAny; readonly?: boolean }> = {
  "income-streams": { table: "income_streams", schema: incomeStreamInput },
  "fixed-costs": { table: "fixed_costs", schema: fixedCostInput },
  "lumpy-items": { table: "lumpy_items", schema: lumpyItemInput },
  "savings-goals": { table: "savings_goals", schema: savingsGoalInput },
  categories: { table: "categories", schema: categoryInput },
  "category-rules": { table: "category_rules", schema: categoryRuleInput },
  "import-profiles": { table: "import_profiles", schema: importProfileInput },
  "import-batches": { table: "import_batches", schema: importProfileInput, readonly: true },
  expenses: { table: "expenses", schema: expenseInput },
};
