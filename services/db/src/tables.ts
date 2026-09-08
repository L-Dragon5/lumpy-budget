/**
 * Per-table metadata so every read goes through the same coercion.
 * MySQL hands back DATE as a timezone-shifted Date, BOOLEAN as 0/1, DECIMAL as
 * a string and JSON as text; the app only ever wants ISO strings, booleans,
 * numbers and objects. This table is where that translation lives, once.
 */
export type TableSpec = {
  cols: string[];
  date?: string[];
  /** TIMESTAMP columns: full ISO-8601 strings, not YYYY-MM-DD. */
  datetime?: string[];
  bool?: string[];
  json?: string[];
  num?: string[];
  order: string;
};

export const TABLES = {
  categories: {
    cols: ["id", "name", "bucket", "icon", "color"],
    order: "name ASC",
  },
  income_streams: {
    cols: ["id", "name", "amount_cents", "frequency", "anchor_date", "day_1", "day_2", "day_of_month", "active"],
    date: ["anchor_date"],
    bool: ["active"],
    order: "active DESC, name ASC",
  },
  fixed_costs: {
    cols: [
      "id", "name", "amount_cents", "due_day", "lead_days", "category_id",
      "merchant_pattern", "merchant_whole_word", "active",
    ],
    bool: ["merchant_whole_word", "active"],
    order: "active DESC, due_day ASC, name ASC",
  },
  lumpy_items: {
    cols: ["id", "name", "amount_cents", "frequency_months", "next_due_date", "category_id", "active"],
    date: ["next_due_date"],
    bool: ["active"],
    order: "active DESC, next_due_date ASC",
  },
  savings_goals: {
    cols: ["id", "name", "mode", "amount_cents", "percent", "target_cents", "balance_cents", "active"],
    bool: ["active"],
    num: ["percent"],
    order: "active DESC, name ASC",
  },
  category_rules: {
    cols: ["id", "pattern", "whole_word", "category_id", "priority"],
    bool: ["whole_word"],
    order: "priority ASC, id ASC",
  },
  import_profiles: {
    cols: ["id", "name", "mapping"],
    json: ["mapping"],
    order: "name ASC",
  },
  import_batches: {
    cols: ["id", "filename", "profile_id", "row_count", "inserted", "skipped", "created_at"],
    datetime: ["created_at"],
    order: "created_at DESC, id DESC",
  },
  expenses: {
    cols: ["id", "txn_date", "amount_cents", "merchant", "description", "category_id", "source", "import_batch_id", "dedupe_hash"],
    date: ["txn_date"],
    order: "txn_date DESC, id DESC",
  },
} satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;
export const isTable = (t: string): t is TableName => Object.hasOwn(TABLES, t);
