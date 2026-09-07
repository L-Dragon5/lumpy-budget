import { expect, test } from "bun:test";
import { detectDateFormat, parseAmountCents, parseCsv, parseDate } from "../src/parse";

test("csv survives quoted commas, embedded newlines and a BOM", () => {
  const text = '﻿"Date","Description","Amount"\n' +
    '"01/05/2026","WEGMANS #123, ROCHESTER","-42.10"\n' +
    '"01/06/2026","LINE\nBREAK CO","-8.00"\n';
  const csv = parseCsv(text);
  expect(csv.headers).toEqual(["Date", "Description", "Amount"]);
  expect(csv.rows).toHaveLength(2);
  expect(csv.rows[0]!.Description).toBe("WEGMANS #123, ROCHESTER");
  expect(csv.rows[1]!.Description).toBe("LINE\nBREAK CO");
});

test("csv skips the preamble rows some banks put above the header", () => {
  const text = "Account: 1234\nExported 2026-01-31\nDate,Amount\n2026-01-05,10.00\n";
  const csv = parseCsv(text, 2);
  expect(csv.headers).toEqual(["Date", "Amount"]);
  expect(csv.rows).toHaveLength(1);
});

test("amounts parse as integer cents, no floats involved", () => {
  expect(parseAmountCents("$1,234.56")).toBe(123456);
  expect(parseAmountCents("(12.34)")).toBe(-1234);
  expect(parseAmountCents("-12.34")).toBe(-1234);
  expect(parseAmountCents("12.3")).toBe(1230);
  expect(parseAmountCents("12")).toBe(1200);
  expect(parseAmountCents(".5")).toBe(50);
  expect(parseAmountCents(" 1 234.00 ")).toBe(123400);
  expect(parseAmountCents("£9.99")).toBe(999);
  expect(parseAmountCents("(1,000.00)")).toBe(-100000);
  expect(parseAmountCents("0.145")).toBe(15); // rounds the third decimal
  expect(parseAmountCents("")).toBeNull();
  expect(parseAmountCents("PENDING")).toBeNull();
  // The classic float trap: 0.1 + 0.2 stays exact in cents.
  expect(parseAmountCents("0.10") + parseAmountCents("0.20")!).toBe(30);
});

test("dates parse in every shape a statement uses", () => {
  expect(parseDate("2026-03-15")).toBe("2026-03-15");
  expect(parseDate("2026/03/15")).toBe("2026-03-15");
  expect(parseDate("03/15/2026")).toBe("2026-03-15");
  expect(parseDate("3/5/26")).toBe("2026-03-05");
  expect(parseDate("15/03/2026", "DD/MM/YYYY")).toBe("2026-03-15");
  expect(parseDate("03-15-2026", "MM-DD-YYYY")).toBe("2026-03-15");
  expect(parseDate("Mar 15, 2026")).toBe("2026-03-15");
  expect(parseDate("15 Mar 2026")).toBe("2026-03-15");
  expect(parseDate("2026-03-15T10:30:00Z")).toBe("2026-03-15");
});

test("an impossible date is rejected rather than rolled over", () => {
  expect(parseDate("2026-02-30")).toBeNull();
  expect(parseDate("13/45/2026")).toBeNull();
  expect(parseDate("")).toBeNull();
  expect(parseDate("n/a")).toBeNull();
  expect(parseDate("2024-02-29")).toBe("2024-02-29");
});

test("date order is settled by the column, not by a guess", () => {
  expect(detectDateFormat(["2026-01-05", "2026-11-30"])).toBe("YYYY-MM-DD");
  expect(detectDateFormat(["01/05/2026", "25/11/2026"])).toBe("DD/MM/YYYY"); // 25 can only be a day
  expect(detectDateFormat(["01/05/2026", "11/25/2026"])).toBe("MM/DD/YYYY"); // 25 can only be a day
  expect(detectDateFormat(["01/05/2026", "02/06/2026"])).toBe("MM/DD/YYYY"); // ambiguous: US default
  expect(detectDateFormat(["01-05-2026"])).toBe("MM-DD-YYYY");
  expect(detectDateFormat([])).toBe("auto");
});
