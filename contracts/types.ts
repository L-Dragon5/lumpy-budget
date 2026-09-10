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

export const frequencySchema = z.enum(["weekly", "biweekly", "semimonthly", "monthly", "annual", "one_time"]);
export type Frequency = z.infer<typeof frequencySchema>;

/**
 * Paychecks per year, used for the normalized monthly average. A one-off is 0:
 * it never repeats, so it must not lift the average you budget against. It lands
 * in that month's actual income and shows up whole as surplus.
 */
export const PER_YEAR: Record<Frequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  annual: 1,
  one_time: 0,
};

/** Occurrences in a "normal" month; anything above this is an extra-paycheck month. */
export const BASELINE_PER_MONTH: Record<Frequency, number> = {
  weekly: 4,
  biweekly: 2,
  semimonthly: 2,
  monthly: 1,
  annual: 0,
  one_time: 0,
};

/**
 * The icons a category can wear. A shared vocabulary rather than a free string,
 * so the API rejects a name nothing can draw; the web app maps each to a glyph.
 */
export const CATEGORY_ICONS = [
  "cart", "utensils", "coffee", "pizza", "wine", "fuel", "bag", "shirt", "tag",
  "film", "music", "gamepad", "ticket", "book", "graduation", "health",
  "stethoscope", "dumbbell", "plane", "car", "bus", "bike", "home", "building",
  "tree", "flower", "hammer", "wrench", "droplet", "zap", "wifi", "phone",
  "laptop", "cloud", "dog", "cat", "baby", "scissors", "gift", "sparkles",
  "repeat", "shield", "landmark", "piggy-bank", "credit-card", "banknote",
  "receipt", "briefcase", "package", "trending-up",
] as const;
export const categoryIconSchema = z.enum(CATEGORY_ICONS);
export type CategoryIconName = (typeof CATEGORY_ICONS)[number];

/**
 * `income` is money arriving, not money leaving. It exists because an imported
 * checking statement writes every deposit as a credit -- a negative expense --
 * and without a bucket of its own a $2,400 paycheck reads as $2,400 of negative
 * discretionary spending: it inflates what is available, it poisons the
 * `categoryPace` median, and it quietly credits the checking balance.
 *
 * Distinct from `transfer` rather than folded into it. Both are neutral against
 * what you can spend, but only one is the number `monthlyActual` is predicting,
 * and matching on a bucket survives somebody renaming the category.
 */
export const bucketSchema = z.enum(["discretionary", "fixed", "lumpy", "savings", "transfer", "income"]);
export type Bucket = z.infer<typeof bucketSchema>;

// ---------------------------------------------------------------- income

