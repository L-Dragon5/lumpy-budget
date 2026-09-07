import type { ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { monthLabel, shiftMonth } from "@/lib/format";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function MonthNav({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-md border p-1">
      <Button variant="ghost" size="icon" onClick={() => onChange(shiftMonth(month, -1))} aria-label="Previous month">
        <ChevronLeftIcon />
      </Button>
      <span className="min-w-36 text-center text-sm font-medium">{monthLabel(month)}</span>
      <Button variant="ghost" size="icon" onClick={() => onChange(shiftMonth(month, 1))} aria-label="Next month">
        <ChevronRightIcon />
      </Button>
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

export function LoadError({ error }: { error: unknown }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Could not load</AlertTitle>
      <AlertDescription>
        {error instanceof Error ? error.message : "Unknown error"}. Start the API with bun run api, then reload this page.
      </AlertDescription>
    </Alert>
  );
}
