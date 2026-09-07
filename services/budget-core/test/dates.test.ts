import { expect, test } from "bun:test";
import * as d from "../src/dates";

test("day arithmetic crosses months, years and leap days", () => {
  expect(d.addDays("2026-01-31", 1)).toBe("2026-02-01");
  expect(d.addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(d.addDays("2024-02-28", 1)).toBe("2024-02-29");
  expect(d.addDays("2026-02-28", 1)).toBe("2026-03-01");
  expect(d.addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(d.diffDays("2026-01-01", "2026-12-31")).toBe(364);
});

test("DST cannot shift a date", () => {
  // US DST starts 2026-03-08. Both sides of it must stay on a Friday.
  expect(d.addDays("2026-03-06", 14)).toBe("2026-03-20");
  expect(d.dayOfWeek("2026-03-06")).toBe(5);
  expect(d.dayOfWeek("2026-03-20")).toBe(5);
  expect(d.dayOfWeek("2026-11-06")).toBe(5); // and across the fall-back too
});

test("clampDay pins to the end of the month, 0 means last day", () => {
  expect(d.clampDay(2026, 4, 31)).toBe("2026-04-30");
  expect(d.clampDay(2026, 2, 31)).toBe("2026-02-28");
  expect(d.clampDay(2024, 2, 31)).toBe("2024-02-29");
  expect(d.clampDay(2026, 2, 0)).toBe("2026-02-28");
  expect(d.clampDay(2024, 2, 0)).toBe("2024-02-29");
  expect(d.clampDay(2026, 6, 15)).toBe("2026-06-15");
});

test("month helpers", () => {
  expect(d.monthEnd("2026-02")).toBe("2026-02-28");
  expect(d.monthEnd("2024-02")).toBe("2024-02-29");
  expect(d.addMonths("2026-12", 1)).toBe("2027-01");
  expect(d.addMonths("2026-01", -1)).toBe("2025-12");
  expect(d.addMonths("2026-03", 24)).toBe("2028-03");
  expect(d.monthsBetween("2026-01", "2026-04")).toBe(3);
  expect(d.monthsBetween("2026-04", "2026-01")).toBe(-3);
  expect(d.monthRange("2026-11", 3)).toEqual(["2026-11", "2026-12", "2027-01"]);
});

test("weeks start on Sunday", () => {
  expect(d.dayOfWeek("2026-01-01")).toBe(4); // Thursday
  expect(d.weekStart("2026-01-01")).toBe("2025-12-28");
  expect(d.weekStart("2025-12-28")).toBe("2025-12-28");
  expect(d.weekStart("2026-01-03")).toBe("2025-12-28");
  expect(d.weekStart("2026-01-04")).toBe("2026-01-04");
  expect(d.weekStart("2026-01-01", 1)).toBe("2025-12-29"); // Monday-start if you ask
});

test("malformed input throws instead of silently becoming NaN", () => {
  expect(() => d.parts("2026-1-1")).toThrow();
  expect(() => d.monthStart("2026")).toThrow();
});
