import { expect, test } from "bun:test";
import { category, expense, fixedCost, goal, lumpy, stream } from "../fixtures/factories";
import { currentPeriod, monthSummary, periodPace, type BudgetInputs } from "../src/summary";

// Joe's actual shape: semi-monthly day job, monthly rental income.
const dayJob = stream({ name: "Day job", frequency: "semimonthly", anchor_date: null, day_1: 15, day_2: 0, amount_cents: 300000 });
const rental = stream({ name: "Rental", frequency: "monthly", anchor_date: null, day_of_month: 5, amount_cents: 180000 });
const groceries = category({ name: "Groceries", bucket: "discretionary" });
const rentCat = category({ name: "Housing", bucket: "fixed" });

const inputs = (over: Partial<BudgetInputs> = {}): BudgetInputs => ({
  streams: [dayJob, rental],
  fixedCosts: [
    fixedCost({ name: "Rent", amount_cents: 150000, due_day: 1, lead_days: 3, category_id: rentCat.id }),
    fixedCost({ name: "Car loan", amount_cents: 42000, due_day: 16, lead_days: 0 }),
    fixedCost({ name: "Internet", amount_cents: 8000, due_day: 20, lead_days: 3 }),
  ],
  lumpyItems: [lumpy({ name: "Car insurance", amount_cents: 120000, frequency_months: 12, next_due_date: "2027-03-01" })],
  savingsGoals: [
    goal({ name: "Emergency", mode: "fixed", amount_cents: 50000 }),
    goal({ name: "Vacation", mode: "percent", amount_cents: null, percent: 5 }),
  ],
  expenses: [
    expense({ txn_date: "2026-03-10", amount_cents: 25000, category_id: groceries.id }),
    expense({ txn_date: "2026-03-20", amount_cents: 10000, category_id: groceries.id }),
    expense({ txn_date: "2026-03-01", amount_cents: 150000, category_id: rentCat.id, merchant: "Landlord" }),
  ],
  categories: [groceries, rentCat],
  month: "2026-03",
  ...over,
});

test("the month ties out by hand", () => {
  const s = monthSummary(inputs());
  expect(s.income_cents).toBe(780000); // 300000 x2 + 180000
  expect(s.income_normalized_cents).toBe(780000);
  expect(s.extra_paycheck).toBe(false);
  expect(s.fixed_cents).toBe(200000);
  expect(s.lumpy_cents).toBe(10000); // 120000 / 12, exactly a cycle out
  expect(s.savings_cents).toBe(50000 + 39000); // fixed + 5% of 780000
  expect(s.planned_free_cents).toBe(780000 - 200000 - 10000 - 89000);
  expect(s.planned_free_cents).toBe(481000);
});

test("paying the rent does not get subtracted twice", () => {
  const s = monthSummary(inputs());
  expect(s.spent.total).toBe(185000);
  expect(s.spent.discretionary).toBe(35000);
  expect(s.spent.fixed).toBe(150000);
  // Only the 35000 of real discretionary spending moves the number.
  expect(s.available_cents).toBe(481000 - 35000);
  expect(s.available_cents).toBe(446000);
});

test("an uncategorized expense still reduces what is available", () => {
  const s = monthSummary(
    inputs({
      expenses: [expense({ txn_date: "2026-03-11", amount_cents: 9900, category_id: null })],
    }),
  );
  expect(s.available_cents).toBe(481000 - 9900);
});

test("expenses outside the month are ignored", () => {
  const s = monthSummary(
    inputs({ expenses: [expense({ txn_date: "2026-04-01", amount_cents: 99999, category_id: groceries.id })] }),
  );
  expect(s.spent.total).toBe(0);
  expect(s.available_cents).toBe(481000);
});

test("every paycheck knows what it is holding and what is left", () => {
  const s = monthSummary(inputs());
  const inMonth = s.paychecks.filter((p) => !p.prior_month);
  expect(inMonth.map((p) => p.date)).toEqual(["2026-03-05", "2026-03-15", "2026-03-31"]);

  // Rent is due the 1st with 3 days lead, so February's paycheck carries it.
  const carrier = s.paychecks.find((p) => p.prior_month)!;
  expect(carrier.date).toBe("2026-02-15");
  expect(carrier.holds.map((h) => h.name)).toEqual(["Rent"]);

  const mar15 = inMonth.find((p) => p.date === "2026-03-15")!;
  expect(mar15.holds.map((h) => h.name)).toEqual(["Car loan", "Internet"]);
  expect(mar15.hold_total_cents).toBe(50000);
  expect(mar15.lumpy_cents).toBe(3846);
  expect(mar15.savings_cents).toBe(34231);
  expect(mar15.free_cents).toBe(300000 - 50000 - 3846 - 34231);

  // The splits are exact, not approximately exact.
  expect(inMonth.reduce((a, p) => a + p.lumpy_cents, 0)).toBe(10000);
  expect(inMonth.reduce((a, p) => a + p.savings_cents, 0)).toBe(89000);
});

