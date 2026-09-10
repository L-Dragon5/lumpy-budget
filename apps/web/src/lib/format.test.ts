import { expect, test } from "bun:test";
import { merchantTitle, money, monthParam, ordinal, toCents } from "./format";

test("a merchant becomes a name a person would have typed", () => {
  expect(merchantTitle("GEICO *AUTO 8829")).toBe("Geico Auto");
  expect(merchantTitle("TOWN OF PERINTON TAX")).toBe("Town Of Perinton Tax");
  // The legal entity is not the thing being budgeted for.
  expect(merchantTitle("CHIMNEY SWEEP LLC")).toBe("Chimney Sweep");
  // Nothing but a suffix keeps it: an empty name field helps nobody.
  expect(merchantTitle("LLC")).toBe("Llc");
  // Nothing but noise: give the original back rather than an empty field.
  expect(merchantTitle("*** 4021")).toBe("*** 4021");
});

test("money and cents still round-trip through the field a person types in", () => {
  expect(toCents(money(123456))).toBe(123456);
  expect(ordinal(0)).toBe("last day");
});

test("a ?month= from a link is taken only when it is a real month", () => {
  expect(monthParam("2026-03")).toBe("2026-03");
  expect(monthParam("2026-12")).toBe("2026-12");
  // Each of these would reach the API as a date it answers with a 422, and the
  // page would open on an error instead of on this month.
  for (const bad of ["2026-13", "2026-00", "2026-3", "March", "2026-03-01", ""]) expect(monthParam(bad)).toBeNull();
  expect(monthParam(null)).toBeNull();
});
