import type { IncomeStream } from "@lumpy/contracts";
import * as d from "./dates";
import type { ISODate, ISOMonth } from "./dates";

export type Occurrence = {
  stream_id: number;
  stream_name: string;
  date: ISODate;
  amount_cents: number;
};

/** Every pay date for one stream inside [start, end], inclusive, ascending. */
export function occurrences(s: IncomeStream, start: ISODate, end: ISODate): Occurrence[] {
  if (!s.active) return [];
  const dates: ISODate[] = [];

  switch (s.frequency) {
    case "weekly":
    case "biweekly": {
      const step = s.frequency === "weekly" ? 7 : 14;
      const anchor = s.anchor_date;
      if (!anchor) return [];
      // Walk the anchor forward or backward to the first occurrence >= start.
      const k = Math.ceil(d.diffDays(anchor, start) / step);
      let cur = d.addDays(anchor, k * step);
      while (d.compare(cur, start) < 0) cur = d.addDays(cur, step);
      while (d.compare(cur, end) <= 0) {
        dates.push(cur);
        cur = d.addDays(cur, step);
      }
      break;
    }
    case "semimonthly": {
      if (s.day_1 === null || s.day_2 === null) return [];
      for (const m of monthsSpanning(start, end)) {
        const [y, mm] = d.monthParts(m);
        // day 0 means the last day of the month; both days clamp to month length.
        const pair = [d.clampDay(y, mm, s.day_1), d.clampDay(y, mm, s.day_2)].sort();
        for (const x of pair) if (inRange(x, start, end)) dates.push(x);
      }
      break;
    }
    case "monthly": {
      if (s.day_of_month === null) return [];
      for (const m of monthsSpanning(start, end)) {
        const [y, mm] = d.monthParts(m);
        const x = d.clampDay(y, mm, s.day_of_month);
        if (inRange(x, start, end)) dates.push(x);
      }
      break;
    }
    case "one_time": {
      // Once, on its date. Nothing to walk.
      if (s.anchor_date && inRange(s.anchor_date, start, end)) dates.push(s.anchor_date);
      break;
    }
    case "annual": {
      if (!s.anchor_date) return [];
      const [, am, ad] = d.parts(s.anchor_date);
      const y0 = +start.slice(0, 4);
      const y1 = +end.slice(0, 4);
      for (let y = y0; y <= y1; y++) {
        const x = d.clampDay(y, am, ad); // Feb 29 anchor lands on Feb 28 in common years
        if (inRange(x, start, end)) dates.push(x);
      }
      break;
    }
  }

  dates.sort();
  return dates.map((date) => ({
    stream_id: s.id,
    stream_name: s.name,
    date,
    amount_cents: s.amount_cents,
  }));
}

/** All streams merged and sorted by date, then by stream id for a stable order. */
export function allOccurrences(streams: IncomeStream[], start: ISODate, end: ISODate): Occurrence[] {
  return streams
    .flatMap((s) => occurrences(s, start, end))
    .sort((a, b) => d.compare(a.date, b.date) || a.stream_id - b.stream_id);
}

export function occurrencesInMonth(streams: IncomeStream[], month: ISOMonth): Occurrence[] {
  return allOccurrences(streams, d.monthStart(month), d.monthEnd(month));
}

/**
 * Months in `year` where this stream pays more times than a normal month.
 * Only weekly (5 checks) and biweekly (3 checks) can do this; a semimonthly or
 * monthly stream pays the same number of times every single month, and a one-off
 * is surplus by construction rather than an extra check.
 */
export function extraPaycheckMonths(s: IncomeStream, year: number): ISOMonth[] {
  if (s.frequency !== "weekly" && s.frequency !== "biweekly") return [];
  const baseline = s.frequency === "weekly" ? 4 : 2;
  const out: ISOMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, "0")}`;
    if (occurrences(s, d.monthStart(month), d.monthEnd(month)).length > baseline) out.push(month);
  }
  return out;
}

const inRange = (x: ISODate, start: ISODate, end: ISODate) =>
  d.compare(x, start) >= 0 && d.compare(x, end) <= 0;

function monthsSpanning(start: ISODate, end: ISODate): ISOMonth[] {
  const first = d.monthOf(start);
  const n = d.monthsBetween(first, d.monthOf(end)) + 1;
  return n <= 0 ? [] : d.monthRange(first, n);
}
