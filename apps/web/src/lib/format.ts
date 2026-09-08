import { addMonths, monthOf, todayISO } from "@lumpy/budget-core";

/** Cents in, "$1,234.56" out. The only place money becomes a string. */
export function money(cents: number, opts: { sign?: boolean; cents?: boolean } = {}): string {
  const showCents = opts.cents ?? true;
  const s = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(Math.abs(cents) / 100);
  if (cents < 0) return `-${s}`;
  return opts.sign && cents > 0 ? `+${s}` : s;
}

/** "12.34" from a text field -> 1234 cents, without ever touching a float sum. */
export function toCents(input: string): number | null {
  const s = input.trim().replace(/[$,\s]/g, "");
  if (s === "") return null;
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[2] === "" && m[3] === undefined)) return null;
  const whole = m[2] === "" ? 0 : Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  return (m[1] === "-" ? -1 : 1) * (whole * 100 + frac);
}

export const centsToInput = (cents: number | null): string =>
  cents === null ? "" : (cents / 100).toFixed(2);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export const monthLabel = (m: string, short = false): string => {
  const name = MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m;
  return short ? `${name.slice(0, 3)} ${m.slice(2, 4)}` : `${name} ${m.slice(0, 4)}`;
};

export const dateLabel = (d: string): string =>
  `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]?.slice(0, 3)} ${Number(d.slice(8, 10))}`;

export const dateLabelFull = (d: string): string =>
  `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]?.slice(0, 3)} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

export const thisMonth = (): string => monthOf(todayISO());
export const shiftMonth = (m: string, n: number): string => addMonths(m, n);

export const ordinal = (day: number): string => {
  if (day === 0) return "last day";
  const s = ["th", "st", "nd", "rd"];
  const v = day % 100;
  return day + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
};

export const FREQUENCY_LABEL: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
  annual: "Once a year",
  one_time: "One-off",
};

export const BUCKET_LABEL: Record<string, string> = {
  discretionary: "Discretionary",
  fixed: "Fixed",
  lumpy: "Lumpy",
  savings: "Savings",
  transfer: "Transfer",
};

/** What each bucket means, in the reader's words. Written to follow the label: "Fixed — a bill that arrives every month". */
export const BUCKET_HINT: Record<string, string> = {
  discretionary: "counts against what you can spend",
  fixed: "a bill that arrives every month",
  lumpy: "paid out of the lumpy fund",
  savings: "money moved into a goal, not spent",
  transfer: "card payments and moving money between accounts",
};

export const BUCKET_ORDER = ["discretionary", "fixed", "lumpy", "savings", "transfer"] as const;

export const CYCLE_LABEL = (months: number): string =>
  months === 1 ? "Monthly" :
  months === 3 ? "Quarterly" :
  months === 6 ? "Twice a year" :
  months === 12 ? "Yearly" :
  months === 24 ? "Every 2 years" :
  `Every ${months} months`;

/**
 * "GEICO *AUTO 8829" -> "Geico Auto". A prefill for the Add dialog, not a name:
 * the statement's punctuation and its per-charge digits are noise, and the field
 * is right there to correct.
 *
 * A trailing LLC or INC goes: that is the legal entity, not the thing you are
 * budgeting for. Acronyms come out title-cased ("Aaa Membership") and are left
 * that way on purpose -- telling AAA from TAX needs a dictionary, and the field
 * this fills is one keystroke from being right.
 */
const ENTITY_SUFFIX = new Set(["LLC", "INC", "LTD", "CORP"]);

export function merchantTitle(m: string): string {
  const words = m.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\b\d+\b/g, " ").trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && ENTITY_SUFFIX.has(words[words.length - 1]!.toUpperCase())) words.pop();
  if (words.length === 0) return m.trim();
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
