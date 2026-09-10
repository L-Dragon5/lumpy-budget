import type { Bucket, Category, Expense } from "@lumpy/contracts";
import { divRound, sum, type Cents } from "./money";
import * as d from "./dates";
import type { ISODate, ISOMonth } from "./dates";

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
    income: 0,
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

// ------------------------------------------------------ this month, so far

export type CategoryPaceRow = {
  category_id: number | null;
  name: string;
  color: string | null;
  bucket: Bucket;
  /** Spent in this category so far this month. */
  month_to_date_cents: Cents;
  /** What the same stretch of a month usually costs: the median of the months compared. */
  typical_cents: Cents;
  /** The same stretch of each earlier month, oldest first. */
  by_month: { month: ISOMonth; amount_cents: Cents }[];
  delta_cents: Cents;
  pct_off: number;
};

export type CategoryPace = {
  month: ISOMonth;
  /** The day of the month the comparison is cut at. */
  through_day: number;
  /** Earlier months with at least one transaction imported, oldest first. */
  months_compared: ISOMonth[];
  rows: CategoryPaceRow[];
};

/**
 * Every discretionary category against what it usually costs by this day of the
 * month.
 *
 * The fixed bills have a budgeted number to be compared with; groceries and
 * restaurants never will, because nobody knows what they should cost until they
 * have seen what they do cost. So the target is your own history, which needs no
 * maintenance and cannot go stale: the median of the same categories over the
 * last few complete months.
 *
 * Cut at today's day of the month on both sides. A full month's average against
 * five days of spending says you are 80% under budget every month until the 25th,
 * which is worse than saying nothing. The median rather than the mean, because
 * one annual car repair booked to Maintenance should not become the number the
 * other eleven months are judged against.
 *
 * A month nobody imported is not a month you spent nothing -- the same rule the
 * variance report follows -- so only months carrying at least one transaction are
 * compared, and a category with no charge in an imported month is a real zero.
 */
export function categoryPace(
  expenses: Expense[],
  categories: Category[],
  opts: { today: ISODate; months?: number; bucket?: Bucket | "all" },
): CategoryPace {
  const today = d.assertDate(opts.today);
  const month = d.monthOf(today);
  const day = Number(today.slice(8, 10));
  const want = opts.bucket ?? "discretionary";
  const byId = categoryIndex(categories);
  const n = Math.max(1, opts.months ?? 3);

  const wanted = expenses.filter((e) => want === "all" || bucketOf(e, byId) === want);
  // Imported months are decided by every transaction, not only the wanted bucket:
  // a month whose statement holds nothing but rent was still imported.
  const importedMonths = new Set(expenses.map((e) => d.monthOf(e.txn_date)));
  const earlier = d
    .monthRange(d.addMonths(month, -n), n)
    .filter((m) => importedMonths.has(m));

  // Same stretch of the month on both sides. A short month is included whole,
  // which is the honest reading of "by the 31st".
  const upToDay = (e: Expense): boolean => Number(e.txn_date.slice(8, 10)) <= day;

  // Only the months being compared, only the stretch of them being compared. A
  // category nobody has spent in by this day of any of them is not a row: an
  // all-zero line says nothing and pushes the lines that do off the screen.
  const compared = new Set([month, ...earlier]);
  const inScope = wanted.filter((e) => compared.has(d.monthOf(e.txn_date)) && upToDay(e));

  const keyOf = (e: Expense) => String(e.category_id ?? "none");
  const seen = new Map<string, { category_id: number | null; name: string; color: string | null; bucket: Bucket }>();
  const totals = new Map<string, Map<ISOMonth, Cents>>();
  for (const e of inScope) {
    const key = keyOf(e);
    if (!seen.has(key)) {
      const cat = e.category_id !== null ? byId.get(e.category_id) : undefined;
      seen.set(key, {
        category_id: cat?.id ?? null,
        name: cat?.name ?? UNCATEGORIZED,
        color: cat?.color ?? null,
        bucket: cat?.bucket ?? "discretionary",
      });
    }
    const m = d.monthOf(e.txn_date);
    const per = totals.get(key) ?? new Map<ISOMonth, Cents>();
    per.set(m, (per.get(m) ?? 0) + e.amount_cents);
    totals.set(key, per);
  }

  const rows: CategoryPaceRow[] = [...seen.entries()].map(([key, base]) => {
    const per = totals.get(key) ?? new Map<ISOMonth, Cents>();
    const by_month = earlier.map((m) => ({ month: m, amount_cents: per.get(m) ?? 0 }));
    const typical = median(by_month.map((r) => r.amount_cents));
    const mtd = per.get(month) ?? 0;
    return {
      ...base,
      month_to_date_cents: mtd,
      typical_cents: typical,
      by_month,
      delta_cents: mtd - typical,
      pct_off: typical === 0 ? 0 : ((mtd - typical) / typical) * 100,
    };
  });

  // Biggest overspend first, biggest saving last: the top of this list is the
  // only part that asks anything of you.
  rows.sort((a, b) => b.delta_cents - a.delta_cents || a.name.localeCompare(b.name));
  return { month, through_day: day, months_compared: earlier, rows };
}

/**
 * The middle value, averaging the two middles on an even count. Rounded the way
 * every other split in this app is, so a median of cents is cents.
 */
export function median(xs: Cents[]): Cents {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : divRound(sorted[mid - 1]! + sorted[mid]!, 2);
}
