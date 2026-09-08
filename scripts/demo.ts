#!/usr/bin/env bun
/**
 * Fills a running instance with a realistic household through the public API,
 * so what you see in the browser went through exactly the same path a real
 * entry would.
 *
 * Safe to re-run: setup rows are matched by name and updated rather than added
 * again, and the expense dedupe hash makes the import a no-op the second time.
 *
 *   bun run demo            # against http://localhost:3001
 *   bun run demo --reset    # delete the existing setup first
 */
import { addMonths, monthOf, todayISO } from "@lumpy/budget-core";

const base = process.env.API_URL ?? "http://localhost:3001";
const reset = process.argv.includes("--reset");

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return parsed;
};

/**
 * Create, or update the row that already has this name. Without this a second
 * run would quietly double the household's income, since nothing but the
 * expense hash is unique.
 */
async function upsert(resource: string, body: { name: string } & Record<string, unknown>) {
  const existing: { id: number; name: string }[] = await call("GET", `/api/${resource}`);
  const match = existing.find((r) => r.name.toLowerCase() === body.name.toLowerCase());
  return match
    ? call("PUT", `/api/${resource}/${match.id}`, body)
    : call("POST", `/api/${resource}`, body);
}

const month = monthOf(todayISO());
const rel = (n: number) => addMonths(month, n);

if (reset) {
  for (const resource of ["income-streams", "fixed-costs", "lumpy-items", "savings-goals"]) {
    for (const row of await call("GET", `/api/${resource}`)) await call("DELETE", `/api/${resource}/${row.id}`);
  }
  for (const batch of await call("GET", "/api/import-batches")) await call("DELETE", `/api/import-batches/${batch.id}`);
  console.log("cleared existing setup");
}

await upsert("income-streams", {
  name: "Day job", amount_cents: 312500, frequency: "semimonthly",
  anchor_date: null, day_1: 15, day_2: 0, day_of_month: null, active: true,
});
await upsert("income-streams", {
  name: "Rental income", amount_cents: 185000, frequency: "monthly",
  anchor_date: null, day_1: null, day_2: null, day_of_month: 5, active: true,
});
await upsert("income-streams", {
  name: "Consulting retainer", amount_cents: 90000, frequency: "biweekly",
  anchor_date: `${rel(0)}-06`, day_1: null, day_2: null, day_of_month: null, active: true,
});

const categories: { id: number; name: string }[] = await call("GET", "/api/categories");
const cat = (name: string) => categories.find((c) => c.name === name)?.id ?? null;

// The last column is how the bill posts on a statement, where one of the FIXED_PAYMENTS
// below is it. Those bills get their own budgeted-vs-actual line; the rest are
// compared by category, which is what the app does when you have not said.
const fixed: [string, number, number, number, string | null, string | null][] = [
  ["Mortgage", 241800, 1, 3, "Housing", "MORTGAGE CO ACH"],
  ["Childcare", 92000, 1, 3, "Childcare", "BRIGHT HORIZONS"],
  ["Car loan", 48900, 16, 2, "Auto Loan", "CAPITAL ONE AUTO"],
  ["Health insurance", 38000, 15, 2, "Utilities", null],
  ["Student loan", 32700, 28, 2, null, null],
  ["Gas & electric", 21500, 12, 2, "Utilities", "NATIONAL GRID"],
  ["Rental property mgmt", 14800, 10, 2, "Housing", "GREENTREE PROPERTY"],
  ["Cell phone", 11000, 8, 2, "Internet & Phone", "VERIZON WIRELESS"],
  ["Internet", 8999, 20, 2, "Internet & Phone", "COMCAST XFINITY"],
  ["Water & sewer", 7200, 25, 2, "Utilities", null],
  ["Gym", 4900, 22, 0, null, null],
  ["Trash pickup", 3500, 5, 2, "Utilities", null],
];
for (const [name, amount_cents, due_day, lead_days, category, merchant_pattern] of fixed) {
  await upsert("fixed-costs", {
    name, amount_cents, due_day, lead_days, merchant_pattern,
    category_id: category ? cat(category) : null, active: true,
  });
}

const lumpy: [string, number, number, string][] = [
  ["Car insurance", 142800, 6, `${rel(2)}-01`],
  ["Home insurance", 168000, 12, `${rel(6)}-15`],
  ["Property taxes", 420000, 6, `${rel(4)}-01`],
  ["HOA dues", 45000, 3, `${rel(1)}-01`],
  ["Car registration", 12500, 24, `${rel(11)}-01`],
  ["Amazon Prime", 13900, 12, `${rel(8)}-04`],
  ["Domain renewals", 8600, 12, `${rel(3)}-18`],
  ["Credit card annual fee", 9500, 12, `${rel(5)}-09`],
  ["Furnace service", 24000, 12, `${rel(7)}-01`],
];
for (const [name, amount_cents, frequency_months, next_due_date] of lumpy) {
  await upsert("lumpy-items", {
    name, amount_cents, frequency_months, next_due_date,
    category_id: cat("Insurance"), active: true,
  });
}

await upsert("savings-goals", {
  name: "Emergency fund", mode: "fixed", amount_cents: 40000, percent: null,
  target_cents: 1800000, balance_cents: 640000, active: true,
});
await upsert("savings-goals", {
  name: "Brokerage", mode: "percent", amount_cents: null, percent: 8,
  target_cents: null, balance_cents: 1215000, active: true,
});
await upsert("savings-goals", {
  name: "New roof", mode: "fixed", amount_cents: 25000, percent: null,
  target_cents: 1200000, balance_cents: 1245000, active: true,
});

