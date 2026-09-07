import type { Bucket, Category, Expense } from "@lumpy/contracts";
import { sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISODate } from "./dates";

export const UNCATEGORIZED = "Uncategorized";

/** Anything without a category counts as discretionary: it is safer to over-report spending. */
export function bucketOf(e: Pick<Expense, "category_id">, byId: Map<number, Category>): Bucket {
  return (e.category_id !== null ? byId.get(e.category_id)?.bucket : undefined) ?? "discretionary";
}

export const categoryIndex = (categories: Category[]): Map<number, Category> =>
  new Map(categories.map((c) => [c.id, c]));

export const inWindow = (e: { txn_date: ISODate }, start: ISODate, end: ISODate): boolean =>
  d.compare(e.txn_date, start) >= 0 && d.compare(e.txn_date, end) <= 0;

export type BucketTotals = Record<Bucket, Cents> & { total: Cents };

export function totalsByBucket(expenses: Expense[], categories: Category[]): BucketTotals {
  const byId = categoryIndex(categories);
  const out: BucketTotals = {
    discretionary: 0,
    fixed: 0,
    lumpy: 0,
    savings: 0,
    transfer: 0,
    total: 0,
  };
  for (const e of expenses) {
    out[bucketOf(e, byId)] += e.amount_cents;
    out.total += e.amount_cents;
  }
  return out;
}

export type CategorySlice = {
  category_id: number | null;
  name: string;
  color: string | null;
  bucket: Bucket;
  amount_cents: Cents;
  txn_count: number;
  pct: number;
};

/** Category table and pie data for one window. Sorted biggest first. */
export function breakdown(
  expenses: Expense[],
  categories: Category[],
  opts: { start: ISODate; end: ISODate; bucket?: Bucket | "all" },
): { slices: CategorySlice[]; total_cents: Cents; txn_count: number } {
  const byId = categoryIndex(categories);
  const want = opts.bucket ?? "all";
  const rows = expenses.filter(
    (e) => inWindow(e, opts.start, opts.end) && (want === "all" || bucketOf(e, byId) === want),
  );

  const acc = new Map<string, CategorySlice>();
  for (const e of rows) {
    const cat = e.category_id !== null ? byId.get(e.category_id) : undefined;
    const k = String(cat?.id ?? "none");
    const slice = acc.get(k) ?? {
      category_id: cat?.id ?? null,
      name: cat?.name ?? UNCATEGORIZED,
      color: cat?.color ?? null,
      bucket: cat?.bucket ?? "discretionary",
      amount_cents: 0,
      txn_count: 0,
      pct: 0,
    };
    slice.amount_cents += e.amount_cents;
    slice.txn_count += 1;
    acc.set(k, slice);
  }

  const total = sum([...acc.values()].map((s) => s.amount_cents));
  const slices = [...acc.values()].sort((a, b) => b.amount_cents - a.amount_cents);
  for (const s of slices) s.pct = total === 0 ? 0 : (s.amount_cents / total) * 100;
  return { slices, total_cents: total, txn_count: rows.length };
}

export type SeriesPoint = {
  key: string;
  label: string;
  start: ISODate;
  end: ISODate;
  amount_cents: Cents;
  txn_count: number;
};

/** Per-week (Sun-Sat) or per-month totals across a range, gaps filled with zero. */
export function series(
  expenses: Expense[],
  opts: { granularity: "week" | "month"; start: ISODate; end: ISODate; bucket?: Bucket | "all" },
  categories: Category[] = [],
): SeriesPoint[] {
  const byId = categoryIndex(categories);
  const want = opts.bucket ?? "all";
  const rows = expenses.filter(
    (e) => inWindow(e, opts.start, opts.end) && (want === "all" || bucketOf(e, byId) === want),
  );

  const points = new Map<string, SeriesPoint>();
  for (const p of buckets(opts.granularity, opts.start, opts.end)) points.set(p.key, p);
  for (const e of rows) {
    const k =
      opts.granularity === "week" ? d.weekStart(e.txn_date) : d.monthOf(e.txn_date);
    const p = points.get(k);
    if (!p) continue;
    p.amount_cents += e.amount_cents;
    p.txn_count += 1;
  }
  return [...points.values()];
}

function buckets(granularity: "week" | "month", start: ISODate, end: ISODate): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  if (granularity === "month") {
    const first = d.monthOf(start);
    const n = d.monthsBetween(first, d.monthOf(end)) + 1;
    for (const m of d.monthRange(first, Math.max(0, n))) {
      out.push({
        key: m,
        label: m,
        start: d.monthStart(m),
        end: d.monthEnd(m),
        amount_cents: 0,
        txn_count: 0,
      });
    }
    return out;
  }
  let cur = d.weekStart(start);
  let guard = 0;
  while (d.compare(cur, end) <= 0 && guard++ < 600) {
    out.push({
      key: cur,
      label: `${cur} - ${d.addDays(cur, 6)}`,
      start: cur,
      end: d.addDays(cur, 6),
      amount_cents: 0,
      txn_count: 0,
    });
    cur = d.addDays(cur, 7);
  }
  return out;
}
