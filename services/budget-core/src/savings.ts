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
