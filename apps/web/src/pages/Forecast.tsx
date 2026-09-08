import { useState } from "react";
import { Link } from "react-router";
import { AlertTriangleIcon, SparklesIcon } from "lucide-react";
import { monthsThatCanAfford, monthsToAfford } from "@lumpy/budget-core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/app/money";
import { StatTile } from "@/components/app/stat-tile";
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { eden, useApi } from "@/lib/api";
import { money, monthLabel, thisMonth, toCents } from "@/lib/format";

/**
 * The month summary, run forward.
 *
 * Deliberately plan-only: a month that has not happened has no transactions in
 * it, so every number here is what is *scheduled* to be free once the bills, the
 * lumpy fund and the savings goals have taken their share. What you then spend
 * out of it is the one part nobody can project, and a page that guessed at it
 * would make the honest columns look like the guessed one.
 */
export default function Forecast() {
  const start = thisMonth();
  const [cost, setCost] = useState("");
  const forecast = useApi(["forecast", start], () =>
    eden.api.forecast.get({ query: { start, months: 12 } }));

  if (forecast.isLoading) return <Loading rows={4} />;
  if (forecast.error) return <LoadError error={forecast.error} />;
  const f = forecast.data!;

  const rows = f.rows;
  const nothingSetUp = rows.every((r) => r.income_cents === 0 && r.fixed_cents === 0);
  const wanted = toCents(cost);
  // The engine answers both halves of "can I afford it": out of one month, and
  // by saving up. See budget-core/forecast.ts.
  const affordable = wanted === null ? [] : monthsThatCanAfford(f, wanted);
  const saveUp = wanted === null ? null : monthsToAfford(f, wanted);
  const best = rows.reduce((a, b) => (b.planned_free_cents > a.planned_free_cents ? b : a), rows[0]!);
  const widest = Math.max(1, ...rows.map((r) => Math.abs(r.planned_free_cents)));

  return (
    <>
      <PageHeader
        title="The next 12 months"
        description="What each month is scheduled to leave free, once the bills, the lumpy fund and the savings goals have taken their share. Planned, not spent: a month that has not happened has no transactions in it."
      />

      {nothingSetUp ? (
        <Empty className="mb-6">
          <EmptyHeader>
            <EmptyTitle>Nothing to forecast yet</EmptyTitle>
            <EmptyDescription>
              Add <Link className="underline" to="/income">income</Link> and{" "}
              <Link className="underline" to="/fixed-costs">fixed costs</Link> and every month between here and
              next year works itself out.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Free over 12 months"
          cents={f.total_free_cents}
          caption={`${money(f.average_free_cents)} in an average month.`}
        />
        <StatTile
          label="Leanest month"
          cents={rows.find((r) => r.month === f.tightest_month)?.planned_free_cents ?? 0}
          tone={f.first_tight_month ? "critical" : "muted"}
          caption={f.tightest_month ? monthLabel(f.tightest_month) : "No months yet."}
        />
        <StatTile
          label="Roomiest month"
          cents={best?.planned_free_cents ?? 0}
          tone="good"
          caption={
            best?.extra_paycheck
              ? `${monthLabel(best.month)}, an extra-paycheck month.`
              : best
                ? monthLabel(best.month)
                : "No months yet."
          }
        />
        <Card className="justify-center">
          <CardContent>
            <Field>
              <FieldLabel htmlFor="fc-cost">Can I afford</FieldLabel>
              <Input
                id="fc-cost"
                inputMode="decimal"
                placeholder="1,800.00"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
              <FieldDescription>
                {wanted === null ? (
                  "A one-off cost, out of one month's free cash."
                ) : affordable.length > 0 ? (
                  <>
                    Yes, out of {monthLabel(affordable[0]!)}
                    {affordable.length > 1
                      ? ` and ${affordable.length - 1} other ${affordable.length === 2 ? "month" : "months"}`
                      : null}
                    .
                  </>
                ) : saveUp === null ? (
                  "Not out of these twelve months, even saving every spare penny."
                ) : (
                  <>Not out of one month, but {saveUp} months of free cash covers it.</>
                )}
              </FieldDescription>
            </Field>
          </CardContent>
        </Card>
      </div>

      {f.first_tight_month ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangleIcon />
          <AlertTitle>The plan stops balancing in {monthLabel(f.first_tight_month)}</AlertTitle>
          <AlertDescription>
            The bills, the lumpy fund and the savings goals add up to more than that month brings in. Something
            has to move: a goal, a bill, or the fund's catch-up.
          </AlertDescription>
        </Alert>
      ) : null}

      {f.first_short_month ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangleIcon />
          <AlertTitle>The lumpy fund runs short in {monthLabel(f.first_short_month)}</AlertTitle>
          <AlertDescription>
            Saving at this month's rate does not get the fund to what comes due.{" "}
            <Link className="underline" to="/lumpy/timeline">See the timeline</Link>.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Month by month</CardTitle>
          <CardDescription>
            Income, less the bills, less what the lumpy fund and savings take. What leaves the fund is shown
            beside it because it leaves the fund, not this month's free cash: that is what saving for it every
            month bought you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Income</TableHead>
                <TableHead className="text-right">Bills</TableHead>
                <TableHead className="text-right">Lumpy</TableHead>
                <TableHead className="text-right">Savings</TableHead>
                <TableHead className="text-right">Free</TableHead>
                <TableHead className="w-1/4">Out of the fund</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.month} className={r.tight ? "bg-destructive/5" : ""}>
                  <TableCell className="font-medium">
                    {monthLabel(r.month)}
                    {r.extra_paycheck ? (
                      <Badge variant="secondary" className="ml-2">
                        <SparklesIcon />
                        extra paycheck
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={r.income_cents} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <Money cents={r.fixed_cents} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <Money cents={r.lumpy_cents} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <Money cents={r.savings_cents} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={r.planned_free_cents} tone className="font-medium" />
                    {/* A bar rather than a chart: one number per row, scaled against
                        the widest month, which is all a twelve-row table can show
                        without a legend nobody reads. */}
                    <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted">
                      <div
                        className={`h-full ${r.planned_free_cents < 0 ? "bg-[var(--critical)]" : "bg-[var(--good)]"}`}
                        style={{ width: `${(Math.abs(r.planned_free_cents) / widest) * 100}%` }}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.lumpy_due.length === 0 ? (
                      <span className="text-xs">nothing due</span>
                    ) : (
                      <>
                        <Money cents={r.lumpy_due_cents} />
                        <span className="ml-1 text-xs">{r.lumpy_due.map((x) => x.name).join(", ")}</span>
                        {r.lumpy_short ? (
                          <Badge variant="destructive" className="ml-2">
                            fund short
                          </Badge>
                        ) : null}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