test("a period runs from one paycheck to the day before the next", () => {
  const s = monthSummary(inputs());
  expect(s.periods.map((p) => [p.start, p.end])).toEqual([
    ["2026-03-05", "2026-03-14"],
    ["2026-03-15", "2026-03-30"],
    ["2026-03-31", "2026-04-04"], // runs into April, up to the next rental payment
  ]);

  const [p1, p2, p3] = s.periods;
  expect(p1!.spent_discretionary_cents).toBe(25000); // groceries on the 10th
  expect(p2!.spent_discretionary_cents).toBe(10000); // groceries on the 20th
  expect(p3!.spent_discretionary_cents).toBe(0);
  expect(p1!.available_cents).toBe(p1!.planned_free_cents - 25000);
  // April's rent is due the 1st with three days' lead, so the 31st is too late and
  // the 15th sets it aside. Its period used to read that $1,500 as free money.
  expect(p2!.holds.map((h) => `${h.name} ${h.due_date}`)).toEqual([
    "Car loan 2026-03-16", "Internet 2026-03-20", "Rent 2026-04-01",
  ]);
  expect(p2!.fixed_cents).toBe(42000 + 8000 + 150000);
  // A month that pays its rent the way it is paid every month: last month's paycheck
  // held this month's, this month's holds next month's, and the periods sum to the month.
  expect(s.periods.reduce((a, p) => a + p.planned_free_cents, 0)).toBe(s.planned_free_cents);
  expect(s.periods_vs_month.held_last_month_cents).toBe(150000);
  expect(s.periods_vs_month.held_for_next_month_cents).toBe(150000);
});

test("the periods reconcile to the month to the cent", () => {
  // Spending before the first payday (the 3rd) and after month end (April 2nd):
  // the first is in the month and no period, the second in a period and not the month.
  const s = monthSummary(inputs({
    expenses: [
      expense({ txn_date: "2026-03-03", amount_cents: 7000, category_id: groceries.id }),
      expense({ txn_date: "2026-03-20", amount_cents: 10000, category_id: groceries.id }),
      expense({ txn_date: "2026-04-02", amount_cents: 4000, category_id: groceries.id }),
      expense({ txn_date: "2026-02-10", amount_cents: planFor("2026-02") + 30000, category_id: groceries.id }),
    ],
  }));
  const g = s.periods_vs_month;
  expect(s.carryover_cents).toBe(-30000);
  expect(g.spent_outside_periods_cents).toBe(7000 - 4000);
  expect(s.periods.at(-1)!.spent_discretionary_cents).toBe(4000);
  const periods = s.periods.reduce((a, p) => a + p.available_cents, 0);
  expect(periods).toBe(s.available_cents + g.held_last_month_cents + g.unfunded_cents
    - g.held_for_next_month_cents + g.spent_outside_periods_cents);
});

test("a month whose paychecks hold more of next month's bills than last month's held reads lower by period", () => {
  // Both incomes start in March, so no February paycheck held March's rent (it is
  // late, on the 5th's), while the 15th still sets April's aside.
  const streams = [stream({ ...dayJob, starts_on: "2026-03-01" }), stream({ ...rental, starts_on: "2026-03-01" })];
  const s = monthSummary(inputs({ streams }));
  expect(s.periods_vs_month.held_last_month_cents).toBe(0);
  expect(s.periods_vs_month.held_for_next_month_cents).toBe(150000);
  const periods = s.periods.reduce((a, p) => a + p.available_cents, 0);
  expect(periods).toBe(s.available_cents - s.periods_vs_month.held_for_next_month_cents
    + s.periods_vs_month.spent_outside_periods_cents);
});

test("a month with no paychecks owes no reconciliation", () => {
  const s = monthSummary(inputs({ streams: [] }));
  expect(s.periods).toHaveLength(0);
  expect(s.periods_vs_month).toEqual({
    held_last_month_cents: 0, held_for_next_month_cents: 0, unfunded_cents: 0, spent_outside_periods_cents: 0,
  });
});

