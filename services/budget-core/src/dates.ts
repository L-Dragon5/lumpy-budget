/**
 * Dates are `YYYY-MM-DD` strings, months are `YYYY-MM` strings, end of story.
 * Arithmetic runs on UTC internals so DST can never shift a pay date, and no
 * local-timezone `Date` ever crosses the DB or HTTP boundary.
 */
export type ISODate = string;
export type ISOMonth = string;

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_MONTH = /^\d{4}-\d{2}$/;

export function assertDate(d: string): ISODate {
  if (!RE_DATE.test(d)) throw new Error(`bad ISODate: ${d}`);
  return d;
}
export function assertMonth(m: string): ISOMonth {
  if (!RE_MONTH.test(m)) throw new Error(`bad ISOMonth: ${m}`);
  return m;
}

export function parts(d: ISODate): [number, number, number] {
  assertDate(d);
  return [+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10)];
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function fromParts(y: number, m: number, d: number): ISODate {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const epochDay = (d: ISODate): number => {
  const [y, m, dd] = parts(d);
  return Date.UTC(y, m - 1, dd) / 86400000;
};

export function addDays(d: ISODate, n: number): ISODate {
  const t = new Date((epochDay(d) + n) * 86400000);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function diffDays(a: ISODate, b: ISODate): number {
  return epochDay(b) - epochDay(a);
}

export function compare(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** day 0 (or past the end of the month) means "last day of the month". */
export function clampDay(y: number, m: number, day: number): ISODate {
  const len = daysInMonth(y, m);
  const d = day <= 0 || day > len ? len : day;
  return fromParts(y, m, d);
}

export const monthOf = (d: ISODate): ISOMonth => assertDate(d).slice(0, 7);
export const monthParts = (m: ISOMonth): [number, number] => {
  assertMonth(m);
  return [+m.slice(0, 4), +m.slice(5, 7)];
};
export const monthStart = (m: ISOMonth): ISODate => `${assertMonth(m)}-01`;
export function monthEnd(m: ISOMonth): ISODate {
  const [y, mm] = monthParts(m);
  return fromParts(y, mm, daysInMonth(y, mm));
}

export function addMonths(m: ISOMonth, n: number): ISOMonth {
  const [y, mm] = monthParts(m);
  const total = y * 12 + (mm - 1) + n;
  return `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1)}`;
}

export function monthsBetween(a: ISOMonth, b: ISOMonth): number {
  const [ya, ma] = monthParts(a);
  const [yb, mb] = monthParts(b);
  return (yb * 12 + mb) - (ya * 12 + ma);
}

export function monthRange(start: ISOMonth, count: number): ISOMonth[] {
  return Array.from({ length: count }, (_, i) => addMonths(start, i));
}

/** 0 = Sunday. */
export function dayOfWeek(d: ISODate): number {
  const [y, m, dd] = parts(d);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
}

/** Week containing `d`, starting on `startDow` (default Sunday, US convention). */
export function weekStart(d: ISODate, startDow = 0): ISODate {
  const back = (dayOfWeek(d) - startDow + 7) % 7;
  return addDays(d, -back);
}

export function todayISO(now = new Date()): ISODate {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
