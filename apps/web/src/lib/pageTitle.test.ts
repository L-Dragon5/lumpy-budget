import { expect, test } from "bun:test";
import { pageTitle } from "./pageTitle";

test("names each route", () => {
  expect(pageTitle("/")).toBe("Dashboard · Lumpy");
  expect(pageTitle("/lumpy")).toBe("Lumpy fund · Lumpy");
  expect(pageTitle("/lumpy/timeline")).toBe("Lumpy timeline · Lumpy");
});

test("ignores a trailing slash", () => {
  expect(pageTitle("/income/")).toBe("Income · Lumpy");
});

test("falls back for unknown paths", () => {
  expect(pageTitle("/nope")).toBe("Page not found · Lumpy");
});