await call("PUT", "/api/settings", { name: "lumpy_opening_balance_cents", value: "250000" });

// Four months of transactions, deterministic so re-running changes nothing. Four,
// not three, because budgeted-vs-actual reads the three *complete* months before
// this one: with three the earliest of them has no statement and every bill in it
// reads as missing.
const MERCHANTS: [merchant: string, low: number, high: number, perMonth: number][] = [
  ["WEGMANS #1042", 4200, 19500, 5],
  ["TRADER JOES", 2800, 9400, 3],
  ["COSTCO WHOLESALE", 8600, 24000, 1],
  ["STARBUCKS", 550, 1400, 6],
  ["CHIPOTLE", 1100, 2600, 3],
  ["DOORDASH", 2400, 6800, 2],
  ["SHELL OIL 574", 3600, 7200, 3],
  ["AMAZON.COM*RT4D2", 1200, 14500, 6],
  ["TARGET 00019", 2200, 11000, 2],
  ["NETFLIX.COM", 1549, 1549, 1],
  ["SPOTIFY USA", 1199, 1199, 1],
  ["CVS/PHARMACY #3011", 900, 4800, 2],
  ["HOME DEPOT #4417", 1800, 16500, 1],
  ["PETCO 1188", 2400, 8900, 1],
  ["AMC THEATRES", 1900, 5400, 1],
];
// The last column is how far the bill swings month to month. A mortgage is the same
// number forever; gas and electric is the reason budgeted-vs-actual exists at all, so
// it swings, and the demo can actually show a bill running over what it was entered at.
const FIXED_PAYMENTS: [merchant: string, cents: number, day: number, swing: number][] = [
  ["MORTGAGE CO ACH", 241800, 2, 0],
  ["BRIGHT HORIZONS", 92000, 2, 0],
  ["CAPITAL ONE AUTO", 48900, 16, 0],
  ["GREENTREE PROPERTY", 14800, 10, 1500],
  ["NATIONAL GRID", 21500, 12, 9500],
  ["COMCAST XFINITY", 8999, 20, 0],
  ["VERIZON WIRELESS", 11000, 8, 1200],
  ["ONLINE TRANSFER TO SAV", 40000, 16, 0],
];

// A tiny deterministic PRNG: the same demo data every time it runs.
let seed = 20260101;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (low: number, high: number) => low + Math.floor(rand() * (high - low + 1));

const rows: { txn_date: string; amount_cents: number; merchant: string; description: string; category_id: null; source: string }[] = [];
for (const offset of [-3, -2, -1, 0]) {
  const m = rel(offset);
  for (const [merchant, low, high, perMonth] of MERCHANTS) {
    for (let i = 0; i < perMonth; i++) {
      rows.push({
        txn_date: `${m}-${String(1 + Math.floor(rand() * 27)).padStart(2, "0")}`,
        amount_cents: pick(low, high),
        merchant,
        description: "",
        category_id: null,
        source: "demo",
      });
    }
  }
  for (const [merchant, cents, day, swing] of FIXED_PAYMENTS) {
    // One bill, one month, deliberately absent: the demo should show what a bill
    // that did not post looks like, since that is the whole point of the badge.
    if (offset === -3 && merchant === "NATIONAL GRID") continue;
    rows.push({
      txn_date: `${m}-${String(day).padStart(2, "0")}`,
      // Skewed upward: a utility bill that varies mostly varies by costing more.
      amount_cents: swing === 0 ? cents : pick(cents - Math.round(swing / 3), cents + swing),
      merchant,
      description: "",
      category_id: null,
      source: "demo",
    });
  }
}

/**
 * Older statements, so the app has something to *find*: charges on a cycle
 * longer than a month that nobody has entered as a lumpy item. These are
 * deliberately not in the `lumpy` list above -- a suggestion the fund already
 * covers is filtered out, and a demo of the detector needs something left to
 * detect. Each one rises a little between renewals, the way a real premium does.
 */
const RECURRING_HISTORY: [merchant: string, cents: number, cycleMonths: number, day: number][] = [
  ["ERIE INSURANCE UMBRELLA", 34500, 12, 14],
  ["TOWN OF PERINTON TAX", 89000, 12, 22],
  ["MONROE COUNTY WATER", 21400, 3, 6],
  ["AAA MEMBERSHIP", 18600, 6, 19],
  ["CHIMNEY SWEEP LLC", 27500, 12, 11],
];
for (const [merchant, cents, cycleMonths, day] of RECURRING_HISTORY) {
  // Back far enough that an annual charge has been seen twice, which is what the
  // detector needs before it will say anything.
  for (let back = 30; back >= 1; back -= cycleMonths) {
    rows.push({
      txn_date: `${rel(-back)}-${String(day).padStart(2, "0")}`,
      // 2% a year, rounded to the dollar, so "was $214 on average" has something to say.
      amount_cents: Math.round((cents * (1 + (30 - back) * 0.0017)) / 100) * 100,
      merchant,
      description: "",
      category_id: null,
      source: "demo",
    });
  }
}

const result = await call("POST", "/api/import", {
  filename: "demo-statement.csv",
  profile_id: null,
  rows,
});

console.log(
  `demo data loaded: 3 income streams, ${fixed.length} fixed costs, ${lumpy.length} lumpy items, ` +
    `2 savings goals, ${result.inserted} expenses (${result.skipped} already there), ` +
    `${RECURRING_HISTORY.length} recurring charges waiting to be found`,
);
