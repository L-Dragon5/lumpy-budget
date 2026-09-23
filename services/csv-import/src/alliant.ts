import type { ParsedCsv } from "./parse";

/**
 * Alliant Credit Union statements, read from the text of their PDF.
 *
 * Alliant only publishes PDFs and everything downstream of the wizard reads a
 * table, so this turns a statement's lines into the same `ParsedCsv` a CSV file
 * becomes: `Date, Description, Amount, Details`, one row per checking
 * transaction. Mapping, preview, rules, merges and the dedupe hash then run on
 * it unchanged.
 *
 * A port of `statements/acu-to-csv.py`, which loaded the first seven months
 * through pdfplumber. It has to agree with that script byte for byte on
 * `Description`: the merchant is a third of the dedupe hash, so a counterparty
 * spelled differently here would import every one of those months a second
 * time. `alliant.test.ts` diffs the two over the real statements when they are
 * on disk.
 *
 * Pure: lines in, rows out. `pdf.ts` is the half that reads a PDF, kept apart so
 * this runs in the gate lane with no PDF library loaded.
 */

/** Alliant prints this for "no amount in this column": pdfplumber reads the glyph as the cid, pdf.js as an en dash. */
const DASHES = ["(cid:150)", "–"];
const SECTION = /^([A-Z][A-Z /]+?) \(ID (\d+)\)(?: \(Continued\))?\s*$/;
const TXN = /^(\d{2}\/\d{2}\/\d{2})\s+(.*)$/;
const MONEY = /-?[\d,]+\.\d{2}/g;
// Tested against the line with its spaces stripped, because the PDF sometimes runs
// words together ("ENDINGBALANCE") and sometimes does not, and the two PDF readers
// disagree about which.
const NOISE = /^(BEGINNINGBALANCE|ENDINGBALANCE|ANNUALPERCENTAGE|BASEDONAVERAGE|YTD)/i;
// A section's list ends at its summary footer. Without this the last transaction
// swallowed "ANNUAL PERCENTAGE YIELD EARNED 3.01% ..." and read the APY as its
// amount, which the balance check caught.
const FOOTER = /^(ANNUALPERCENTAGE|BASEDONAVERAGE|ENDINGBALANCE|NOTICETO|INCASEOF|YTD|FINANCE)/i;
/** A page header that interrupts a wrapped description. */
const PAGE_HEADER = ["Statementof", "AccountNumber", "PostingDate"];

export const ALLIANT_HEADERS = ["Date", "Description", "Amount", "Details"] as const;

export type AlliantTxn = {
  section: string;
  /** MM/DD/YY, as printed. */
  date: string;
  description: string;
  /** Money out is positive, the way the app stores an expense. */
  cents: number;
  balance_cents: number;
};

const squash = (s: string) => s.replace(/\s+/g, "");
const cents = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);
const undash = (s: string) => DASHES.reduce((a, d) => a.split(d).join(" "), s);

/** A statement names its credit union on the first page; nothing else is read as one. */
export const isAlliant = (lines: string[]) => lines.some((l) => /alliant\s*credit\s*union/i.test(l));

const LEAD = /^(WITHDRAWAL|DEPOSIT)\s+(ACH\s+)?/i;
const CO = /\bCO:\s*([^:]+?)(?:\s+(?:NAME|TYPE|ID|DATA):|$)/i;

/**
 * Who the money moved to or from, with Alliant's boilerplate taken off.
 *
 * Every row begins "WITHDRAWAL ACH" or "DEPOSIT ACH" and trails "TYPE: ... ID:
 * ... CO: ...". `merchantKey` groups on the first two words, so left alone every
 * row groups under "withdrawal ach" and the recurring detector sees one merchant
 * instead of a gas bill, a car payment and a paycheck.
 */
export function counterparty(raw: string): string {
  const body = raw.replace(LEAD, "").trim();
  let name = trimChars(body.split(" TYPE:")[0]!.trim(), " -");
  if (!name) {
    // "ACH TYPE: TRANSFER ID: UMB, NA ..." names nobody up front; CO: is the next
    // best thing, and the whole line still rides along in Details.
    const m = CO.exec(body);
    name = m ? m[1]!.trim() : body;
  }
  return name.replace(/\s+/g, " ").slice(0, 120);
}

