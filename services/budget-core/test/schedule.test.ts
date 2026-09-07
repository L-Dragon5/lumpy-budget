import { expect, test } from "bun:test";
import { stream } from "../fixtures/factories";
import { allOccurrences, extraPaycheckMonths, occurrences, occurrencesInMonth } from "../src/schedule";
import * as d from "../src/dates";

const dates = (o: { date: string }[]) => o.map((x) => x.date);

test("biweekly pays 26 times a year and names the 3-paycheck months", () => {
  const s = stream({ frequency: "biweekly", anchor_date: "2026-01-02" });
  const year = occurrences(s, "2026-01-01", "2026-12-31");
  expect(year).toHaveLength(26);
  expect(year[0]!.date).toBe("2026-01-02");
  expect(year[25]!.date).toBe("2026-12-18");
  expect(extraPaycheckMonths(s, 2026)).toEqual(["2026-01", "2026-07"]);
  expect(dates(occurrencesInMonth([s], "2026-01"))).toEqual(["2026-01-02", "2026-01-16", "2026-01-30"]);
  expect(dates(occurrencesInMonth([s], "2026-02"))).toEqual(["2026-02-13", "2026-02-27"]);
});

test("an anchor in the future still produces the paychecks before it", () => {
  const s = stream({ frequency: "biweekly", anchor_date: "2026-10-02" });
  const jan = occurrencesInMonth([s], "2026-01");
  expect(dates(jan)).toEqual(["2026-01-09", "2026-01-23"]);
  // Walking back from the anchor lands on the same weekday.
  for (const o of jan) expect(d.dayOfWeek(o.date)).toBe(5);
});

test("weekly pays 52 times a year and has four 5-paycheck months", () => {
  const s = stream({ frequency: "weekly", amount_cents: 100000, anchor_date: "2026-01-02" });
  expect(occurrences(s, "2026-01-01", "2026-12-31")).toHaveLength(52);
  expect(extraPaycheckMonths(s, 2026)).toEqual(["2026-01", "2026-05", "2026-07", "2026-10"]);
});

test("semimonthly with day_2 = 0 lands on the last day, leap year included", () => {
  const s = stream({ frequency: "semimonthly", anchor_date: null, day_1: 15, day_2: 0 });
  expect(dates(occurrencesInMonth([s], "2026-02"))).toEqual(["2026-02-15", "2026-02-28"]);
  expect(dates(occurrencesInMonth([s], "2024-02"))).toEqual(["2024-02-15", "2024-02-29"]);
  expect(dates(occurrencesInMonth([s], "2026-04"))).toEqual(["2026-04-15", "2026-04-30"]);
  expect(occurrences(s, "2026-01-01", "2026-12-31")).toHaveLength(24);
  // Never an extra paycheck month, no matter the calendar.
  expect(extraPaycheckMonths(s, 2026)).toEqual([]);
});

test("semimonthly returns pay dates in calendar order even when day_1 > day_2", () => {
  const s = stream({ frequency: "semimonthly", anchor_date: null, day_1: 25, day_2: 10 });
  expect(dates(occurrencesInMonth([s], "2026-03"))).toEqual(["2026-03-10", "2026-03-25"]);
});

test("monthly on the 31st clamps instead of skipping short months", () => {
  const s = stream({ frequency: "monthly", anchor_date: null, day_of_month: 31 });
  expect(dates(occurrencesInMonth([s], "2026-04"))).toEqual(["2026-04-30"]);
  expect(dates(occurrencesInMonth([s], "2026-02"))).toEqual(["2026-02-28"]);
  expect(occurrences(s, "2026-01-01", "2026-12-31")).toHaveLength(12);
  expect(extraPaycheckMonths(s, 2026)).toEqual([]);
});

test("annual income on Feb 29 falls back to Feb 28 in common years", () => {
  const s = stream({ frequency: "annual", anchor_date: "2024-02-29" });
  expect(dates(occurrences(s, "2026-01-01", "2026-12-31"))).toEqual(["2026-02-28"]);
  expect(dates(occurrences(s, "2028-01-01", "2028-12-31"))).toEqual(["2028-02-29"]);
});

test("inactive streams pay nothing", () => {
  expect(occurrences(stream({ active: false }), "2026-01-01", "2026-12-31")).toEqual([]);
});

test("mixed streams merge in date order", () => {
  const semi = stream({ name: "Day job", frequency: "semimonthly", anchor_date: null, day_1: 15, day_2: 0, amount_cents: 300000 });
  const rent = stream({ name: "Rental", frequency: "monthly", anchor_date: null, day_of_month: 5, amount_cents: 180000 });
  const merged = allOccurrences([semi, rent], "2026-03-01", "2026-03-31");
  expect(dates(merged)).toEqual(["2026-03-05", "2026-03-15", "2026-03-31"]);
  expect(merged.map((o) => o.stream_name)).toEqual(["Rental", "Day job", "Day job"]);
});

test("a one-off pays exactly once, on its date, and never again", () => {
  const gift = stream({ name: "Birthday gift", frequency: "one_time", anchor_date: "2026-03-14", amount_cents: 50000 });
  expect(dates(occurrences(gift, "2026-01-01", "2026-12-31"))).toEqual(["2026-03-14"]);
  expect(occurrences(gift, "2027-01-01", "2027-12-31")).toEqual([]);
  expect(occurrences(gift, "2026-03-15", "2026-12-31")).toEqual([]);
  // Never an "extra paycheck" month: it is surplus by construction.
  expect(extraPaycheckMonths(gift, 2026)).toEqual([]);
});
