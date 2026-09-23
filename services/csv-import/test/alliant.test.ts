import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { alliantTable, counterparty, isAlliant, parseAlliant } from "../src/alliant";
import { parseCsv } from "../src/parse";
import { dedupeKeys, guessMapping, normalize } from "../src";

/**
 * A made-up statement laid out the way pdf.js reads a real one: the shapes that
 * broke or nearly broke the Python parser, with none of anybody's numbers.
 */
const STATEMENT = [
  "Alliant Credit Union",
  "Statement of Account",
  "Account Number Statement Period Page",
  "12345678 08/01/26 thru 08/31/26 1 of 2",
  "SAVINGS ACCOUNT (ID 01)",
  "Posting Date Transaction Description Deposit Withdrawal Balance",
  "08/01/26 BEGINNING BALANCE $ 100.07",
  "08/31/26 DEPOSIT DIVIDEND 0.25 – -------- 100.32",
  "ANNUAL PERCENTAGE YIELD EARNED 3.01% FOR PERIOD FROM 08/01/26 THRU",
  "08/31/26 BASED ON AVERAGE DAILY BALANCE OF : $100.00.",
  "08/31/26 ENDING BALANCE $ 100.32",
  "CHECKING (ID 10)",
  "Posting Date Transaction Description Deposit Withdrawal Balance",
  "08/01/26 BEGINNING BALANCE $ 2,000.00",
  // The merchant's name wraps onto the next line with the CO: field.
  "08/03/26 WITHDRAWAL ACH GAS AND ELECTRIC TYPE: BILLPAY ID: 9999 : – -------- -150.40 1,849.60",
  "BILLPAY CO: GAS AND ELECTRIC",
  // Names nobody before TYPE:, so the CO: field is the merchant.
  "08/05/26 WITHDRAWAL ACH TYPE: TRANSFER ID: UMB, NA CO: WEALTHY BANK NAME: J DOE – -------- -500.00 1,349.60",
  // pdfplumber's spelling of the dash glyph, which the old CSV came from.
  "08/10/26 WITHDRAWAL ACH CAR LOAN CO TYPE: LOAN ID: 42 (cid:150) -------- -300.00 1,049.60",
  // A page break in the middle of the account.
  "Statement of Account",
  "Account Number Statement Period Page",
  "12345678 08/01/26 thru 08/31/26 2 of 2",
  "CHECKING (ID 10) (Continued)",
  "Posting Date Transaction Description Deposit Withdrawal Balance",
  "08/15/26 DEPOSIT ACH 1234 ACME WIDGETS IN TYPE: PAYROLL ID: 77 : 55555555 CO: ACME 2,500.00 – -------- 3,549.60",
  "1234 ACME WIDGETS IN",
  "08/31/26 ENDING BALANCE $ 3,549.60",
  "In Case of Errors or Questions About Your Electronic Transfers",
];

describe("parseAlliant", () => {
  const txns = parseAlliant(STATEMENT);

  test("every transaction in every section, and nothing that is a balance line or a footer", () => {
    expect(txns.map((t) => [t.section, t.date, t.cents])).toEqual([
      ["SAVINGS ACCOUNT", "08/31/26", -25],
      ["CHECKING", "08/03/26", 15040],
      ["CHECKING", "08/05/26", 50000],
      ["CHECKING", "08/10/26", 30000],
      ["CHECKING", "08/15/26", -250000],
    ]);
  });

  test("a wrapped line belongs to its transaction, and a footer never does", () => {
    expect(txns[1]!.description).toBe(
      "WITHDRAWAL ACH GAS AND ELECTRIC TYPE: BILLPAY ID: 9999 : BILLPAY CO: GAS AND ELECTRIC",
    );
    // The APY line under the dividend is a footer, not part of the dividend.
    expect(txns[0]!.description).toBe("DEPOSIT DIVIDEND");
  });

  test("a page header between two rows is not read as a continuation", () => {
    expect(txns[3]!.description).toBe("WITHDRAWAL ACH CAR LOAN CO TYPE: LOAN ID: 42");
  });
});

test("counterparty is the name before TYPE:", () => {
  expect(counterparty("WITHDRAWAL ACH GAS AND ELECTRIC TYPE: BILLPAY ID: 9999")).toBe("GAS AND ELECTRIC");
  expect(counterparty("DEPOSIT DIVIDEND")).toBe("DIVIDEND");
});

/**
 * Two quirks of the Python script, kept on purpose. The merchant is a third of
 * the dedupe hash, so "fixing" either one changes the hash of rows already in
 * the database and the next PDF of an old month imports them a second time.
 */
