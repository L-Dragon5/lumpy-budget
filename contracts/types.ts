import { z } from "zod";

/**
 * One shape for the whole stack. snake_case from the MySQL column all the way
 * to the React prop, so nothing needs a mapping layer that can drift.
 * Money is always integer cents; dates are always `YYYY-MM-DD` strings.
 */

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const isoMonth = z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM");
export const cents = z.number().int();
export const positiveCents = z.number().int().min(0);
export const id = z.number().int().positive();

export const frequencySchema = z.enum(["weekly", "biweekly", "semimonthly", "monthly", "annual"]);
export type Frequency = z.infer<typeof frequencySchema>;

/** Paychecks per year, used for the normalized monthly average. */
export const PER_YEAR: Record<Frequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  annual: 1,
};

/** Occurrences in a "normal" month; anything above this is an extra-paycheck month. */
export const BASELINE_PER_MONTH: Record<Frequency, number> = {
  weekly: 4,
  biweekly: 2,
  semimonthly: 2,
  monthly: 1,
  annual: 0,
};

export const bucketSchema = z.enum(["discretionary", "fixed", "lumpy", "savings", "transfer"]);
export type Bucket = z.infer<typeof bucketSchema>;

// ---------------------------------------------------------------- income

export const incomeStreamInput = z
  .object({
    name: z.string().min(1).max(120),
    amount_cents: positiveCents,
    frequency: frequencySchema,
    /** A known pay date. Drives weekly/biweekly/annual; ignored otherwise. */
    anchor_date: isoDate.nullable().default(null),
    /** Semimonthly pay days. 0 in day_2 means "last day of the month". */
    day_1: z.number().int().min(0).max(31).nullable().default(null),
    day_2: z.number().int().min(0).max(31).nullable().default(null),
    /** Monthly pay day. 0 means "last day of the month". */
    day_of_month: z.number().int().min(0).max(31).nullable().default(null),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    const need = (field: keyof typeof v, why: string) => {
      if (v[field] === null || v[field] === undefined)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: why });
    };
    if (v.frequency === "weekly" || v.frequency === "biweekly" || v.frequency === "annual")
      need("anchor_date", `${v.frequency} income needs an anchor_date (a known pay date)`);
    if (v.frequency === "semimonthly") {
      need("day_1", "semimonthly income needs day_1");
      need("day_2", "semimonthly income needs day_2 (0 = last day of month)");
    }
    if (v.frequency === "monthly")
      need("day_of_month", "monthly income needs day_of_month (0 = last day of month)");
  });

export const incomeStream = z.object({ id }).and(incomeStreamInput);
export type IncomeStreamInput = z.infer<typeof incomeStreamInput>;
export type IncomeStream = z.infer<typeof incomeStream>;

// ------------------------------------------------------------ fixed costs

export const fixedCostInput = z.object({
  name: z.string().min(1).max(120),
  amount_cents: positiveCents,
  /** Day of month the bill is due. 0 means the last day. */
  due_day: z.number().int().min(0).max(31),
  /** Cash must be held this many days before the due date. */
  lead_days: z.number().int().min(0).max(31).default(3),
  category_id: id.nullable().default(null),
  active: z.boolean().default(true),
});
export const fixedCost = z.object({ id }).and(fixedCostInput);
export type FixedCostInput = z.infer<typeof fixedCostInput>;
export type FixedCost = z.infer<typeof fixedCost>;

// ------------------------------------------------------------- lumpy fund

export const lumpyItemInput = z.object({
  name: z.string().min(1).max(120),
  /** What it costs each time it comes due. */
  amount_cents: positiveCents,
  /** Months between occurrences: 1 monthly, 3 quarterly, 12 annual, 24 biennial. */
  frequency_months: z.number().int().min(1).max(120),
  next_due_date: isoDate,
  category_id: id.nullable().default(null),
  active: z.boolean().default(true),
});
export const lumpyItem = z.object({ id }).and(lumpyItemInput);
export type LumpyItemInput = z.infer<typeof lumpyItemInput>;
export type LumpyItem = z.infer<typeof lumpyItem>;

