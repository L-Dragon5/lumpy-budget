import { matchesPattern, merchantKey, needleOf } from "@lumpy/contracts";
import type { Category, Expense, FixedCost, LumpyItem } from "@lumpy/contracts";
import { divRound, type Cents } from "./money";
import * as d from "./dates";
import type { ISODate, ISOMonth } from "./dates";
import { bucketOf, categoryIndex } from "./reports";

/**
 * The lumpy fund only works if the lumpy costs are *in* it, and typing them in
 * is the one job this app cannot do for you -- except that after a statement
 * import the evidence is already sitting in the expenses table. A charge that
 * arrived last March and again this March, for about the same money, is an
 * annual bill whether or not anybody wrote it down.
 *
 * This is a suggestion engine, deliberately: it proposes, a person presses Add.
 * That is what lets it use a merchant *heuristic* (see `merchantKey`) where the
 * variance report has to use an exact pattern -- a wrong guess here costs a
 * glance, a wrong guess there rewrites what a bill costs.
 */

export type RecurringOccurrence = {
  txn_date: ISODate;
  amount_cents: Cents;
  merchant: string;
  category_id: number | null;
};

export type RecurringCandidate = {
  /** The merchant key the occurrences were grouped on. Stable, so the UI can key rows on it. */
  key: string;
  /** Prefill for the item's name: the merchant as the most recent statement wrote it. */
  name: string;
  merchants: string[];
  /** Snapped to a real cycle where the spacing is close enough: 3, 6, 12, 24. */
  frequency_months: number;
  /** What to budget: the most recent charge. Prices go up, not down. */
  amount_cents: Cents;
  /** The average across every occurrence, so one outlier is visible next to it. */
  typical_cents: Cents;
  occurrences: RecurringOccurrence[];
  last_date: ISODate;
  /** Last seen plus a cycle, rolled forward past today the way a due date heals. */
  next_due_date: ISODate;
  /** The category those charges already carry, when they agree on one. */
  category_id: number | null;
  /** amount x 12 / cycle. The number that decides which suggestion matters most. */
  annual_cents: Cents;
  /** Every gap identical. False means one arrived a month early or late. */
  regular: boolean;
};

export type RecurringOptions = {
  today: ISODate;
  /**
   * How far back to look. Three years, not two: an annual bill needs to be seen
   * twice, and a two-year window catches a January pair only until January.
   */
  lookbackMonths?: number;
  /** Below this a charge is noise, not a bill worth saving up for. */
  minAmountCents?: Cents;
  /**
   * Shortest cycle to report. Defaults to 2, because monthly is a fixed cost
   * and not a lumpy item, and the lumpy page must never propose one.
   *
   * Pass 1 to ask the opposite question -- which bills arrive *every* month --
   * which is what the fixed costs page does. Same grouping, same gap test, one
   * floor moved.
   */
  minCycleMonths?: number;
  /**
   * How far the amount may swing across the run before the group is read as two
   * unrelated charges sharing a merchant name. Defaults to 1.5.
   *
   * A renewal is the strict case: a premium rises between years, it does not
   * triple. A monthly utility is the loose one -- gas and electric in February
   * against gas and electric in June is nearly double, and it is emphatically
   * one bill. A caller asking for monthly cycles should raise this.
   */
  maxAmountRatio?: number;
  categories?: Category[];
  /** Already in the fund: do not suggest what is already tracked. */
  lumpyItems?: LumpyItem[];
  /** Already a bill: its pattern claims its charges. */
  fixedCosts?: FixedCost[];
};

