import type {
  Category, Expense, FixedCost, IncomeStream, LumpyItem, SavingsGoal,
} from "@lumpy/contracts";

let seq = 0;
const nextId = () => ++seq;

export function stream(p: Partial<IncomeStream> = {}): IncomeStream {
  return {
    id: nextId(),
    name: "Job",
    amount_cents: 200000,
    frequency: "biweekly",
    anchor_date: "2026-01-02",
    day_1: null,
    day_2: null,
    day_of_month: null,
    active: true,
    ...p,
  };
}

export function fixedCost(p: Partial<FixedCost> = {}): FixedCost {
  return {
    id: nextId(),
    name: "Rent",
    amount_cents: 150000,
    due_day: 1,
    lead_days: 3,
    category_id: null,
    active: true,
    ...p,
  };
}

export function lumpy(p: Partial<LumpyItem> = {}): LumpyItem {
  return {
    id: nextId(),
    name: "Car insurance",
    amount_cents: 120000,
    frequency_months: 12,
    next_due_date: "2026-04-15",
    category_id: null,
    active: true,
    ...p,
  };
}

export function goal(p: Partial<SavingsGoal> = {}): SavingsGoal {
  return {
    id: nextId(),
    name: "Emergency fund",
    mode: "fixed",
    amount_cents: 50000,
    percent: null,
    active: true,
    ...p,
  };
}

export function category(p: Partial<Category> = {}): Category {
  return { id: nextId(), name: "Groceries", bucket: "discretionary", color: null, ...p };
}

export function expense(p: Partial<Expense> = {}): Expense {
  return {
    id: nextId(),
    txn_date: "2026-01-15",
    amount_cents: 5000,
    merchant: "Store",
    description: "",
    category_id: null,
    source: "manual",
    import_batch_id: null,
    dedupe_hash: `h${seq}`,
    ...p,
  };
}
