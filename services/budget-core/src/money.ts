/** All money in this app is an integer number of cents. Never a float, never a string. */
export type Cents = number;

/** Round-half-away-from-zero integer division. Math.round(-0.5) is 0, which is wrong for money. */
export function divRound(numerator: number, denominator: number): Cents {
  if (denominator === 0) throw new Error("divRound: denominator is 0");
  const q = numerator / denominator;
  return q < 0 ? -Math.round(-q) : Math.round(q);
}

/**
 * Split `total` across `weights` so the parts sum to EXACTLY `total`.
 * Largest-remainder: floor everything, then hand the leftover pennies to the
 * largest fractional parts. allocate(100, [1,1,1]) is [34,33,33], never [33,33,33].
 */
export function allocate(total: Cents, weights: number[]): Cents[] {
  const n = weights.length;
  if (n === 0) return [];
  if (total < 0) return allocate(-total, weights).map((c) => -c);

  let w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  let sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    // ponytail: no meaningful weights (all zero/negative) -> even split.
    w = new Array(n).fill(1);
    sum = n;
  }

  const raw = w.map((x) => (total * x) / sum);
  const out = raw.map(Math.floor);
  const leftover = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < leftover; k++) out[order[k % n]!.i]! += 1;
  return out;
}

export const sum = (xs: Cents[]): Cents => xs.reduce((a, b) => a + b, 0);

/** 123456 -> "$1,234.56". Display only; never parse this back. */
export function formatCents(c: Cents): string {
  const neg = c < 0;
  const s = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-$" : "$") + s;
}
