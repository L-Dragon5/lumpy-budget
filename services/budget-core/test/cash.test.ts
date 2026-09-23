import { expect, test } from "bun:test";
import { fixedCost, stream } from "../fixtures/factories";
import { allocateMonth } from "../src/fixed";
import { cashPosition, importFreshness, STALE_IMPORT_DAYS } from "../src/cash";

// Biweekly pay on the 6th and 20th of March, rent on the 1st, car loan on the 10th.
const streams = [stream({ name: "Job", amount_cents: 200000, frequency: "biweekly", anchor_date: "2026-03-06" })];
const costs = [
  fixedCost({ name: "Rent", amount_cents: 150000, due_day: 1, lead_days: 3 }),
  fixedCost({ name: "Car loan", amount_cents: 40000, due_day: 10, lead_days: 2 }),
  fixedCost({ name: "Internet", amount_cents: 8000, due_day: 24, lead_days: 1 }),
];

const march = () => allocateMonth({ streams, fixedCosts: costs, month: "2026-03" }).paychecks;

test("what the balance has to survive is the bills before the next paycheck, not the month's", () => {
  const pos = cashPosition({
    paychecks: march(),
    today: "2026-03-08",
    balanceCents: 100000,
    asOf: "2026-03-08",
  });
  expect(pos.next_paycheck_date).toBe("2026-03-20");
  // The car loan on the 10th lands before payday; internet on the 24th does not.
  expect(pos.due.map((x) => x.name)).toEqual(["Car loan"]);
  expect(pos.due_before_next_paycheck_cents).toBe(40000);
  expect(pos.projected_cents).toBe(60000);
  expect(pos.short).toBe(false);
});

test("a balance that cannot cover the next bill says so", () => {
  const pos = cashPosition({
    paychecks: march(),
    today: "2026-03-08",
    balanceCents: 25000,
    asOf: "2026-03-08",
  });
  expect(pos.projected_cents).toBe(-15000);
  expect(pos.short).toBe(true);
});

test("a bill already past its due date is not owed out of this balance", () => {
  const pos = cashPosition({
    paychecks: march(),
    today: "2026-03-11",
    balanceCents: 100000,
    asOf: "2026-03-11",
  });
  expect(pos.due).toEqual([]);
  expect(pos.projected_cents).toBe(100000);
});

test("with no paycheck ahead, everything still due is on this balance", () => {
  const pos = cashPosition({
    paychecks: march(),
    today: "2026-03-21",
    balanceCents: 100000,
    asOf: "2026-03-21",
  });
  expect(pos.next_paycheck_date).toBeNull();
  expect(pos.due.map((x) => x.name)).toEqual(["Internet"]);
});

test("one bill held on two months' allocations is still one bill", () => {
  const both = [
    ...allocateMonth({ streams, fixedCosts: costs, month: "2026-03" }).paychecks,
    ...allocateMonth({ streams, fixedCosts: costs, month: "2026-04" }).paychecks,
  ];
  const pos = cashPosition({ paychecks: both, today: "2026-03-08", balanceCents: 100000, asOf: "2026-03-08" });
  expect(pos.due.filter((x) => x.name === "Car loan")).toHaveLength(1);
});

test("a stale balance reports its own age and what has been spent since", () => {
  const pos = cashPosition({
    paychecks: march(),
    today: "2026-03-18",
    balanceCents: 100000,
    asOf: "2026-03-11",
    spentSinceCents: 24300,
    spentSinceCount: 9,
  });
  expect(pos.days_stale).toBe(7);
  expect(pos.spent_since_cents).toBe(24300);
  expect(pos.spent_since_count).toBe(9);
});

test("a balance typed in today is not stale", () => {
  const pos = cashPosition({ paychecks: march(), today: "2026-03-18", balanceCents: 1, asOf: "2026-03-18" });
  expect(pos.days_stale).toBe(0);
});

test("an account that does not pay the bills is not asked to survive them", () => {
  const input = { paychecks: march(), today: "2026-03-08", balanceCents: 100000, asOf: "2026-03-08" };
  const bills = cashPosition(input);
  const everyday = cashPosition({ ...input, paysBills: false });

  // The same balance, the same day, the same plan. The only question that
  // differs is whether the car loan on the 10th is a claim on this money -- and
  // for a household with a second account holding the bills, it is not.
  expect(bills.due_before_next_paycheck_cents).toBe(40000);
  expect(everyday.due).toEqual([]);
  expect(everyday.due_before_next_paycheck_cents).toBe(0);
  expect(everyday.projected_cents).toBe(100000);
  expect(everyday.short).toBe(false);
  // Everything that is not about the bills still is: payday and the staleness
  // warning are the same on both accounts.
  expect(everyday.next_paycheck_date).toBe(bills.next_paycheck_date);
  expect(everyday.next_paycheck_cents).toBe(bills.next_paycheck_cents);
});

test("an everyday account is never short on bills it does not pay", () => {
  // Not enough for the car loan. Pooled, this tile would shout; split, the car
  // loan is funded in the other account and this balance is just small.
  const pos = cashPosition({
    paychecks: march(), today: "2026-03-08", balanceCents: 2500, asOf: "2026-03-08", paysBills: false,
  });
  expect(pos.short).toBe(false);
  expect(pos.projected_cents).toBe(2500);
});

test("an account is stale once its newest transaction is more than a month old", () => {
  const today = "2026-03-20";
  const [a, b] = importFreshness(
    [
      { profile_id: 1, name: "Checking", last_txn_date: "2026-02-18" }, // exactly 30: not yet
      { profile_id: 2, name: "Card", last_txn_date: "2026-02-17" }, // 31
    ],
    today,
  );
  expect(STALE_IMPORT_DAYS).toBe(30);
  // Stalest first: the account most out of date is the one the dashboard names.
  expect([a!.name, a!.days_behind, a!.stale]).toEqual(["Card", 31, true]);
  expect([b!.name, b!.days_behind, b!.stale]).toEqual(["Checking", 30, false]);
});

test("a transaction dated after today is not evidence the import is ahead", () => {
  const [r] = importFreshness([{ profile_id: 1, name: "Checking", last_txn_date: "2026-03-25" }], "2026-03-20");
  expect(r!.days_behind).toBe(0);
  expect(r!.stale).toBe(false);
});

test("the threshold is an argument", () => {
  const [r] = importFreshness([{ profile_id: 1, name: "C", last_txn_date: "2026-03-10" }], "2026-03-20", 7);
  expect(r!.stale).toBe(true);
});