export const incomeStreamInput = z
  .object({
    name: z.string().min(1).max(120),
    amount_cents: positiveCents,
    frequency: frequencySchema,
    /** A known pay date. Drives weekly/biweekly/annual/one_time; ignored otherwise. */
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
    if (v.frequency === "one_time")
      need("anchor_date", "one-off income needs an anchor_date (the day it arrives)");
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

/**
 * `GET /api/income-calendar`: each month's plan beside what the bank deposited.
 *
 * Declared so the response validator covers it. Elysia strips a key this does
 * not list, so a field added to the route without being added here never
 * reaches the page -- which is the point: the page reads only what is written
 * down.
 */
export const incomeCalendarMonth = z.object({
  month: isoMonth,
  occurrences: z.array(z.object({ stream_id: id, stream_name: z.string(), date: isoDate, amount_cents: cents })),
  total_cents: cents,
  normalized_cents: cents,
  surplus_cents: cents,
  extra_paycheck: z.boolean(),
  /** Income-bucket rows, as the positive amount that arrived. */
  deposited_cents: cents,
  /** Deposited minus planned; zero in a month with no statement at all. */
  delta_cents: cents,
  deposit_count: z.number().int().min(0),
  imported: z.boolean(),
  /**
   * Credits nobody has categorized, as a positive number. In neither deposited
   * nor the delta; beside a short month it says the gap may be a paycheck that
   * is only waiting on a category.
   */
  uncategorized_credit_cents: positiveCents,
  uncategorized_credit_count: z.number().int().min(0),
});
export const incomeCalendarResult = z.object({
  year: z.number().int(),
  months: z.array(incomeCalendarMonth),
  streams: z.array(z.object({
    id,
    name: z.string(),
    frequency: frequencySchema,
    amount_cents: cents,
    extra_paycheck_months: z.array(isoMonth),
  })),
});
export type IncomeCalendarResult = z.infer<typeof incomeCalendarResult>;

// ------------------------------------------------------------ fixed costs

export const fixedCostInput = z.object({
  name: z.string().min(1).max(120),
  amount_cents: positiveCents,
  /** Day of month the bill is due. 0 means the last day. */
  due_day: z.number().int().min(0).max(31),
  /** Cash must be held this many days before the due date. */
  lead_days: z.number().int().min(0).max(31).default(3),
  category_id: id.nullable().default(null),
  /**
   * How this bill shows up on a statement: a case-insensitive substring of
   * "merchant description", matched the way the importer matches category_rules.
   * Set it and budgeted-vs-actual answers for this bill alone; leave it null and
   * the bill is compared with everything else sharing its category.
   *
   * Trimmed on the way in for the same reason a rule's pattern is: the matcher
   * has always worked on the trimmed needle, so padding only ever reached the
   * column.
   */
  merchant_pattern: z.string().trim().min(2).max(160).nullable().default(null),
  /** See `matchesPattern`: a BP fuel bill is not reconciled by a BPOST charge. */
  merchant_whole_word: z.boolean().default(false),
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
  /**
   * How this bill posts on a statement, matched exactly the way a fixed cost's
   * pattern is. A lumpy item is the one thing in the app whose schedule heals
   * itself while its balance cannot: `nextDueOnOrAfter` rolls a passed due date
   * forward, and the money is still claimed as sitting in the fund. Naming the
   * charge is what lets the app find the payment and offer to record it.
   */
  merchant_pattern: z.string().trim().min(2).max(160).nullable().default(null),
  /** See `matchesPattern`: a BP fuel bill is not reconciled by a BPOST charge. */
  merchant_whole_word: z.boolean().default(false),
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
    /** What the goal is aiming at. Null for an open-ended fund. */
    target_cents: positiveCents.nullable().default(null),
    /** What this bucket holds right now, kept up to date by hand. */
    balance_cents: cents.default(0),
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
  icon: categoryIconSchema.nullable().default(null),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
});
export const category = z.object({ id }).and(categoryInput);
export type CategoryInput = z.infer<typeof categoryInput>;
export type Category = z.infer<typeof category>;

export const categoryRuleInput = z.object({
  /**
   * Case-insensitive substring, matched against "merchant description".
   *
   * Trimmed on the way in, because the matcher works on
   * `pattern.toLowerCase().trim()`: the padding never did anything except show up
   * in the rules table and in the sentence a merge writes back at you. Trimming
   * before the length check is deliberate -- a pattern that is only padding is
   * two characters of nothing, and a one-character needle matches nearly every
   * merchant you have.
   */
  pattern: z.string().trim().min(2).max(160),
  /** See `matchesPattern`: "bp" stops matching BPOST without giving up BP #4021. */
  whole_word: z.boolean().default(false),
  category_id: id,
  priority: z.number().int().default(100),
});
export const categoryRule = z.object({ id }).and(categoryRuleInput);
export type CategoryRuleInput = z.infer<typeof categoryRuleInput>;
export type CategoryRule = z.infer<typeof categoryRule>;

const ruleRef = z.object({ id, pattern: z.string(), category_id: id, priority: z.number().int() });
/**
 * A rule the importer can never reach, and the earlier rule that takes
 * everything it would have matched: one line of `GET /api/category-rules/shadowed`.
 * `shadowedRules` in csv-import decides it; this is only its shape on the wire.
 */
export const shadowedRuleRow = ruleRef.extend({
  /** Both rules point at one category, so the row still lands right: dead weight, not a wrong number. */
  same_category: z.boolean(),
  shadowed_by: ruleRef,
});
export type ShadowedRuleRow = z.infer<typeof shadowedRuleRow>;

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
  .object({
    id,
    import_batch_id: id.nullable().default(null),
    /**
     * The charge this row is one part of, or null.
     *
     * On the row schema and deliberately not on `expenseInput`: a split is its
     * own route, because it has to write every part in one transaction and check
     * that they add up. A field anybody could set would let half a split exist.
     */
    parent_id: id.nullable().default(null),
    dedupe_hash: z.string(),
  })
  .and(expenseInput);
export type ExpenseInput = z.infer<typeof expenseInput>;
export type Expense = z.infer<typeof expense>;

/**
 * One statement row the wizard has been told is a transaction already in the
 * ledger, typed in by hand before the statement arrived. `row_index` indexes
 * `rows`, so the pair only means anything against the array it was posted with.
 *
 * Confirmed by a person, never inferred by the server: `matchManual` proposes,
 * the review step disposes, and this carries only what survived that.
 */
export const absorption = z.object({
  manual_id: id,
  row_index: z.number().int().min(0),
});
export type Absorption = z.infer<typeof absorption>;

/**
 * What `POST /api/expenses/:id/split` accepts.
 *
 * Its own route rather than a field on `expenseInput`, because a split is only
 * valid as a whole: every part is written in one transaction and the parts have
 * to add up to the charge. A field anybody could set would let half a split
 * exist, and half a split is a month counted wrong.
 *
 * The sum is checked on the server against the charge's own amount, not here:
 * this schema has never seen the row.
 */
export const expenseSplitInput = z.object({
  parts: z
    .array(
      z.object({
        /** Signed like any amount: splitting a refund splits a negative. */
        amount_cents: cents,
        category_id: id.nullable().default(null),
        description: z.string().max(500).default(""),
      }),
    )
    .min(2)
    .max(20),
});
export type ExpenseSplitInput = z.infer<typeof expenseSplitInput>;

/** What the import wizard posts: expenses plus the batch metadata. */
export const bulkExpenseInput = z.object({
  filename: z.string().max(255).default("import.csv"),
  profile_id: id.nullable().default(null),
  rows: z.array(expenseInput).min(1).max(20000),
  absorb: z.array(absorption).max(20000).default([]),
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
  /**
   * Does spending on this statement leave the checking account the moment it
   * posts? True for a bank statement, false for a credit card: a card charge is
   * money owed, and it only leaves checking when the card is paid. The cash
   * position reads this, and nothing else does -- the budget still counts a card
   * purchase as spending on the day it happened.
   *
   * Defaults true, which is what every profile that predates the column is.
   */
  cash_account: z.boolean().default(true),
});
export const importProfile = z.object({ id }).and(importProfileInput);
export type ImportProfileInput = z.infer<typeof importProfileInput>;
export type ImportProfile = z.infer<typeof importProfile>;

/**
 * What `POST /api/import-profiles/merge` accepts: a whole backup file, of which
 * only `tables.import_profiles` is read. Zod strips the rest, so a file whose
 * expenses are malformed still merges its profiles -- a merge has no business
 * failing on a table it never touches.
 *
 * Rows come in as `importProfileInput`, without an id: unlike a restore, these
 * land in a database whose ids already mean something, so each profile is
 * matched by its (UNIQUE) name and gets a local id of its own.
 */
export const importProfileMergeInput = z.object({
  version: z.literal(1),
  tables: z.object({ import_profiles: z.array(importProfileInput).default([]) }),
});
export type ImportProfileMergeInput = z.infer<typeof importProfileMergeInput>;

/** Named rather than counted: "which ones did it touch" is the question you ask. */
export const mergeResult = z.object({
  added: z.array(z.string()),
  updated: z.array(z.string()),
});
export type MergeResult = z.infer<typeof mergeResult>;

/**
 * What `POST /api/category-rules/merge` accepts. Rules are not self-contained the
 * way import formats are: every rule points at a category, and the file's
 * `category_id` numbers mean nothing here. `tables.categories` comes along as the
 * lookup, so a rule can be re-pointed at the local category of the same name.
 *
 * Only `id` and `name` are read off a category, and zod strips the rest, so a
 * bucket or colour the file gets wrong cannot block a merge that never writes
 * either.
 */
const categoryRef = z.object({ id, name: z.string() });

export const categoryRuleMergeInput = z.object({
  version: z.literal(1),
  tables: z.object({
    categories: z.array(categoryRef).default([]),
    category_rules: z.array(categoryRuleInput).default([]),
  }),
});
export type CategoryRuleMergeInput = z.infer<typeof categoryRuleMergeInput>;

/** A rule whose category does not exist here, and the name it went looking for. */
export const skippedRule = z.object({ pattern: z.string(), category: z.string() });

/**
 * Rules can be skipped where formats cannot: a destination is allowed to have a
 * different set of categories, and dropping the rules that reference a missing
 * one beats refusing the other forty.
 */
export const ruleMergeResult = mergeResult.extend({ skipped: z.array(skippedRule) });
export type RuleMergeResult = z.infer<typeof ruleMergeResult>;

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

// ------------------------------------------------------------------ backup

export const settingRow = z.object({ name: z.string().min(1).max(60), value: z.string().max(500) });
export type SettingRow = z.infer<typeof settingRow>;

/**
 * A whole database in one file: `GET /api/export` writes it, `POST /api/import`
 * reads it back into an empty environment.
 *
 * Every table is validated by the same row schema the API already returns, so an
 * export is a valid import by construction and a hand-edited file fails at the
 * boundary rather than half way through the restore. Rows keep their `id`,
 * which is what makes every foreign key in the file still point at the right
 * record on the other side. Each table defaults to empty: a partial file
 * (categories and rules, no expenses) is a legitimate thing to hand over.
 */
export const backupTables = z.object({
  categories: z.array(category).default([]),
  income_streams: z.array(incomeStream).default([]),
  savings_goals: z.array(savingsGoal).default([]),
  import_profiles: z.array(importProfile).default([]),
  fixed_costs: z.array(fixedCost).default([]),
  lumpy_items: z.array(lumpyItem).default([]),
  category_rules: z.array(categoryRule).default([]),
  import_batches: z.array(importBatch).default([]),
  expenses: z.array(expense).default([]),
  settings: z.array(settingRow).default([]),
});
export type BackupTables = z.infer<typeof backupTables>;

export const backup = z.object({
  version: z.literal(1),
  exported_at: z.string().optional(),
  tables: backupTables,
});
export type Backup = z.infer<typeof backup>;

/** How many rows of each table the restore actually wrote. */
export const restoreResult = z.object({
  restored: z.record(z.string(), z.number().int()),
  total: z.number().int(),
});
export type RestoreResult = z.infer<typeof restoreResult>;

// ------------------------------------------------------- pattern matching

/**
 * What a pattern actually looks for. Lowercased and trimmed, so the column can
 * hold whatever a person typed and two spellings of one rule are one rule.
 */
export const needleOf = (pattern: string): string => pattern.toLowerCase().trim();

/**
 * What `whole_word` means by "the end of a word": a letter, not a word
 * character, because a merchant descriptor glues its store number straight onto
 * the name and `bp` has to keep finding BP1234.
 *
 * Exported because the shadowed-rule report has to agree with `matchesPattern`
 * about this exactly. Two definitions of a boundary is two answers to whether a
 * rule can fire.
 */
export const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);

/**
 * Does a lowercased "merchant description" contain this needle?
 *
 * Lives here rather than in either consumer because the CSV importer and the
 * budgeted-versus-actual report both have to agree on what a pattern means; a
 * bill that reconciles has to be a transaction the importer would have
 * categorised the same way.
 *
 * `wholeWord` requires a non-letter on each side of the hit, which is what a
 * trailing space in a pattern used to be reaching for and never achieved.
 * Letters, not word characters: a merchant descriptor glues its store number
 * straight onto the name, so `bp` should still find BP1234 while passing over
 * BPOST. Every occurrence is tried, so "BPOST BP #1" matches on the second.
 *
 * Scanned with indexOf rather than built into a RegExp: a pattern is user text
 * and may hold regex metacharacters, and escaping them correctly is a bug
 * waiting to happen for no gain.
 */
/**
 * Collapse the noise a bank glues onto a merchant, so the same purchase always
 * reads the same. `Café  Nero*  1234` is `CAFE NERO 1234`.
 *
 * Lives here, beside `matchesPattern`, for the same reason: the CSV importer
 * hashes it to decide whether it has seen a transaction before, and the
 * recurring-charge detector in budget-core groups by it to decide whether it has
 * seen a *bill* before. Two spellings of "the same merchant" would be two
 * answers to one question.
 */
export const normalizeMerchant = (m: string): string =>
  (m ?? "").normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * The brand without the per-charge noise: the first `words` tokens of the
 * normalized merchant, ignoring pure numbers. A statement writes one year's
 * insurance as `GEICO *AUTO 8829` and the next as `GEICO AUTO PAY 9134`, and
 * only the head of the string survives both.
 *
 * Joining words are skipped, or every municipality in the county collapses into
 * "TOWN OF" and one water bill starts standing for four.
 *
 * ponytail: two words is a heuristic, not a parser. It keeps STATE FARM apart
 * from STATE TAX and folds AMAZON MKTPL 7A into AMAZON MKTPL. That trade is
 * affordable here and nowhere else: nothing is written from this key without a
 * person pressing Add. Widen it to three words if real statements need it.
 */
const SKIP_IN_KEY = new Set(["OF", "THE", "AND"]);

export function merchantKey(merchant: string, words = 2): string {
  const tokens = normalizeMerchant(merchant)
    .split(" ")
    .filter((t) => t.length > 0 && !/^\d+$/.test(t) && !SKIP_IN_KEY.has(t));
  return tokens.slice(0, words).join(" ");
}

export function matchesPattern(haystack: string, needle: string, wholeWord = false): boolean {
  if (needle.length === 0) return false;
  if (!wholeWord) return haystack.includes(needle);
  for (let from = 0; ; from = from + 1) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    // Off either end reads as undefined, which is not a letter, which is a
    // boundary -- exactly right for a match at the start or end of the string.
    if (!isLetter(haystack[at - 1]) && !isLetter(haystack[at + needle.length])) return true;
    from = at;
  }
}