// ---------------------------------------------------------- savings goals

export const savingsGoalInput = z
  .object({
    name: z.string().min(1).max(120),
    mode: z.enum(["fixed", "percent"]),
    /** Per month, when mode is "fixed". */
    amount_cents: positiveCents.nullable().default(null),
    /** Of that month's net income, when mode is "percent". */
    percent: z.number().min(0).max(100).nullable().default(null),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "fixed" && v.amount_cents === null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount_cents"], message: "fixed goal needs amount_cents" });
    if (v.mode === "percent" && v.percent === null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["percent"], message: "percent goal needs percent" });
  });
export const savingsGoal = z.object({ id }).and(savingsGoalInput);
export type SavingsGoalInput = z.infer<typeof savingsGoalInput>;
export type SavingsGoal = z.infer<typeof savingsGoal>;

// ------------------------------------------------- categories and rules

export const categoryInput = z.object({
  name: z.string().min(1).max(80),
  bucket: bucketSchema.default("discretionary"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
});
export const category = z.object({ id }).and(categoryInput);
export type CategoryInput = z.infer<typeof categoryInput>;
export type Category = z.infer<typeof category>;

export const categoryRuleInput = z.object({
  /** Case-insensitive substring, matched against "merchant description". */
  pattern: z.string().min(2).max(160),
  category_id: id,
  priority: z.number().int().default(100),
});
export const categoryRule = z.object({ id }).and(categoryRuleInput);
export type CategoryRuleInput = z.infer<typeof categoryRuleInput>;
export type CategoryRule = z.infer<typeof categoryRule>;

// ---------------------------------------------------------------- expenses

export const expenseInput = z.object({
  txn_date: isoDate,
  /** Positive is money out. A refund is negative. */
  amount_cents: cents,
  merchant: z.string().min(1).max(200),
  description: z.string().max(500).default(""),
  category_id: id.nullable().default(null),
  source: z.string().max(80).default("manual"),
});
export const expense = z
  .object({ id, import_batch_id: id.nullable().default(null), dedupe_hash: z.string() })
  .and(expenseInput);
export type ExpenseInput = z.infer<typeof expenseInput>;
export type Expense = z.infer<typeof expense>;

/** What the import wizard posts: expenses plus the batch metadata. */
export const bulkExpenseInput = z.object({
  filename: z.string().max(255).default("import.csv"),
  profile_id: id.nullable().default(null),
  rows: z.array(expenseInput).min(1).max(20000),
});
export type BulkExpenseInput = z.infer<typeof bulkExpenseInput>;

// -------------------------------------------------------- import profiles

export const importMapping = z.object({
  date_column: z.string(),
  /** Single signed amount column, or null when the file splits debit/credit. */
  amount_column: z.string().nullable().default(null),
  debit_column: z.string().nullable().default(null),
  credit_column: z.string().nullable().default(null),
  merchant_column: z.string(),
  description_column: z.string().nullable().default(null),
  date_format: z.enum(["auto", "YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "MM-DD-YYYY", "DD-MM-YYYY"]).default("auto"),
  /** true when the file writes spending as a negative number (most banks). */
  flip_sign: z.boolean().default(false),
  skip_rows: z.number().int().min(0).max(50).default(0),
});
export type ImportMapping = z.infer<typeof importMapping>;

export const importProfileInput = z.object({
  name: z.string().min(1).max(120),
  mapping: importMapping,
});
export const importProfile = z.object({ id }).and(importProfileInput);
export type ImportProfileInput = z.infer<typeof importProfileInput>;
export type ImportProfile = z.infer<typeof importProfile>;

export const importBatch = z.object({
  id,
  filename: z.string(),
  profile_id: id.nullable(),
  row_count: z.number().int(),
  inserted: z.number().int(),
  skipped: z.number().int(),
  created_at: z.string(),
});
export type ImportBatch = z.infer<typeof importBatch>;
