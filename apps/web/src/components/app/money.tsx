import { cn } from "@/lib/utils";
import { money } from "@/lib/format";

/**
 * Whole dollars. Tiles round to the dollar on purpose: the cents are in the
 * tables, and a cents digit on a headline number is noise, not information.
 */
export function WholeDollars({ cents, className }: { cents: number; className?: string }) {
  return <span className={cn("tabular", className)}>{money(cents, { cents: false })}</span>;
}

/** Exact money, cents and all. Used everywhere a number sits in a column. */
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
