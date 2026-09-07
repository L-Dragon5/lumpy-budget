import { expect, test } from "bun:test";
import { fixedCost, stream } from "../fixtures/factories";
import { allocateMonth } from "../src/fixed";

const semi = () => stream({ name: "Day job", frequency: "semimonthly", anchor_date: null, day_1: 15, day_2: 0, amount_cents: 300000 });

test("a bill due before the month's first paycheck is held by last month's paycheck", () => {
  const rent = fixedCost({ name: "Rent", amount_cents: 150000, due_day: 1, lead_days: 3 });
  const a = allocateMonth({ streams: [semi()], fixedCosts: [rent], month: "2026-03" });

  // Target is 2026-02-26; the last paycheck on or before that is 2026-02-15.
  const carrier = a.paychecks.find((p) => p.holds.some((h) => h.name === "Rent"))!;
  expect(carrier.date).toBe("2026-02-15");
  expect(carrier.prior_month).toBe(true);
  expect(carrier.holds[0]!.due_date).toBe("2026-03-01");
  expect(carrier.holds[0]!.late).toBe(false);
  expect(a.unfunded).toEqual([]);
  // The month's own paychecks are all still listed.
  expect(a.paychecks.filter((p) => !p.prior_month).map((p) => p.date)).toEqual(["2026-03-15", "2026-03-31"]);
  expect(a.income_cents).toBe(600000);
});

test("each bill lands on the last paycheck that clears its lead time", () => {
  const costs = [
    fixedCost({ name: "Rent", amount_cents: 150000, due_day: 1, lead_days: 3 }),
    fixedCost({ name: "Internet", amount_cents: 8000, due_day: 20, lead_days: 3 }),
    fixedCost({ name: "Electric", amount_cents: 14000, due_day: 28, lead_days: 0 }),
    fixedCost({ name: "Car loan", amount_cents: 42000, due_day: 16, lead_days: 0 }),
  ];
  const a = allocateMonth({ streams: [semi()], fixedCosts: costs, month: "2026-03" });
  const on = (date: string) => a.paychecks.find((p) => p.date === date)!.holds.map((h) => h.name);

  expect(on("2026-02-15")).toEqual(["Rent"]);
  expect(on("2026-03-15")).toEqual(["Car loan", "Internet", "Electric"]);
  expect(a.paychecks.find((p) => p.date === "2026-03-15")!.hold_total_cents).toBe(8000 + 14000 + 42000);
  expect(a.paychecks.find((p) => p.date === "2026-03-31")!.holds).toEqual([]);
});

test("lumpy and savings split across the month's paychecks, in proportion, to the penny", () => {
  const big = stream({ name: "Big", frequency: "monthly", anchor_date: null, day_of_month: 1, amount_cents: 400000 });
  const small = stream({ name: "Small", frequency: "monthly", anchor_date: null, day_of_month: 20, amount_cents: 200000 });
  const a = allocateMonth({
    streams: [big, small],
    fixedCosts: [],
    month: "2026-03",
    lumpyMonthlyCents: 30001,
    savingsMonthlyCents: 60000,
  });
  const [first, second] = a.paychecks;
  expect(first!.lumpy_cents + second!.lumpy_cents).toBe(30001);
  expect(first!.lumpy_cents).toBe(20001); // 2/3 of the income carries 2/3 of the transfer
  expect(second!.lumpy_cents).toBe(10000);
  expect(first!.savings_cents).toBe(40000);
  expect(second!.savings_cents).toBe(20000);
  expect(first!.free_cents).toBe(400000 - 20001 - 40000);
  expect(a.free_total_cents).toBe(600000 - 30001 - 60000);
});

test("a paycheck that cannot cover what it is holding is flagged, not hidden", () => {
  const a = allocateMonth({
    streams: [stream({ frequency: "monthly", anchor_date: null, day_of_month: 1, amount_cents: 100000 })],
    fixedCosts: [fixedCost({ name: "Rent", amount_cents: 150000, due_day: 10, lead_days: 0 })],
    month: "2026-03",
  });
  const p = a.paychecks.find((x) => x.date === "2026-03-01")!;
  expect(p.free_cents).toBe(-50000);
  expect(p.over_committed).toBe(true);
});

test("with no income at all, every bill is unfunded rather than silently dropped", () => {
  const a = allocateMonth({ streams: [], fixedCosts: [fixedCost()], month: "2026-03" });
  expect(a.paychecks).toEqual([]);
  expect(a.unfunded.map((h) => h.name)).toEqual(["Rent"]);
});

test("a bill due before any paycheck exists is marked late but still assigned", () => {
  // Only paycheck in range is the 20th; the bill is due on the 2nd.
  const s = stream({ frequency: "monthly", anchor_date: null, day_of_month: 20, amount_cents: 500000 });
  const a = allocateMonth({ streams: [s], fixedCosts: [fixedCost({ name: "HOA", due_day: 2, lead_days: 0 })], month: "2026-01" });
  const hold = a.paychecks.flatMap((p) => p.holds).find((h) => h.name === "HOA")!;
  expect(hold.late).toBe(false); // 2025-12-20 is inside the lookback window and covers it
  const tight = allocateMonth({
    streams: [stream({ frequency: "annual", anchor_date: "2026-01-20", amount_cents: 500000 })],
    fixedCosts: [fixedCost({ name: "HOA", due_day: 2, lead_days: 0 })],
    month: "2026-01",
  });
  expect(tight.paychecks[0]!.holds[0]!.late).toBe(true);
});

test("inactive bills and inactive streams are excluded", () => {
  const a = allocateMonth({
    streams: [semi(), stream({ name: "Gone", active: false, amount_cents: 999999 })],
    fixedCosts: [fixedCost({ name: "Cancelled", active: false })],
    month: "2026-03",
  });
  expect(a.paychecks.flatMap((p) => p.holds)).toEqual([]);
  expect(a.fixed_total_cents).toBe(0);
  expect(a.income_cents).toBe(600000);
});
