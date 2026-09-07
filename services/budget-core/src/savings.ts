import type { SavingsGoal } from "@lumpy/contracts";
import { divRound, sum, type Cents } from "./money";

export type GoalAmount = { goal: SavingsGoal; amount_cents: Cents };

/** Percent goals resolve against that month's actual income, not an average. */
export function monthlySavings(goals: SavingsGoal[], monthIncomeCents: Cents): GoalAmount[] {
  return goals
    .filter((g) => g.active)
    .map((g) => ({
      goal: g,
      amount_cents:
        g.mode === "fixed"
          ? (g.amount_cents ?? 0)
          : divRound(monthIncomeCents * Math.round((g.percent ?? 0) * 100), 10000),
    }));
}

export const savingsMonthlyTotal = (goals: SavingsGoal[], monthIncomeCents: Cents): Cents =>
  sum(monthlySavings(goals, monthIncomeCents).map((x) => x.amount_cents));

export type GoalProgress = {
  goal: SavingsGoal;
  balance_cents: Cents;
  target_cents: Cents | null;
  monthly_cents: Cents;
  /** Percent of the target held, uncapped: 120 means the goal is overfunded. Null with no target. */
  pct: number | null;
  /** What is still missing. 0 once the target is met, and 0 when there is no target. */
  remaining_cents: Cents;
  /** Months until the target is met at the current rate. Null if there is no target,
   *  0 if already met, and null if nothing is being contributed. */
  months_to_target: number | null;
  funded: boolean;
};

/**
 * Each goal is its own bucket. A target is optional: an open-ended fund still has
 * a balance worth tracking, it just has no finish line to measure against.
 */
export function goalProgress(goals: SavingsGoal[], monthIncomeCents: Cents): GoalProgress[] {
  const monthly = new Map(monthlySavings(goals, monthIncomeCents).map((x) => [x.goal.id, x.amount_cents]));
  return goals
    .filter((g) => g.active)
    .map((goal) => {
      const balance = goal.balance_cents ?? 0;
      const target = goal.target_cents ?? null;
      const perMonth = monthly.get(goal.id) ?? 0;
      const remaining = target === null ? 0 : Math.max(0, target - balance);
      return {
        goal,
        balance_cents: balance,
        target_cents: target,
        monthly_cents: perMonth,
        pct: target === null || target === 0 ? null : (balance / target) * 100,
        remaining_cents: remaining,
        months_to_target:
          target === null ? null : remaining === 0 ? 0 : perMonth > 0 ? Math.ceil(remaining / perMonth) : null,
        funded: target !== null && balance >= target,
      };
    });
}

/** Everything held across every bucket, active or not: it is all still your money. */
export const savingsBalanceTotal = (goals: SavingsGoal[]): Cents =>
  sum(goals.map((g) => g.balance_cents ?? 0));
