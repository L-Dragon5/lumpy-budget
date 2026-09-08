import type { Category, Expense, FixedCost } from "@lumpy/contracts";
import { divRound, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISOMonth } from "./dates";
import { categoryIndex } from "./reports";

export type MonthActual = { month: ISOMonth; amount_cents: Cents };

export type CostVariance = {
  category_id: number;
  category_name: string;
  /** Every active fixed cost pointed at this category. Usually one; rent and its
   *  insurance sharing a category is why the comparison is per category, not per bill. */
  cost_names: string[];
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

/**
 * What the fixed bills are budgeted at versus what they actually cost.
 *
 * Fixed costs are entered as one flat monthly number, which is right for rent and
 * wrong for gas and electric. The expenses are already categorized and every fixed
 * cost already names a category, so the honest number is a join away rather than a
 * feature: a bill budgeted at $90 that has run $140 for three months is quietly
 * eating $50 of discretionary spending every month.
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
  const groups = new Map<number, FixedCost[]>();
  for (const c of costs) {
    if (!c.active || c.category_id === null) continue;
    const g = groups.get(c.category_id) ?? [];
    g.push(c);
    groups.set(c.category_id, g);
  }

  const spend = new Map<number, Map<ISOMonth, Cents>>();
  for (const e of expenses) {
    if (e.category_id === null || !groups.has(e.category_id)) continue;
    const m = d.monthOf(e.txn_date);
    if (!inWindow.has(m)) continue;
    const per = spend.get(e.category_id) ?? new Map<ISOMonth, Cents>();
    per.set(m, (per.get(m) ?? 0) + e.amount_cents);
    spend.set(e.category_id, per);
  }

  const out: CostVariance[] = [];
  for (const [categoryId, group] of groups) {
    const per = spend.get(categoryId) ?? new Map<ISOMonth, Cents>();
    const actual_by_month = window.map((m) => ({ month: m, amount_cents: per.get(m) ?? 0 }));
    const withData = actual_by_month.filter((r) => r.amount_cents !== 0);
    const budgeted = sum(group.map((c) => c.amount_cents));
    const avg = withData.length === 0 ? 0 : divRound(sum(withData.map((r) => r.amount_cents)), withData.length);
    out.push({
      category_id: categoryId,
      category_name: byId.get(categoryId)?.name ?? `#${categoryId}`,
      cost_names: group.map((c) => c.name),
      budgeted_cents: budgeted,
      actual_avg_cents: avg,
      actual_by_month,
      months_with_data: withData.length,
      delta_cents: withData.length === 0 ? 0 : avg - budgeted,
      pct_off: withData.length === 0 || budgeted === 0 ? 0 : ((avg - budgeted) / budgeted) * 100,
    });
  }

  // Biggest surprise first. Rows with nothing imported sort last: they are a
  // missing statement, not a bill that behaves itself.
  return out.sort(
    (a, b) =>
      Number(b.months_with_data > 0) - Number(a.months_with_data > 0) ||
      Math.abs(b.delta_cents) - Math.abs(a.delta_cents) ||
      a.category_name.localeCompare(b.category_name),
  );
}
