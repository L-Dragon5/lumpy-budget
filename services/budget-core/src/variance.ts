import { matchesPattern, needleOf } from "@lumpy/contracts";
import type { Category, Expense, FixedCost } from "@lumpy/contracts";
import { divRound, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISOMonth } from "./dates";
import { categoryIndex } from "./reports";

export type MonthActual = { month: ISOMonth; amount_cents: Cents };

export type CostVariance = {
  /** `cost:12` when one bill was matched by its merchant, `category:15` for a group. */
  key: string;
  /** How the actuals were found. A named merchant is per bill; a category is a lump. */
  matched_by: "merchant" | "category";
  /** The pattern that did the matching, when one did. */
  merchant_pattern: string | null;
  category_id: number | null;
  category_name: string;
  /** The bill, or every bill sharing the category. */
  cost_names: string[];
  /** Distinct merchants seen, so a wrong pattern is visible rather than just wrong. */
  merchants: string[];
  budgeted_cents: Cents;
  actual_avg_cents: Cents;
  actual_by_month: MonthActual[];
  /**
   * Months in the window that actually had a transaction. The average divides by
   * this, not by the window length: a month with no matching expense is a
   * statement you have not imported, not a month the gas company forgot to bill.
   */
  months_with_data: number;
  /** Actual minus budgeted. Positive means the bill costs more than it is planned at. */
  delta_cents: Cents;
  pct_off: number;
};

/** The same haystack the importer matches category_rules against. */
const hay = (e: Pick<Expense, "merchant" | "description">): string =>
  `${e.merchant} ${e.description ?? ""}`.toLowerCase();

/**
 * What the fixed bills are budgeted at versus what they actually cost.
 *
 * Fixed costs are entered as one flat monthly number, which is right for rent and
 * wrong for gas and electric. The expenses are already categorized and every fixed
 * cost already names a category, so the honest number is a join away rather than a
 * feature: a bill budgeted at $90 that has run $215 for three months is quietly
 * eating $125 of discretionary spending every month.
 *
 * A bill with a `merchant_pattern` is answered on its own. Without one it can only
 * be compared alongside everything sharing its category, which is honest but blunt:
 * four bills under one Utilities category, three of them never imported, read as a
 * category miles under budget rather than as three missing statements.
 *
 * Only complete months count. `through` is normally the current month, which is
 * half-billed and would drag every average down, so the window ends the month before.
 */
export function fixedCostVariance(
  costs: FixedCost[],
  categories: Category[],
  expenses: Expense[],
  opts: { through: ISOMonth; months?: number },
): CostVariance[] {
  const n = Math.max(1, opts.months ?? 3);
  const last = d.addMonths(opts.through, -1);
  const window = d.monthRange(d.addMonths(last, -(n - 1)), n);
  const inWindow = new Set(window);
  const byId = categoryIndex(categories);

  const active = costs.filter((c) => c.active);
  const rows = expenses.filter((e) => inWindow.has(d.monthOf(e.txn_date)));

  // Longest pattern first so a specific one wins over a broad one that contains it
  // ("national grid" over "grid"), with the id breaking ties so the result is stable.
  // A whole-word pattern is not sorted ahead of a plain one: length still decides,
  // and a bill that wants to win against a longer pattern says so with a longer one.
  const matchers = active
    .filter((c) => (c.merchant_pattern ?? "").trim().length > 0)
    .map((c) => ({ cost: c, needle: needleOf(c.merchant_pattern!) }))
    .sort((a, b) => b.needle.length - a.needle.length || a.cost.id - b.cost.id);

  // An expense a pattern claimed is spoken for. Letting it also count toward its
  // category would bill the same transaction twice in the same table.
  const claimed = new Map<number, Expense[]>();
  const spare: Expense[] = [];
  for (const e of rows) {
    const h = hay(e);
    const hit = matchers.find((m) => matchesPattern(h, m.needle, m.cost.merchant_whole_word));
    if (hit) (claimed.get(hit.cost.id) ?? claimed.set(hit.cost.id, []).get(hit.cost.id)!).push(e);
    else spare.push(e);
  }

  const summarize = (
    base: Omit<CostVariance, "actual_avg_cents" | "actual_by_month" | "months_with_data" | "delta_cents" | "pct_off" | "merchants">,
    matched: Expense[],
  ): CostVariance => {
    const per = new Map<ISOMonth, Cents>();
    for (const e of matched) {
      const m = d.monthOf(e.txn_date);
      per.set(m, (per.get(m) ?? 0) + e.amount_cents);
    }
    const actual_by_month = window.map((m) => ({ month: m, amount_cents: per.get(m) ?? 0 }));
    const withData = actual_by_month.filter((r) => r.amount_cents !== 0);
    const avg = withData.length === 0 ? 0 : divRound(sum(withData.map((r) => r.amount_cents)), withData.length);
    return {
      ...base,
      merchants: [...new Set(matched.map((e) => e.merchant))].sort(),
      actual_avg_cents: avg,
      actual_by_month,
      months_with_data: withData.length,
      delta_cents: withData.length === 0 ? 0 : avg - base.budgeted_cents,
      pct_off:
        withData.length === 0 || base.budgeted_cents === 0
          ? 0
          : ((avg - base.budgeted_cents) / base.budgeted_cents) * 100,
    };
  };

  const out: CostVariance[] = [];

  for (const { cost } of matchers) {
    out.push(
      summarize(
        {
          key: `cost:${cost.id}`,
          matched_by: "merchant",
          merchant_pattern: cost.merchant_pattern,
          category_id: cost.category_id,
          category_name: cost.category_id === null ? "" : byId.get(cost.category_id)?.name ?? `#${cost.category_id}`,
          cost_names: [cost.name],
          budgeted_cents: cost.amount_cents,
        },
        claimed.get(cost.id) ?? [],
      ),
    );
  }

  const groups = new Map<number, FixedCost[]>();
  for (const c of active) {
    if (c.category_id === null || (c.merchant_pattern ?? "").trim().length > 0) continue;
    const g = groups.get(c.category_id) ?? [];
    g.push(c);
    groups.set(c.category_id, g);
  }

  for (const [categoryId, group] of groups) {
    out.push(
      summarize(
        {
          key: `category:${categoryId}`,
          matched_by: "category",
          merchant_pattern: null,
          category_id: categoryId,
          category_name: byId.get(categoryId)?.name ?? `#${categoryId}`,
          cost_names: group.map((c) => c.name),
          budgeted_cents: sum(group.map((c) => c.amount_cents)),
        },
        spare.filter((e) => e.category_id === categoryId),
      ),
    );
  }

  // Biggest surprise first. Rows with nothing imported sort last: they are a
  // missing statement, not a bill that behaves itself.
  return out.sort(
    (a, b) =>
      Number(b.months_with_data > 0) - Number(a.months_with_data > 0) ||
      Math.abs(b.delta_cents) - Math.abs(a.delta_cents) ||
      a.cost_names.join().localeCompare(b.cost_names.join()),
  );
}
