import type { ReactNode } from "react";
import SpotlightCard from "@/components/SpotlightCard";
import { cn } from "@/lib/utils";
import { AnimatedMoney } from "./money";

/**
 * A stat tile, not a chart: one number that is the answer, with the arithmetic
 * behind it as the caption. `emphasis` is for the number the page exists to show.
 */
export function StatTile({
  label,
  cents,
  caption,
  tone = "neutral",
  emphasis = false,
  children,
}: {
  label: string;
  cents: number;
  caption?: ReactNode;
  tone?: "neutral" | "good" | "critical" | "muted";
  emphasis?: boolean;
  children?: ReactNode;
}) {
  return (
    <SpotlightCard
      className={cn(
        "flex flex-col gap-1 rounded-xl border bg-card p-4 text-card-foreground",
        emphasis && "sm:col-span-2",
      )}
      spotlightColor="rgba(120, 160, 255, 0.12)"
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <AnimatedMoney
        cents={cents}
        className={cn(
          "font-semibold",
          emphasis ? "text-4xl" : "text-2xl",
          tone === "good" && "text-[var(--good)]",
          tone === "critical" && "text-[var(--critical)]",
          tone === "muted" && "text-muted-foreground",
        )}
      />
      {caption ? <div className="text-xs text-muted-foreground">{caption}</div> : null}
      {children}
    </SpotlightCard>
  );
}
