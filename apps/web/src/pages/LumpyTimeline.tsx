import { useState } from "react";
import { Link } from "react-router";
import type { LumpyPlan, Timeline } from "@lumpy/budget-core";
import { Area, Bar, CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts";
import { AlertTriangleIcon, ArrowLeftIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SingleToggle } from "@/components/app/controls";
import { Money } from "@/components/app/money";
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { api, useApi, useInvalidateAll } from "@/lib/api";
import { centsToInput, money, monthLabel, toCents, thisMonth } from "@/lib/format";

type TimelineResponse = Timeline & { opening_balance_cents: number; plan: LumpyPlan[] };

const chartConfig = {
  balance: { label: "Balance at month end", color: "var(--chart-1)" },
  outflow: { label: "Paid out", color: "var(--chart-2)" },
} satisfies ChartConfig;

export default function LumpyTimeline() {
  const [mode, setMode] = useState<"recommended" | "steady">("recommended");
  const start = thisMonth();
  const timeline = useApi<TimelineResponse>(`/api/lumpy-timeline?start=${start}&months=12&lumpy_mode=${mode}`);
  const invalidate = useInvalidateAll();
  const [balanceText, setBalanceText] = useState<string | null>(null);

  if (timeline.isLoading) return <Loading />;
  if (timeline.error) return <LoadError error={timeline.error} />;
  const t = timeline.data!;

  const saveBalance = async () => {
    const cents = toCents(balanceText ?? "");
    if (cents === null) return;
    await api.put("/api/settings", { name: "lumpy_opening_balance_cents", value: String(cents) });
    setBalanceText(null);
    invalidate();
  };

  const data = t.rows.map((r) => ({
    month: monthLabel(r.month, true),
    balance: r.balance_end_cents / 100,
    outflow: r.outflow_cents / 100,
  }));

  return (
    <>
      <PageHeader
        title="12-month outflow"
        description="What leaves the lumpy fund each month, and what has to be sitting in the account when the month starts."
        actions={
          <>
            <SingleToggle<"recommended" | "steady">
              value={mode}
              onChange={setMode}
              options={[
                { value: "recommended" as const, label: "Catch up" },
                { value: "steady" as const, label: "Steady state" },
              ]}
            />
            <Button variant="outline" render={<Link to="/lumpy" />} nativeButton={false}>
              <ArrowLeftIcon data-icon="inline-start" />
              Items
            </Button>
          </>
        }
      />

      {t.first_short_month ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangleIcon />
          <AlertTitle>The fund runs dry in {monthLabel(t.first_short_month)}</AlertTitle>
          <AlertDescription>
            At {money(t.monthly_contribution_cents)} a month the account cannot cover what comes due. Switch to
            catch-up, raise the contribution, or move a due date.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="opening">Balance in the fund today</Label>
          <div className="flex gap-2">
            <Input
              id="opening"
              className="w-40"
              inputMode="decimal"
              value={balanceText ?? centsToInput(t.opening_balance_cents)}
              onChange={(e) => setBalanceText(e.target.value)}
            />
            <Button variant="outline" onClick={saveBalance} disabled={balanceText === null}>
              Save
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Contributing <Money cents={t.monthly_contribution_cents} className="font-medium" /> a month;{" "}
          <Money cents={t.total_outflow_cents} className="font-medium" /> leaves over the next 12 months.
        </p>
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Balance and outflow</CardTitle>
          <CardDescription>
            The area is what is in the account at the end of each month; the bars are what was paid out of it.
            Every figure is in the table below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="h-72 w-full">
            <ComposedChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.35} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(v: number) => money(v * 100, { cents: false })}
              />
              <ChartTooltip
                cursor={{ strokeOpacity: 0.3 }}
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">{chartConfig[name as keyof typeof chartConfig]?.label}</span>
                        <span className="tabular font-medium">{money(Number(value) * 100)}</span>
                      </div>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                dataKey="balance"
                type="monotone"
                stroke="var(--color-balance)"
                strokeWidth={2}
                fill="var(--color-balance)"
                fillOpacity={0.12}
              />
              <Bar dataKey="outflow" fill="var(--color-outflow)" radius={[4, 4, 0, 0]} maxBarSize={26} />
            </ComposedChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Month by month</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Start of month</TableHead>
                  <TableHead className="text-right">Contribute</TableHead>
                  <TableHead className="text-right">Paid out</TableHead>
                  <TableHead className="text-right">End of month</TableHead>
                  <TableHead>What comes due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.rows.map((r) => (
                  <TableRow key={r.month} className={r.short ? "bg-destructive/10" : ""}>
                    <TableCell className="font-medium">{monthLabel(r.month)}</TableCell>
                    <TableCell className="text-right">
                      <Money cents={r.balance_start_cents} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      <Money cents={r.contribution_cents} />
                    </TableCell>
                    <TableCell className="text-right">
                      {r.outflow_cents > 0 ? <Money cents={r.outflow_cents} /> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <Money cents={r.balance_end_cents} tone={r.balance_end_cents < 0} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.due.map((d) => d.name).join(", ") || "—"}
                      {r.short ? (
                        <Badge variant="destructive" className="ml-2">
                          short <Money cents={r.shortfall_cents} />
                        </Badge>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>12-month total</TableCell>
                  <TableCell />
                  <TableCell className="text-right">
                    <Money cents={t.monthly_contribution_cents * 12} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={t.total_outflow_cents} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={t.rows[t.rows.length - 1]?.balance_end_cents ?? 0} />
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