test("a 3-paycheck month shows up as surplus over the normalized average", () => {
  const biweekly = stream({ name: "Job", frequency: "biweekly", anchor_date: "2026-01-02", amount_cents: 200000 });
  const s = monthSummary(inputs({ streams: [biweekly], month: "2026-01", expenses: [], savingsGoals: [] }));
  expect(s.income_cents).toBe(600000);
  expect(s.income_normalized_cents).toBe(433333);
  expect(s.surplus_cents).toBe(166667);
  expect(s.extra_paycheck).toBe(true);
  expect(s.periods).toHaveLength(3);
});

test("catch-up mode raises the lumpy contribution when a bill is close", () => {
  const soon = lumpy({ amount_cents: 120000, frequency_months: 12, next_due_date: "2026-06-01" });
  const recommended = monthSummary(inputs({ lumpyItems: [soon] }));
  const steady = monthSummary(inputs({ lumpyItems: [soon], lumpyMode: "steady" }));
  // 120000 over this month and the three before it comes due: four contributions.
  expect(recommended.lumpy_cents).toBe(30000);
  expect(steady.lumpy_cents).toBe(10000);
  expect(recommended.lumpy_steady_cents).toBe(10000);
  expect(recommended.available_cents).toBe(steady.available_cents - 20000);
});

test("bills nobody can pay are reported, not swallowed", () => {
  const s = monthSummary(inputs({ streams: [] }));
  expect(s.income_cents).toBe(0);
  expect(s.unfunded.map((u) => u.name)).toEqual(["Rent", "Car loan", "Internet"]);
  expect(s.periods).toEqual([]);
  // No income: 200000 of bills, 10000 lumpy, 50000 fixed savings (the 5% goal is 5% of nothing),
  // then 35000 already spent.
  expect(s.available_cents).toBe(-295000);
});

// ------------------------------------------------------------------- pace

test("pace: four days into a fourteen-day period, spending faster than the days pass", () => {
  const period = {
    start: "2026-03-01",
    end: "2026-03-14",
    planned_free_cents: 140000,
    spent_discretionary_cents: 80000,
  };
  const p = periodPace(period, "2026-03-04")!;
  expect(p.day).toBe(4);
  expect(p.days).toBe(14);
  expect(p.days_left).toBe(11);
  expect(p.on_track_cents).toBe(40000); // 4/14 of the plan
  expect(p.delta_cents).toBe(40000);
  expect(p.status).toBe("over");
  // 60000 left over the 11 days that are still coming.
  expect(p.daily_left_cents).toBe(5455);
});

test("pace: on payday you are one day in, not zero", () => {
  const p = periodPace(
    { start: "2026-03-01", end: "2026-03-14", planned_free_cents: 140000, spent_discretionary_cents: 0 },
    "2026-03-01",
  )!;
  expect(p.day).toBe(1);
  expect(p.days_left).toBe(14);
  expect(p.status).toBe("under");
});

test("pace: the last day of the period is still inside it", () => {
  const p = periodPace(
    { start: "2026-03-01", end: "2026-03-14", planned_free_cents: 140000, spent_discretionary_cents: 139000 },
    "2026-03-14",
  )!;
  expect(p.day).toBe(14);
  expect(p.days_left).toBe(1);
  expect(p.status).toBe("on_track");
});

test("pace: a small difference early is noise, not a warning", () => {
  const p = periodPace(
    { start: "2026-03-01", end: "2026-03-14", planned_free_cents: 140000, spent_discretionary_cents: 11000 },
    "2026-03-01",
  )!;
  // 1000 over an even burn, against a 7000 tolerance.
  expect(p.delta_cents).toBe(1000);
  expect(p.status).toBe("on_track");
});

test("pace: outside the period there is no pace to report", () => {
  const period = { start: "2026-03-01", end: "2026-03-14", planned_free_cents: 1, spent_discretionary_cents: 0 };
  expect(periodPace(period, "2026-02-28")).toBeNull();
  expect(periodPace(period, "2026-03-15")).toBeNull();
});

test("pace: a period with nothing planned is either untouched or blown", () => {
  const dry = { start: "2026-03-01", end: "2026-03-14", planned_free_cents: 0, spent_discretionary_cents: 0 };
  expect(periodPace(dry, "2026-03-05")!.spent_share).toBe(0);
  expect(periodPace({ ...dry, spent_discretionary_cents: 500 }, "2026-03-05")!.spent_share).toBe(1);
});

