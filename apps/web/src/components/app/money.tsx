import CountUp from "@/components/CountUp";
import { cn } from "@/lib/utils";
import { money } from "@/lib/format";

/**
 * Whole dollars, counted up. Tiles round to the dollar on purpose: the cents are
 * in the tables, and an animated cents digit is noise, not information.
 * The sign is rendered as text so a negative never reads as "$-1,234".
 */
export function AnimatedMoney({ cents, className }: { cents: number; className?: string }) {
  const dollars = Math.round(Math.abs(cents) / 100);
  return (
    <span className={cn("tabular", className)}>
      {cents < 0 ? "-$" : "$"}
      <CountUp to={dollars} separator="," />
    </span>
  );
}

/** Exact money, no animation. Used everywhere a number sits in a column. */
export function Money({
  cents,
  className,
  sign,
  tone,
}: {
  cents: number;
  className?: string;
  sign?: boolean;
  tone?: boolean;
}) {
  return (
    <span
      className={cn(
        "tabular",
        tone && cents < 0 && "text-[var(--critical)]",
        tone && cents > 0 && "text-[var(--good)]",
        className,
      )}
    >
      {money(cents, { sign })}
    </span>
  );
}
