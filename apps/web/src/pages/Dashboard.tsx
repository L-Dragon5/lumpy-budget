import { useState } from "react";
import { Link } from "react-router";
import { AlertTriangleIcon, SparklesIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SingleToggle } from "@/components/app/controls";
import { Money } from "@/components/app/money";
import { StatTile } from "@/components/app/stat-tile";
import { Loading, LoadError, MonthNav, PageHeader } from "@/components/app/page";
import AnimatedContent from "@/components/AnimatedContent";
import { eden, useApi } from "@/lib/api";
import { dateLabel, dateLabelFull, money, monthLabel, thisMonth } from "@/lib/format";


export default function Dashboard() {
  const [month, setMonth] = useState(thisMonth());
  const [view, setView] = useState<"month" | "period">("month");
  const summary = useApi(["summary", month], () => eden.api.summary.get({ query: { month } }));
  const timeline = useApi(["lumpy-timeline", month], () =>
    eden.api["lumpy-timeline"].get({ query: { start: month, months: 12 } }));

  if (summary.isLoading) return <Loading rows={4} />;
  if (summary.error) return <LoadError error={summary.error} />;
  const s = summary.data!;

  const nothingSetUp = s.income_cents === 0 && s.fixed_cents === 0 && s.lumpy_cents === 0;
  const overBudget = s.available_cents < 0;
  const spentShare = s.planned_free_cents > 0
    ? Math.min(100, (s.spent.discretionary / s.planned_free_cents) * 100)
    : 100;
  const upcoming = (timeline.data?.rows ?? []).flatMap((r) => r.due).slice(0, 4);

  return (
    <>
      <PageHeader
        title={monthLabel(month)}
        description="What is left after the bills, the lumpy fund and savings have all been taken out."
        actions={
          <>
            <SingleToggle<"month" | "period">
              value={view}
              onChange={setView}
              options={[
                { value: "month" as const, label: "Whole month" },
                { value: "period" as const, label: "By paycheck" },
              ]}
            />
            <MonthNav month={month} onChange={setMonth} />
          </>
        }
      />

      {nothingSetUp ? (
        <Empty className="mb-6">
          <EmptyHeader>
            <EmptyTitle>Nothing set up yet</EmptyTitle>
            <EmptyDescription>
              Start with <Link className="underline" to="/income">income</Link>, then{" "}
              <Link className="underline" to="/fixed-costs">fixed costs</Link>, then the{" "}
              <Link className="underline" to="/lumpy">lumpy fund</Link>. The dashboard fills itself in from there.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {s.unfunded.length > 0 ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangleIcon />
          <AlertTitle>{s.unfunded.length} bill(s) have no paycheck to come out of</AlertTitle>
          <AlertDescription>{s.unfunded.map((u) => u.name).join(", ")}</AlertDescription>
        </Alert>
      ) : null}

      {s.extra_paycheck ? (
        <Alert className="mb-4">
          <SparklesIcon />
          <AlertTitle>Extra paycheck month</AlertTitle>
          <AlertDescription>
            {monthLabel(month)} pays {money(s.surplus_cents)} more than an average month. That surplus is the
            cleanest money there is to send at the lumpy fund or savings.
          </AlertDescription>
        </Alert>
      ) : null}

      <AnimatedContent distance={24} duration={0.5}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Available to spend"
            cents={s.available_cents}
            emphasis
            tone={s.available_cents < 0 ? "critical" : "good"}
            caption={
              <>
                {money(s.planned_free_cents)} planned, {money(s.spent.discretionary)} spent.
                {s.spent.fixed + s.spent.lumpy + s.spent.savings > 0 ? (
                  <>
                    {" "}
                    Bills and transfers already counted in the plan are not subtracted twice.
                  </>
                ) : null}
              </>
            }
          >
            <Progress
              value={spentShare}
              className="mt-2"
              // The bar is the share of the month's free cash already spent, so it
              // has to turn when it runs past the end rather than just filling up.
              style={{ ["--progress-color" as string]: overBudget ? "var(--critical)" : "var(--good)" }}
            />
            <span className="text-xs text-muted-foreground">
              {overBudget
                ? `${money(-s.available_cents)} past the plan`
                : `${Math.round(100 - spentShare)}% of the plan still unspent`}
            </span>
          </StatTile>

          <StatTile
            label="Income"
            cents={s.income_cents}
            caption={
              s.surplus_cents === 0
                ? "Exactly an average month."
                : `${money(s.surplus_cents, { sign: true })} against the ${money(s.income_normalized_cents)} average`
            }
          />
          <StatTile label="Fixed costs" cents={s.fixed_cents} tone="muted" caption="Bills due this month." />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Lumpy fund"
            cents={s.lumpy_cents}
            tone="muted"
            caption={
              s.lumpy_cents > s.lumpy_steady_cents
                ? `Includes catch-up; steady state is ${money(s.lumpy_steady_cents)}.`
                : "On schedule."
            }
          />
          <StatTile label="Savings" cents={s.savings_cents} tone="muted" caption={s.savings_breakdown.map((g) => g.name).join(", ") || "No goals yet"} />
          <StatTile label="Spent so far" cents={s.spent.discretionary} tone="muted" caption={`${money(s.spent.total)} across every category`} />
          <StatTile label="Planned free cash" cents={s.planned_free_cents} tone={s.planned_free_cents < 0 ? "critical" : "neutral"} caption="Before any spending." />
        </div>
      </AnimatedContent>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{view === "month" ? "Where the month goes" : "Each paycheck"}</CardTitle>
            <CardDescription>
              {view === "month"
                ? "The full month in one line per commitment."
                : "From the day the money lands until the next paycheck arrives."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {view === "month" ? (
              <Table>
                <TableBody>
                  {[
                    ["Income", s.income_cents, "in"],
                    ["Fixed costs", -s.fixed_cents, "out"],
                    ["Lumpy fund", -s.lumpy_cents, "out"],
                    ["Savings", -s.savings_cents, "out"],
                    ["Planned free cash", s.planned_free_cents, "sub"],
                    ["Discretionary spending", -s.spent.discretionary, "out"],
                    ["Available to spend", s.available_cents, "total"],
                  ].map(([label, cents, kind]) => (
                    <TableRow key={label as string} className={kind === "total" ? "font-semibold" : ""}>
                      <TableCell className={kind === "sub" || kind === "total" ? "font-medium" : ""}>{label}</TableCell>
                      <TableCell className="text-right">
                        <Money cents={cents as number} tone={kind === "total"} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : s.periods.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No paychecks this month</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {s.periods.map((p) => (
                  <div key={p.start} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">
                        {dateLabel(p.start)} – {dateLabel(p.end)}
                        <span className="ml-2 text-sm font-normal text-muted-foreground">{p.stream_name}</span>
                      </span>
                      <span className="text-sm">
                        Available <Money cents={p.available_cents} tone className="font-semibold" />
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      In <Money cents={p.income_cents} /> · bills <Money cents={p.fixed_cents} /> · lumpy{" "}
                      <Money cents={p.lumpy_cents} /> · savings <Money cents={p.savings_cents} /> · spent{" "}
                      <Money cents={p.spent_discretionary_cents} />
                    </div>
                    {p.holds.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {p.holds.map((h) => (
                          <Badge key={h.fixed_cost_id} variant="secondary">
                            {h.name} {money(h.amount_cents, { cents: false })}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                    {p.over_committed ? (
                      <Badge variant="destructive" className="mt-2">
                        This paycheck cannot cover what is assigned to it
                      </Badge>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Coming out of the lumpy fund</CardTitle>
            <CardDescription>
              <Link className="underline" to="/lumpy/timeline">
                See the full 12 months
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing due in the next 12 months.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcoming.map((d) => (
                    <TableRow key={`${d.id}-${d.date}`}>
                      <TableCell className="font-medium">{d.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{dateLabelFull(d.date)}</TableCell>
                      <TableCell className="text-right">
                        <Money cents={d.amount_cents} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {timeline.data?.first_short_month ? (
              <Alert variant="destructive" className="mt-3">
                <AlertTriangleIcon />
                <AlertDescription>
                  The fund runs short in {monthLabel(timeline.data.first_short_month)}.
                </AlertDescription>
              </Alert>
            ) : null}
            <Button variant="outline" className="mt-3 w-full" render={<Link to="/reports" />} nativeButton={false}>
              Where the money went
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
