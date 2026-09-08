#!/usr/bin/env bun
/**
 * Whole-household scenarios, run end to end through the engine and compared to
 * a stored expectation. The unit tests prove each function; these prove the
 * functions still agree with each other, which is where regressions actually hide.
 *
 * Run:    bun run scenarios
 * Accept: bun run scenarios --update   (only after reading the diff)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "./src/index";

const dir = join(import.meta.dir, "fixtures", "households");

type Household = {
  name: string;
  month: string;
  year: number;
  lumpyMode: "steady" | "recommended";
  openingBalance: number;
} & Omit<core.BudgetInputs, "month" | "lumpyMode">;

export function run(h: Household) {
  const summary = core.monthSummary({
    ...h,
    month: h.month,
    lumpyMode: h.lumpyMode,
    lumpyOpeningBalanceCents: h.openingBalance,
  });
  const t = core.timeline(h.lumpyItems, h.month, 12, h.openingBalance, h.lumpyMode);
  // A fixed "today" inside the month: pace, cash position and the recurring
  // detector all read a clock, and a scenario that reads the real one is a
  // scenario that fails on the 11th.
  const today = core.addDays(core.monthStart(h.month), 9);
  const f = core.forecast({
    streams: h.streams,
    fixedCosts: h.fixedCosts,
    lumpyItems: h.lumpyItems,
    savingsGoals: h.savingsGoals,
    start: h.month,
    months: 12,
    lumpyMode: h.lumpyMode,
    lumpyOpeningBalanceCents: h.openingBalance,
  });
  return {
    name: h.name,
    month: h.month,
    money: {
      income_cents: summary.income_cents,
      income_normalized_cents: summary.income_normalized_cents,
      surplus_cents: summary.surplus_cents,
      extra_paycheck: summary.extra_paycheck,
      fixed_cents: summary.fixed_cents,
      lumpy_cents: summary.lumpy_cents,
      lumpy_steady_cents: summary.lumpy_steady_cents,
      savings_cents: summary.savings_cents,
      planned_free_cents: summary.planned_free_cents,
      spent: summary.spent,
      available_cents: summary.available_cents,
    },
    paychecks: summary.paychecks.map((p) => ({
      date: p.date,
      stream: p.stream_name,
      prior_month: p.prior_month,
      amount_cents: p.amount_cents,
      holds: p.holds.map((x) => `${x.name} ${x.amount_cents}${x.late ? " LATE" : ""}`),
      hold_total_cents: p.hold_total_cents,
      lumpy_cents: p.lumpy_cents,
      savings_cents: p.savings_cents,
      free_cents: p.free_cents,
      over_committed: p.over_committed,
    })),
    periods: summary.periods.map((p) => ({
      window: `${p.start}..${p.end}`,
      income_cents: p.income_cents,
      planned_free_cents: p.planned_free_cents,
      spent_discretionary_cents: p.spent_discretionary_cents,
      available_cents: p.available_cents,
    })),
    unfunded: summary.unfunded,
    savings_goals: core.goalProgress(h.savingsGoals, summary.income_cents).map((p) => ({
      name: p.goal.name,
      balance_cents: p.balance_cents,
      target_cents: p.target_cents,
      monthly_cents: p.monthly_cents,
      pct: p.pct === null ? null : Math.round(p.pct * 10) / 10,
      remaining_cents: p.remaining_cents,
      months_to_target: p.months_to_target,
      funded: p.funded,
    })),
    lumpy: {
      monthly_contribution_cents: t.monthly_contribution_cents,
      total_outflow_cents: t.total_outflow_cents,
      worst_balance_cents: t.worst_balance_cents,
      first_short_month: t.first_short_month,
      rows: t.rows.map((r) => ({
        month: r.month,
        start: r.balance_start_cents,
        in: r.contribution_cents,
        out: r.outflow_cents,
        end: r.balance_end_cents,
        due: r.due.map((d) => d.name),
        short: r.short,
      })),
    },
    income_calendar: core.incomeCalendar(h.streams, h.year).map((m) => ({
      month: m.month,
      total_cents: m.total_cents,
      extra_paycheck: m.extra_paycheck,
    })),
    forecast: {
      total_free_cents: f.total_free_cents,
      average_free_cents: f.average_free_cents,
      tightest_month: f.tightest_month,
      first_tight_month: f.first_tight_month,
      first_short_month: f.first_short_month,
      rows: f.rows.map((r) => ({
        month: r.month,
        income_cents: r.income_cents,
        free: r.planned_free_cents,
        lumpy_due_cents: r.lumpy_due_cents,
        tight: r.tight,
      })),
    },
    pace: summary.periods.map((p) => {
      const pace = core.periodPace(p, today);
      return pace === null
        ? { window: `${p.start}..${p.end}`, pace: null }
        : {
            window: `${p.start}..${p.end}`,
            day: `${pace.day}/${pace.days}`,
            on_track_cents: pace.on_track_cents,
            delta_cents: pace.delta_cents,
            daily_left_cents: pace.daily_left_cents,
            status: pace.status,
          };
    }),
    cash: (() => {
      const c = core.cashPosition({
        paychecks: summary.paychecks,
        today,
        // A round balance rather than a stored one: the scenario is pinning the
        // arithmetic between the balance and the bills, not a household's cash.
        balanceCents: 250000,
        asOf: core.monthStart(h.month),
      });
      return {
        next_paycheck_date: c.next_paycheck_date,
        due: c.due.map((x) => `${x.name} ${x.amount_cents} due ${x.due_date}`),
        due_before_next_paycheck_cents: c.due_before_next_paycheck_cents,
        projected_cents: c.projected_cents,
        short: c.short,
      };
    })(),
    recurring: core
      .recurringCandidates(h.expenses, {
        today,
        categories: h.categories,
        lumpyItems: h.lumpyItems,
        fixedCosts: h.fixedCosts,
      })
      .map((c) => `${c.key} every ${c.frequency_months}mo ${c.amount_cents} next ${c.next_due_date}`),
    // Lumpy bills the statements already show as paid, and what recording one
    // would do: the schedule heals itself and the balance never does.
    lumpy_paid: core
      .lumpyPayments(h.lumpyItems, h.expenses, { today })
      .map(
        (p) =>
          `${p.item.name} due ${p.due_date} paid ${p.expense.txn_date} ${p.expense.amount_cents}` +
          ` (${p.days_off > 0 ? "+" : ""}${p.days_off}d, ${p.delta_cents >= 0 ? "+" : ""}${p.delta_cents})` +
          ` rolls to ${p.rolls_to}`,
      ),
    // Every discretionary category against the same stretch of earlier months.
    category_pace: (() => {
      const pace = core.categoryPace(h.expenses, h.categories, { today });
      return {
        through_day: pace.through_day,
        months_compared: pace.months_compared,
        rows: pace.rows.map(
          (r) => `${r.name} ${r.month_to_date_cents} vs ${r.typical_cents} (${r.delta_cents >= 0 ? "+" : ""}${r.delta_cents})`,
        ),
      };
    })(),
    // A month's paychecks must add up to the month's income, always.
    invariants: checkInvariants(summary, f),
  };
}

function checkInvariants(s: core.MonthSummary, f: core.Forecast): string[] {
  const problems: string[] = [];
  // The forecast is the month summary run forward, so its first row has to be
  // the month summary. Two ways to compute one number is one way to drift.
  const first = f.rows[0];
  if (first) {
    if (first.month !== s.month) problems.push(`forecast starts at ${first.month}, summary is ${s.month}`);
    if (first.income_cents !== s.income_cents)
      problems.push(`forecast income ${first.income_cents} != summary ${s.income_cents}`);
    if (first.lumpy_cents !== s.lumpy_cents)
      problems.push(`forecast lumpy ${first.lumpy_cents} != summary ${s.lumpy_cents}`);
    if (first.planned_free_cents !== s.planned_free_cents)
      problems.push(`forecast free ${first.planned_free_cents} != summary ${s.planned_free_cents}`);
  }
  const inMonth = s.paychecks.filter((p) => !p.prior_month);
  const paycheckSum = inMonth.reduce((a, p) => a + p.amount_cents, 0);
  if (paycheckSum !== s.income_cents)
    problems.push(`paychecks ${paycheckSum} != income ${s.income_cents}`);
  const lumpySplit = inMonth.reduce((a, p) => a + p.lumpy_cents, 0);
  if (inMonth.length > 0 && lumpySplit !== s.lumpy_cents)
    problems.push(`lumpy split ${lumpySplit} != ${s.lumpy_cents}`);
  const savingsSplit = inMonth.reduce((a, p) => a + p.savings_cents, 0);
  if (inMonth.length > 0 && savingsSplit !== s.savings_cents)
    problems.push(`savings split ${savingsSplit} != ${s.savings_cents}`);
  const heldOnce = new Set(s.paychecks.flatMap((p) => p.holds.map((h) => h.fixed_cost_id)));
  const total = heldOnce.size + s.unfunded.length;
  if (total !== new Set(s.paychecks.flatMap((p) => p.holds.map((h) => h.fixed_cost_id))).size + s.unfunded.length)
    problems.push("a bill was assigned more than once");
  for (const p of s.periods) {
    const expected = p.planned_free_cents - p.spent_discretionary_cents;
    if (p.available_cents !== expected) problems.push(`period ${p.start} available is inconsistent`);
  }
  return problems;
}

const update = process.argv.includes("--update");
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".expected.json")).sort();
let failures = 0;

for (const file of files) {
  const household = JSON.parse(readFileSync(join(dir, file), "utf8")) as Household;
  const actual = run(household);
  const expectedPath = join(dir, file.replace(/\.json$/, ".expected.json"));

  if (actual.invariants.length > 0) {
    failures++;
    console.log(`FAIL ${file}: invariants broken`);
    for (const p of actual.invariants) console.log(`     ${p}`);
    continue;
  }

  let expected: unknown = null;
  try {
    expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  } catch {
    if (!update) {
      failures++;
      console.log(`FAIL ${file}: no expectation yet, run with --update`);
      continue;
    }
  }

  const actualText = JSON.stringify(actual, null, 2);
  if (update) {
    writeFileSync(expectedPath, `${actualText}\n`);
    console.log(`WROTE ${file}`);
    continue;
  }
  if (actualText !== JSON.stringify(expected, null, 2)) {
    failures++;
    console.log(`FAIL ${file}: output changed`);
    for (const line of diff(JSON.stringify(expected, null, 2), actualText)) console.log(`     ${line}`);
    continue;
  }
  console.log(`ok   ${file}  (${household.name})`);
}

function diff(a: string, b: string): string[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(A.length, B.length) && out.length < 40; i++) {
    if (A[i] !== B[i]) out.push(`- ${A[i] ?? ""}\n     + ${B[i] ?? ""}`);
  }
  return out;
}

if (failures > 0) {
  console.log(`\n${failures} scenario(s) failed`);
  process.exit(1);
}
console.log(`\n${files.length} scenario(s) ok`);