describe("quirks inherited from acu-to-csv.py, pinned so nobody fixes them", () => {
  test("a row that opens on TYPE: keeps its whole body: the CO: fallback never fires", () => {
    // split(" TYPE:") needs the space LEAD just removed, so the name is never empty.
    expect(counterparty("WITHDRAWAL ACH TYPE: TRANSFER ID: UMB, NA CO: WEALTHY BANK NAME: J DOE")).toBe(
      "TYPE: TRANSFER ID: UMB, NA CO: WEALTHY BANK NAME: J DOE",
    );
  });

  test("an amount that is also inside the balance's digits is cut out of both", () => {
    const [t] = parseAlliant(["CHECKING (ID 10)", "08/31/26 DEPOSIT DIVIDEND 0.25 \u2013 -------- 100.25"]);
    expect(t!.description).toBe("DEPOSIT DIVIDEND 10");
  });
});

describe("alliantTable", () => {
  test("checking only, as the table a CSV would have been", () => {
    const { table, problems } = alliantTable(STATEMENT);
    expect(problems).toEqual([]);
    expect(table.headers).toEqual(["Date", "Description", "Amount", "Details"]);
    expect(table.rows.map((r) => [r.Date, r.Description, r.Amount])).toEqual([
      ["2026-08-03", "GAS AND ELECTRIC", "150.40"],
      ["2026-08-05", "TYPE: TRANSFER ID: UMB, NA CO: WEALTHY BANK NAME: J DOE", "500.00"],
      ["2026-08-10", "CAR LOAN CO", "300.00"],
      ["2026-08-15", "1234 ACME WIDGETS IN", "-2500.00"],
    ]);
  });

  test("the table reads through guessMapping and normalize like any CSV", () => {
    const { table } = alliantTable(STATEMENT);
    const { rows, errors } = normalize(table, guessMapping(table), "import");
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.txn_date, r.merchant, r.amount_cents])).toEqual([
      ["2026-08-03", "GAS AND ELECTRIC", 15040],
      ["2026-08-05", "TYPE: TRANSFER ID: UMB, NA CO: WEALTHY BANK NAME: J DOE", 50000],
      ["2026-08-10", "CAR LOAN CO", 30000],
      ["2026-08-15", "1234 ACME WIDGETS IN", -250000],
    ]);
  });

  test("a row that breaks the statement's running balance is a problem, named", () => {
    // Misread the gas bill as $15.04: every figure after it stops adding up.
    const broken = STATEMENT.map((l) => l.replace("-150.40 1,849.60", "-15.04 1,849.60"));
    const { problems } = alliantTable(broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("CHECKING 08/03/26");
  });

  test("a section with no beginning balance cannot be checked, so it is a problem", () => {
    const { problems } = alliantTable(STATEMENT.filter((l) => !l.includes("$ 2,000.00")));
    expect(problems).toEqual(["CHECKING has no beginning balance"]);
  });
});

test("isAlliant reads the credit union's name, and nothing else passes", () => {
  expect(isAlliant(STATEMENT)).toBe(true);
  expect(isAlliant(["Chase", "Statement of Account"])).toBe(false);
});

/**
 * The real statements, when they are on this machine: the PDF path has to agree
 * with the CSV `statements/acu-to-csv.py` wrote, column for column, or every
 * month already imported from that CSV imports a second time. Skipped anywhere
 * the gitignored folder is absent.
 */
const DIR = join(import.meta.dir, "..", "..", "..", "statements");
const REFERENCE = join(DIR, "acu-checking.csv");
const pdfs = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^acu-.*\.pdf$/.test(f)).sort() : [];

test.skipIf(pdfs.length === 0 || !existsSync(REFERENCE))(
  "the real statements read exactly as the Python script read them",
  async () => {
    const { pdfLines } = await import("../src/pdf");
    const rows: Record<string, string>[] = [];
    for (const f of pdfs) {
      const lines = await pdfLines(new Uint8Array(await Bun.file(join(DIR, f)).arrayBuffer()));
      expect(isAlliant(lines)).toBe(true);
      const { table, problems } = alliantTable(lines);
      expect(problems).toEqual([]);
      rows.push(...table.rows);
    }
    const reference = parseCsv(await Bun.file(REFERENCE).text()).rows;
    // Compared in a stable date order: the reference was one sort over all files.
    const byDate = (r: Record<string, string>[]) =>
      r.map((x, i) => ({ x, i })).sort((a, b) => a.x.Date!.localeCompare(b.x.Date!) || a.i - b.i).map(({ x }) => x);
    expect(byDate(rows)).toEqual(reference);
    // And so the hashes are the ones already in the database.
    const keys = (t: Record<string, string>[]) =>
      dedupeKeys(normalize({ headers: ["Date", "Description", "Amount", "Details"], rows: t },
        guessMapping({ headers: ["Date", "Description", "Amount", "Details"], rows: t }), "import").rows);
    expect(keys(byDate(rows))).toEqual(keys(reference));
  },
  30_000,
);
