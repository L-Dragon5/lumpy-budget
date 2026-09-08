import { expect, test } from "bun:test";
import { MATCH_WINDOW_DAYS, matchManual, type ManualRow } from "../src/match";

const manual = (id: number, txn_date: string, amount_cents: number, merchant = "COFFEE"): ManualRow =>
  ({ id, txn_date, amount_cents, merchant });
const row = (txn_date: string, amount_cents: number) => ({ txn_date, amount_cents });

test("the same charge typed by hand and posted by the bank is one transaction", () => {
  const got = matchManual([manual(7, "2026-09-05", 650, "Starbucks")], [row("2026-09-05", 650)]);
  expect(got).toEqual([{ manual_id: 7, row_index: 0, day_gap: 0 }]);
});

test("a post-date lag inside the window still pairs, outside it does not", () => {
  const m = [manual(1, "2026-09-05", 650)];
  expect(matchManual(m, [row("2026-09-08", 650)])).toHaveLength(1); // three days late
  expect(matchManual(m, [row("2026-09-01", 650)])).toHaveLength(1); // four days early, the edge
  expect(matchManual(m, [row("2026-09-10", 650)])).toEqual([]); // five, past the window
});

test("a different amount is a different transaction, however close the day", () => {
  expect(matchManual([manual(1, "2026-09-05", 650)], [row("2026-09-05", 651)])).toEqual([]);
});

test("the nearest day wins, so an exact hit is never stolen by a coincidence", () => {
  // Two $6.50 charges in one week: one is the coffee already typed in, one is not.
  const got = matchManual(
    [manual(1, "2026-09-05", 650)],
    [row("2026-09-03", 650), row("2026-09-05", 650)],
  );
  expect(got).toEqual([{ manual_id: 1, row_index: 1, day_gap: 0 }]);
});

test("nothing is claimed twice: two typed rows and two statement rows pair off", () => {
  const got = matchManual(
    [manual(1, "2026-09-05", 650), manual(2, "2026-09-06", 650)],
    [row("2026-09-05", 650), row("2026-09-06", 650)],
  );
  expect(got).toEqual([
    { manual_id: 1, row_index: 0, day_gap: 0 },
    { manual_id: 2, row_index: 1, day_gap: 0 },
  ]);
});

test("one typed row cannot absorb two statement rows", () => {
  // Two identical coffees the bank really did charge twice, one of them typed in.
  const got = matchManual([manual(1, "2026-09-05", 650)], [row("2026-09-05", 650), row("2026-09-05", 650)]);
  expect(got).toHaveLength(1);
});

test("results come back in file order whatever order they were paired in", () => {
  const got = matchManual(
    [manual(9, "2026-09-05", 650), manual(3, "2026-09-20", 1200)],
    [row("2026-09-19", 1200), row("2026-09-05", 650)],
  );
  expect(got.map((a) => a.row_index)).toEqual([0, 1]);
});

test("a refund typed by hand matches the refund on the statement", () => {
  expect(matchManual([manual(1, "2026-09-05", -2500)], [row("2026-09-06", -2500)])).toHaveLength(1);
});

test("month and year boundaries are day arithmetic, not string comparison", () => {
  expect(matchManual([manual(1, "2025-12-31", 650)], [row("2026-01-02", 650)])).toHaveLength(1);
  expect(matchManual([manual(1, "2026-02-28", 650)], [row("2026-03-02", 650)])).toHaveLength(1);
});

test("the window is four days, which is a weekend plus the bank's three", () => {
  expect(MATCH_WINDOW_DAYS).toBe(4);
});

test("no statement rows and no typed rows is not an error", () => {
  expect(matchManual([], [row("2026-09-05", 650)])).toEqual([]);
  expect(matchManual([manual(1, "2026-09-05", 650)], [])).toEqual([]);
});