test("the current period is the one today falls in", () => {
  const s = monthSummary(inputs());
  const first = s.periods[0]!;
  expect(currentPeriod(s.periods, first.start)!.start).toBe(first.start);
  expect(currentPeriod(s.periods, "2020-01-01")).toBeNull();
  // Every period the month reports is covered, so "today" always finds one.
  for (const p of s.periods) expect(currentPeriod(s.periods, p.start)!.start).toBe(p.start);
});

// --- Carrying last month's overspend, one month and no further ---

const planFor = (month: string) => monthSummary(inputs({ month, expenses: [] })).planned_free_cents;
/** A discretionary charge that lands `month`'s own result at exactly `result` cents. */
const landAt = (month: string, result: number) =>
  expense({ txn_date: `${month}-12`, amount_cents: planFor(month) - result, category_id: groceries.id });

test("last month's overspend is carried into this month", () => {
  const base = monthSummary(inputs());
  const s = monthSummary(inputs({ expenses: [...inputs().expenses, landAt("2026-02", -200000)] }));
  expect(s.carryover_cents).toBe(-200000);
  expect(s.carryover_from).toBe("2026-02");
  expect(s.available_cents).toBe(base.available_cents - 200000);
  expect(s.available_cents).toBe(s.planned_free_cents + s.carryover_cents - s.spent.discretionary);
});

test("a month that came in under plan carries nothing, and not -0", () => {
  const s = monthSummary(inputs({ expenses: [...inputs().expenses, landAt("2026-02", 50000)] }));
  expect(s.carryover_cents).toBe(0);
  expect(Object.is(s.carryover_cents, 0)).toBe(true);
});

test("a month that landed on exactly zero carries a real zero", () => {
  const s = monthSummary(inputs({ expenses: [landAt("2026-02", 0)] }));
  expect(Object.is(s.carryover_cents, 0)).toBe(true);
});

test("an overspend two months back does not reach this month", () => {
  const s = monthSummary(inputs({
    expenses: [...inputs().expenses, landAt("2026-01", -300000), landAt("2026-02", 50000)],
  }));
  expect(s.carryover_cents).toBe(0);
});

test("the carry is last month's own result, not what it inherited", () => {
  // January -3000, February -500 on its own (and -3500 with January's carry).
  const expenses = [...inputs().expenses, landAt("2026-01", -300000), landAt("2026-02", -50000)];
  expect(monthSummary(inputs({ month: "2026-02", expenses })).available_cents).toBe(-350000);
  expect(monthSummary(inputs({ expenses })).carryover_cents).toBe(-50000);
});

test("a previous month with no transactions was never imported and carries nothing", () => {
  // The job starts in March, so February's plan is the bills with no paycheck: deeply negative,
  // but nothing was ever imported against it. Every expense in `inputs()` is in March.
  const streams = [stream({ ...dayJob, starts_on: "2026-03-01" })];
  expect(monthSummary(inputs({ month: "2026-02", streams })).available_cents).toBeLessThan(0);
  expect(monthSummary(inputs({ streams })).carryover_cents).toBe(0);
});

test("the first paycheck period takes the carry and the periods still add up", () => {
  const base = monthSummary(inputs());
  const s = monthSummary(inputs({ expenses: [...inputs().expenses, landAt("2026-02", -200000)] }));
  expect(s.periods.map((p) => p.carryover_cents)).toEqual([-200000, 0, 0]);
  expect(s.periods[0]!.available_cents).toBe(base.periods[0]!.available_cents - 200000);
  expect(s.periods.slice(1).map((p) => p.available_cents)).toEqual(base.periods.slice(1).map((p) => p.available_cents));
  for (const p of s.periods) expect(p.available_cents).toBe(p.planned_free_cents + p.carryover_cents - p.spent_discretionary_cents);
});

test("pace counts the carry as money the period no longer has", () => {
  const period = { start: "2026-03-01", end: "2026-03-10", planned_free_cents: 100000, spent_discretionary_cents: 0 };
  const plain = periodPace(period, "2026-03-01")!;
  const carried = periodPace({ ...period, carryover_cents: -50000 }, "2026-03-01")!;
  expect(plain.daily_left_cents).toBe(10000);
  expect(carried.daily_left_cents).toBe(5000);
  expect(carried.on_track_cents).toBe(5000);
});
