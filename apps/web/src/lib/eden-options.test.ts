import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { treaty } from "@elysiajs/eden";
import { EDEN_OPTIONS } from "./eden-options";

/**
 * A date reaching the client as a Date instead of a string is invisible to the
 * typechecker: Eden's inferred type still says `string`. It blanked the whole
 * dashboard once (dateLabelFull called .slice on a Date). This is the guard.
 */
const dates = new Elysia().get("/dates", () => ({
  day: "2026-10-01",
  stamp: "2026-10-01T00:00:00.000Z",
  rows: [{ due: [{ date: "2027-01-31" }] }],
}));

describe("eden client options", () => {
  test("date-shaped strings stay strings, at any depth", async () => {
    const client = treaty<typeof dates>(dates, EDEN_OPTIONS);
    const { data } = await client.dates.get();

    expect(data!.day).toBe("2026-10-01");
    expect(typeof data!.day).toBe("string");
    expect(typeof data!.stamp).toBe("string");
    expect(typeof data!.rows[0]!.due[0]!.date).toBe("string");
    expect(data!.rows[0]!.due[0]!.date).toBe("2027-01-31");
  });

  test("without the option Eden really does revive them, so the option is doing work", async () => {
    const client = treaty<typeof dates>(dates);
    const { data } = await client.dates.get();
    // If this ever stops being a Date, Eden changed its default and the comment
    // in eden-options.ts should be revisited -- but keep the option either way.
    expect(data!.day).toBeInstanceOf(Date);
  });
});
