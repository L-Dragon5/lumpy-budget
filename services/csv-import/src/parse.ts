import Papa from "papaparse";
import type { ImportMapping } from "@lumpy/contracts";

export type ParsedCsv = { headers: string[]; rows: Record<string, string>[] };

/**
 * Papaparse rather than a split(",") because real statements contain quoted
 * commas, embedded newlines and a UTF-8 BOM, and every hand-rolled CSV parser
 * discovers this the hard way.
 */
export function parseCsv(text: string, skipRows = 0): ParsedCsv {
  const body = skipRows > 0 ? text.split(/\r?\n/).slice(skipRows).join("\n") : text;
  const res = Papa.parse<Record<string, string>>(body.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const headers = (res.meta.fields ?? []).filter((h) => h.length > 0);
  const rows = res.data.filter((r) => headers.some((h) => (r[h] ?? "").trim() !== ""));
  return { headers, rows };
}

export type DateFormat = ImportMapping["date_format"];

/** "$1,234.56" and "(12.34)" both appear in the wild. Parsed as integers so no float ever touches money. */
export function parseAmountCents(raw: string): number | null {
  let s = (raw ?? "").trim();
  if (s === "") return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$£€\s,]/g, "");
  if (s.startsWith("-")) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const m = /^(\d*)(?:\.(\d{0,}))?$/.exec(s);
  if (!m || (m[1] === "" && m[2] === undefined)) return null;
  const whole = m[1] === "" ? 0 : Number(m[1]);
  const fracRaw = (m[2] ?? "").slice(0, 3).padEnd(3, "0");
  // Round the third decimal rather than truncating it.
  const cents = whole * 100 + Math.round(Number(fracRaw) / 10);
  return sign * cents;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Returns YYYY-MM-DD, or null when the value is not a date this app understands. */
export function parseDate(raw: string, format: DateFormat = "auto"): string | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return build(+iso[1]!, +iso[2]!, +iso[3]!);

  const slash = /^(\d{4})[/](\d{1,2})[/](\d{1,2})/.exec(s);
  if (slash) return build(+slash[1]!, +slash[2]!, +slash[3]!);

  // "15 Mar 2026" / "Mar 15, 2026"
  const named = /^(\d{1,2})[\s-]*([A-Za-z]{3,})[\s,-]*(\d{2,4})$/.exec(s);
  if (named && MONTHS[named[2]!.slice(0, 3).toLowerCase()])
    return build(year(+named[3]!), MONTHS[named[2]!.slice(0, 3).toLowerCase()]!, +named[1]!);
  const named2 = /^([A-Za-z]{3,})[\s-]*(\d{1,2})[\s,-]*(\d{2,4})$/.exec(s);
  if (named2 && MONTHS[named2[1]!.slice(0, 3).toLowerCase()])
    return build(year(+named2[3]!), MONTHS[named2[1]!.slice(0, 3).toLowerCase()]!, +named2[2]!);

  const parts = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(s);
  if (!parts) return null;
  const a = +parts[1]!;
  const b = +parts[2]!;
  const y = year(+parts[3]!);
  const dayFirst = format === "DD/MM/YYYY" || format === "DD-MM-YYYY" || (format === "auto" && a > 12);
  return dayFirst ? build(y, b, a) : build(y, a, b);
}

const year = (y: number): number => (y < 100 ? 2000 + y : y);

function build(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return null;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(m)}-${p(d)}`;
}

/**
 * MM/DD vs DD/MM is genuinely ambiguous, so look at the whole column: a value
 * with a first component over 12 settles it. Falls back to US order.
 */
export function detectDateFormat(values: string[]): DateFormat {
  const cleaned = values.map((v) => (v ?? "").trim()).filter(Boolean);
  if (cleaned.length === 0) return "auto";
  if (cleaned.every((v) => /^\d{4}-\d{1,2}-\d{1,2}/.test(v))) return "YYYY-MM-DD";
  let sawDayFirst = false;
  let sawMonthFirst = false;
  let dash = false;
  for (const v of cleaned) {
    const m = /^(\d{1,2})([/-])(\d{1,2})[/-]\d{2,4}/.exec(v);
    if (!m) continue;
    if (m[2] === "-") dash = true;
    if (+m[1]! > 12) sawDayFirst = true;
    if (+m[3]! > 12) sawMonthFirst = true;
  }
  if (sawDayFirst && !sawMonthFirst) return dash ? "DD-MM-YYYY" : "DD/MM/YYYY";
  if (sawMonthFirst && !sawDayFirst) return dash ? "MM-DD-YYYY" : "MM/DD/YYYY";
  return dash ? "MM-DD-YYYY" : "MM/DD/YYYY";
}
