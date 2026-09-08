import type { ExpenseInput } from "@lumpy/contracts";

/**
 * A transaction already in the ledger that a person typed in, offered to the
 * statement as something it might be a second copy of.
 */
export type ManualRow = { id: number; txn_date: string; amount_cents: number; merchant: string };

/**
 * One statement row this proposes is a transaction already in the ledger. A
 * proposal until a person confirms it, which is why it is not the wire shape:
 * `Absorption` in contracts is what actually gets posted.
 */
export type ProposedMatch = { manual_id: number; row_index: number; day_gap: number };

/**
 * How far apart the typed day and the posted day may be. A card authorises on
 * the day and posts one to three business days later; a weekend stretches that
 * to four. Five would start folding next week's identical charge into this
 * week's.
 *
 * ponytail: a constant, not a setting. Widen it here the day a real statement
 * needs it, and only then.
 */
export const MATCH_WINDOW_DAYS = 4;

/**
 * Day arithmetic on `YYYY-MM-DD`, in UTC so no local midnight can shift a gap.
 * Deliberately not imported from budget-core: csv-import does not depend on it
 * and one subtraction is not worth an edge between two sibling packages. This
 * is arithmetic with one right answer, unlike `normalizeMerchant`, where two
 * copies would be two answers to one question.
 */
const epochDay = (d: string): number =>
  Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;

/** Whole days between two `YYYY-MM-DD` days, never negative. */
export const dayGap = (a: string, b: string): number => Math.abs(epochDay(a) - epochDay(b));

/**
 * Whether these two could be the same charge: the amount to the cent, within
 * the window. The single definition of that question, because the wizard asks
 * it to propose a merge and the API asks it again before writing one. Two
 * copies would be two answers, and the disagreement would land on a person's
 * ledger.
 */
export const matchable = (
  manual: Pick<ManualRow, "txn_date" | "amount_cents">,
  row: Pick<ExpenseInput, "txn_date" | "amount_cents">,
  windowDays = MATCH_WINDOW_DAYS,
): boolean =>
  manual.amount_cents === row.amount_cents && dayGap(manual.txn_date, row.txn_date) <= windowDays;

/**
 * Pairs statement rows against transactions somebody already entered by hand.
 *
 * The merchant is no help here: a person types "Starbucks" and the bank writes
 * "SQ *STARBUCKS 1234 SEATTLE", so `dedupeKey` sees two identities and the
 * import inserts a second row. The amount in cents is the leg that survives,
 * and an exact cent match a few days apart is the same charge far more often
 * than it is a coincidence. Far more often is not always, which is why every
 * pair this returns is shown to a person before anything is written.
 *
 * Pure: same rows in, same pairs out, no clock and no database. The pairing is
 * one-to-one -- a typed row absorbs at most one statement row and a statement
 * row absorbs at most one typed row -- so two real coffees on one day stay two
 * transactions, which is the number this whole app exists to protect.
 *
 * Nearest day wins first, so a pair on the exact day is never stolen by a
 * same-amount charge earlier in the week. Ties break on file order, then on id,
 * which is only there to make the output identical on every run.
 */
export function matchManual(
  manual: ManualRow[],
  rows: Pick<ExpenseInput, "txn_date" | "amount_cents">[],
  windowDays = MATCH_WINDOW_DAYS,
): ProposedMatch[] {
  const byAmount = new Map<number, ManualRow[]>();
  for (const m of manual) {
    const at = byAmount.get(m.amount_cents);
    if (at) at.push(m);
    else byAmount.set(m.amount_cents, [m]);
  }

  const pairs: ProposedMatch[] = [];
  rows.forEach((r, row_index) => {
    for (const m of byAmount.get(r.amount_cents) ?? []) {
      if (!matchable(m, r, windowDays)) continue;
      pairs.push({ manual_id: m.id, row_index, day_gap: dayGap(m.txn_date, r.txn_date) });
    }
  });

  pairs.sort((a, b) => a.day_gap - b.day_gap || a.row_index - b.row_index || a.manual_id - b.manual_id);

  const takenManual = new Set<number>();
  const takenRow = new Set<number>();
  const out: ProposedMatch[] = [];
  for (const p of pairs) {
    if (takenManual.has(p.manual_id) || takenRow.has(p.row_index)) continue;
    takenManual.add(p.manual_id);
    takenRow.add(p.row_index);
    out.push(p);
  }
  return out.sort((a, b) => a.row_index - b.row_index);
}