/** Python's str.strip(chars). */
function trimChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** Every transaction in every section, in the order printed. */
export function parseAlliant(lines: string[]): AlliantTxn[] {
  const out: AlliantTxn[] = [];
  let section: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!.trim();
    const s = SECTION.exec(raw);
    if (s) {
      section = s[1]!.trim();
      i++;
      continue;
    }
    const t = TXN.exec(raw);
    if (!t || section === null || NOISE.test(squash(t[2]!))) {
      i++;
      continue;
    }
    const date = t[1]!;
    let rest = t[2]!;
    // A long description wraps. Anything that is not a new transaction, a new
    // section, a page header or a footer belongs to this row.
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j]!.trim();
      if (!next || TXN.test(next) || SECTION.test(next)) break;
      if (PAGE_HEADER.some((h) => squash(next).startsWith(h))) break;
      if (FOOTER.test(squash(next))) break;
      if (/^\d{8}\s/.test(next)) break; // the account-number line under a page header
      rest += " " + next;
      j++;
    }
    const amounts = undash(rest).match(MONEY) ?? [];
    if (amounts.length >= 2) {
      // The last two numbers are the amount and the running balance; anything
      // earlier is an ID or a reference number inside the description.
      const [amount, balance] = amounts.slice(-2) as [string, string];
      let desc = rest;
      // Every occurrence, as Python's str.replace does: a balance that also appears
      // in the text would otherwise survive into the description and the hash.
      for (const a of [amount, balance]) desc = desc.split(a).join(" ");
      desc = trimChars(undash(desc).split("-".repeat(8)).join(" ").replace(/\s+/g, " ").trim(), " -");
      // A withdrawal prints negative; the app stores money out as positive.
      out.push({ section, date, description: desc, cents: -cents(amount), balance_cents: cents(balance) });
    }
    i = j;
  }
  return out;
}

/** The BEGINNING BALANCE each section prints, which anchors its chain. */
function openingBalances(lines: string[]): Map<string, number> {
  const got = new Map<string, number>();
  let section: string | null = null;
  for (const l of lines) {
    const raw = l.trim();
    const s = SECTION.exec(raw);
    if (s) {
      section = s[1]!.trim();
      continue;
    }
    if (section && squash(raw).includes("BEGINNINGBALANCE") && !got.has(section)) {
      const nums = raw.match(MONEY);
      if (nums) got.set(section, cents(nums[nums.length - 1]!));
    }
  }
  return got;
}

/**
 * The statement's own balance column, walked. Each row must move the balance
 * from the previous figure to its own. A parser that drops a wrapped line or
 * reads a withdrawal as a deposit breaks the chain, so this is what makes a
 * PDF safe to import without anyone reading it: a complaint here stops the
 * import rather than quietly short a month.
 */
export function alliantProblems(lines: string[], txns: AlliantTxn[]): string[] {
  const problems: string[] = [];
  const opens = openingBalances(lines);
  for (const section of new Set(txns.map((t) => t.section))) {
    let running = opens.get(section);
    if (running === undefined) {
      problems.push(`${section} has no beginning balance`);
      continue;
    }
    for (const t of txns.filter((x) => x.section === section)) {
      running -= t.cents;
      if (running !== t.balance_cents) {
        problems.push(
          `${section} ${t.date} ${t.description.slice(0, 40)}: the running balance says ` +
            `${(running / 100).toFixed(2)}, the statement says ${(t.balance_cents / 100).toFixed(2)}`,
        );
        running = t.balance_cents; // resync so one bad row does not cascade
      }
    }
  }
  return problems;
}

/**
 * One statement's checking account as the table a CSV would have been.
 * Description is the counterparty alone so the app groups on it; Details keeps
 * the whole line, because rules match "merchant description" and the TYPE:/CO:
 * fields are what tell a payroll deposit from a refund.
 */
export function alliantTable(lines: string[], section = "CHECKING"): { table: ParsedCsv; problems: string[] } {
  const txns = parseAlliant(lines);
  const problems = alliantProblems(lines, txns);
  const rows = txns
    .filter((t) => t.section === section)
    .map((t) => {
      const [mm, dd, yy] = t.date.split("/");
      return {
        Date: `20${yy}-${mm}-${dd}`,
        Description: counterparty(t.description),
        Amount: (t.cents / 100).toFixed(2),
        Details: t.description,
      };
    })
    // Date order, stable, the way the script sorted, so `dedupeKeys` numbers two
    // identical same-day rows the same way it did when the CSV was imported.
    .map((r, idx) => ({ r, idx }))
    .sort((a, b) => a.r.Date.localeCompare(b.r.Date) || a.idx - b.idx)
    .map(({ r }) => r);
  return { table: { headers: [...ALLIANT_HEADERS], rows }, problems };
}