/** The cycles the app has words for. Anything within a month of one reads as that one. */
const SNAP_TO = [3, 6, 12, 24];

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function recurringCandidates(expenses: Expense[], opts: RecurringOptions): RecurringCandidate[] {
  const today = d.assertDate(opts.today);
  const lookback = Math.max(1, opts.lookbackMonths ?? 36);
  const minAmount = opts.minAmountCents ?? 5000;
  const minCycle = Math.max(1, opts.minCycleMonths ?? 2);
  const maxRatio = Math.max(1, opts.maxAmountRatio ?? 1.5);

  const start = d.monthStart(d.addMonths(d.monthOf(today), -(lookback - 1)));
  const byId = categoryIndex(opts.categories ?? []);

  // A bill that already has a pattern is already reconciled on the fixed costs
  // page; suggesting it again as a lumpy item would double it in the budget.
  const claimedBy = (opts.fixedCosts ?? [])
    .filter((c) => c.active && (c.merchant_pattern ?? "").trim().length > 0)
    .map((c) => ({ needle: needleOf(c.merchant_pattern!), wholeWord: c.merchant_whole_word }));

  const alreadyTracked = new Set(
    [
      ...(opts.lumpyItems ?? []).filter((i) => i.active).map((i) => i.name),
      ...(opts.fixedCosts ?? []).filter((c) => c.active).map((c) => c.name),
    ].map((n) => merchantKey(n)),
  );

  const groups = new Map<string, RecurringOccurrence[]>();
  for (const e of expenses) {
    // Future-dated rows are excluded for the same reason lumpy drift excludes
    // them: that money has not moved yet, and a statement can carry a date ahead
    // of itself.
    if (d.compare(e.txn_date, start) < 0 || d.compare(e.txn_date, today) > 0) continue;
    // ponytail: small charges are dropped before grouping, not after. A dropped
    // $4 charge can open a false gap in a group, but the gaps then disagree and
    // the group is rejected rather than mis-suggested.
    if (e.amount_cents < minAmount) continue;
    const bucket = bucketOf(e, byId);
    if (bucket === "transfer" || bucket === "savings") continue;
    const h = `${e.merchant} ${e.description ?? ""}`.toLowerCase();
    if (claimedBy.some((m) => matchesPattern(h, m.needle, m.wholeWord))) continue;

    const key = merchantKey(e.merchant);
    if (key === "" || alreadyTracked.has(key)) continue;
    const list = groups.get(key) ?? [];
    list.push({
      txn_date: e.txn_date,
      amount_cents: e.amount_cents,
      merchant: e.merchant,
      category_id: e.category_id,
    });
    groups.set(key, list);
  }

  const out: RecurringCandidate[] = [];
  for (const [key, unsorted] of groups) {
    const occ = [...unsorted].sort((a, b) => d.compare(a.txn_date, b.txn_date));
    if (occ.length < 2) continue;

    // Whole months apart, not days: a bill due the 1st can post the 28th of the
    // month before and still be the same annual bill.
    const gaps: number[] = [];
    for (let i = 1; i < occ.length; i++) {
      gaps.push(d.monthsBetween(d.monthOf(occ[i - 1]!.txn_date), d.monthOf(occ[i]!.txn_date)));
    }
    if (gaps.some((g) => g < minCycle)) continue;
    // One month of slack across the whole run. Two different spacings are two
    // different things happening at one merchant, not one bill.
    if (Math.max(...gaps) - Math.min(...gaps) > 1) continue;

    const amounts = occ.map((o) => o.amount_cents);
    const low = Math.min(...amounts);
    const high = Math.max(...amounts);
    // A premium can rise between renewals; it does not triple. Beyond the
    // caller's tolerance it is two unrelated charges wearing one merchant name.
    if (low <= 0 || high > low * maxRatio) continue;

    const raw = Math.round(mean(gaps));
    const frequency_months = SNAP_TO.find((c) => Math.abs(c - raw) <= 1) ?? raw;
    const last = occ[occ.length - 1]!;

    let next = d.addMonthsToDate(last.txn_date, frequency_months);
    let guard = 0;
    while (d.compare(next, today) < 0 && guard++ < 200) next = d.addMonthsToDate(next, frequency_months);

    out.push({
      key,
      name: last.merchant,
      merchants: [...new Set(occ.map((o) => o.merchant))],
      frequency_months,
      amount_cents: last.amount_cents,
      typical_cents: divRound(amounts.reduce((a, b) => a + b, 0), amounts.length),
      occurrences: occ,
      last_date: last.txn_date,
      next_due_date: next,
      category_id: agreedCategory(occ),
      annual_cents: divRound(last.amount_cents * 12, frequency_months),
      regular: Math.max(...gaps) === Math.min(...gaps),
    });
  }

  // What it costs a year is what decides whether a suggestion is worth reading.
  return out.sort((a, b) => b.annual_cents - a.annual_cents || a.key.localeCompare(b.key));
}

/**
 * The category those charges already wear, when they agree on one. Split
 * opinions mean the importer categorised them differently, and picking a side
 * would file the suggestion in the wrong bucket on the way in.
 */
function agreedCategory(occ: RecurringOccurrence[]): number | null {
  const seen = new Set(occ.map((o) => o.category_id));
  seen.delete(null);
  return seen.size === 1 ? [...seen][0]! : null;
}

/** Months the candidate has actually been seen in, for the "seen Mar 24, Mar 25" line. */
export const seenMonths = (c: RecurringCandidate): ISOMonth[] =>
  c.occurrences.map((o) => d.monthOf(o.txn_date));
