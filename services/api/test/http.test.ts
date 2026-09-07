import { expect, test } from "bun:test";
import { intParam, isDate, isMonth } from "../src/http";

test("a missing query param falls back instead of becoming zero", () => {
  // Number(null) is 0, which once made ?limit= default to 1 row.
  expect(intParam(null, 500)).toBe(500);
  expect(intParam("", 500)).toBe(500);
  expect(intParam("  ", 500)).toBe(500);
  expect(intParam("abc", 500)).toBe(500);
  expect(intParam("0", 500)).toBe(0);
  expect(intParam("12", 500)).toBe(12);
  expect(intParam("12.7", 500)).toBe(12);
  expect(intParam("-3", 500)).toBe(-3);
});

test("month and date guards reject near-misses", () => {
  expect(isMonth("2026-03")).toBe(true);
  expect(isMonth("2026-3")).toBe(false);
  expect(isMonth("2026-03-01")).toBe(false);
  expect(isMonth(null)).toBe(false);
  expect(isDate("2026-03-01")).toBe(true);
  expect(isDate("2026-03")).toBe(false);
  expect(isDate(null)).toBe(false);
});
