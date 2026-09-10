import { Fragment, useMemo, useState } from "react";
import type { Bucket } from "@lumpy/contracts";
import { addDays, addMonths, monthEnd, monthOf, monthStart, todayISO, weekStart } from "@lumpy/budget-core";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
import { ChevronLeftIcon, ChevronRightIcon, CircleHelpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SelectField, SingleToggle } from "@/components/app/controls";
import { Money } from "@/components/app/money";
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { eden, useApi } from "@/lib/api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BUCKET_HINT, BUCKET_LABEL, BUCKET_ORDER, dateLabel, money, monthLabel } from "@/lib/format";
import { MAX_SERIES, OTHER_COLOR, seriesColor } from "@/lib/palette";
import { CategoryIcon } from "@/lib/icons";

const OTHER = "Other";
const BUCKETS: { value: Bucket | "all"; label: string }[] = [
  { value: "discretionary", label: "Discretionary" },
  { value: "all", label: "All spending" },
  { value: "fixed", label: "Fixed bills" },
  { value: "lumpy", label: "Lumpy fund" },
  { value: "savings", label: "Savings" },
  { value: "transfer", label: "Transfers" },
];

export default function Reports() {
  const [granularity, setGranularity] = useState<"month" | "week">("month");
  const [month, setMonth] = useState(monthOf(todayISO()));
  const [week, setWeek] = useState(weekStart(todayISO()));
  const [bucket, setBucket] = useState<Bucket | "all">("discretionary");

  const start = granularity === "month" ? monthStart(month) : week;
  const end = granularity === "month" ? monthEnd(month) : addDays(week, 6);
  const label = granularity === "month" ? monthLabel(month) : `${dateLabel(week)} – ${dateLabel(addDays(week, 6))}`;

  const detail = useApi(["reports", granularity, start, end, bucket], () =>
    eden.api.reports.get({ query: { granularity, start, end, bucket } }));

  // A wider window for the trend, so the selected period sits in context.
  const trendStart = granularity === "month" ? monthStart(addMonths(month, -11)) : addDays(week, -7 * 11);
  const trend = useApi(["reports", granularity, trendStart, end, bucket], () =>
    eden.api.reports.get({ query: { granularity, start: trendStart, end, bucket } }));
  const categories = useApi(["categories"], () => eden.api.categories.get());

  // Colors are assigned from the whole ledger for the chosen bucket, not from what
  // this period happens to contain, so paging between weeks never repaints a
  // category. There are more categories than slots, so the smallest ones share the
  // "Other" grey rather than cycling a hue onto two visible slices at once.
  const ranking = useApi(["reports-ranking", bucket], () =>
    eden.api.reports.get({ query: { granularity: "month", start: "2020-01-01", end: "2035-12-31", bucket } }));
  // Anchored on today, not on the period selector: "by the 8th you normally spent
  // X" is a question about the month in progress and nothing else.
  const pace = useApi(["category-pace", bucket], () =>
    eden.api["category-pace"].get({ query: { months: 3, bucket } }));
  const slots = useMemo(() => {
    const ranked = (ranking.data?.breakdown.slices ?? []).filter((s) => s.category_id !== null);
    return new Map(ranked.slice(0, MAX_SERIES).map((s, i) => [s.category_id!, i]));
  }, [ranking.data]);
  const colorOf = (id: number | null) =>
    id !== null && slots.has(id) ? seriesColor(slots.get(id)!) : OTHER_COLOR;
  const hasSlot = (id: number | null) => id !== null && slots.has(id);

  if (detail.isLoading || categories.isLoading) return <Loading />;
  if (detail.error) return <LoadError error={detail.error} />;

  const slices = detail.data?.breakdown.slices ?? [];
  const total = detail.data?.breakdown.total_cents ?? 0;

  const shown = slices.filter((s) => hasSlot(s.category_id));
  const rest = slices.filter((s) => !hasSlot(s.category_id));
  const iconOf = (id: number | null) =>
    id === null ? null : ((categories.data ?? []).find((c) => c.id === id)?.icon ?? null);
  const pieData = [
    ...shown.map((s) => ({
      name: s.name,
      value: s.amount_cents / 100,
      color: colorOf(s.category_id),
      icon: iconOf(s.category_id),
    })),
    ...(rest.length > 0
      ? [{ name: OTHER, value: rest.reduce((a, s) => a + s.amount_cents, 0) / 100, color: OTHER_COLOR, icon: null }]
      : []),
  ];

  const trendData = (trend.data?.series ?? []).map((p) => ({
    key: p.key,
    label: granularity === "month" ? monthLabel(p.key, true) : dateLabel(p.start),
    amount: p.amount_cents / 100,
    current: p.start === start,
  }));

  const pieConfig: ChartConfig = Object.fromEntries(
    pieData.map((d) => [d.name, { label: d.name, color: d.color }]),
  );
  const trendConfig = {
    amount: { label: granularity === "month" ? "Spent that month" : "Spent that week", color: "var(--chart-1)" },
  } satisfies ChartConfig;

  const step = (n: number) =>
    granularity === "month" ? setMonth(addMonths(month, n)) : setWeek(addDays(week, n * 7));

  const totals = detail.data?.totals;
  const paceRows = pace.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Reports"
        description="Where the money actually went, by week or by month."
        actions={
          <>
            <SingleToggle<"month" | "week">
              value={granularity}
              onChange={setGranularity}
              options={[
                { value: "month" as const, label: "By month" },
                { value: "week" as const, label: "By week" },
              ]}
            />
            <div className="flex items-center gap-1 rounded-md border p-1">
              <Button variant="ghost" size="icon" onClick={() => step(-1)} aria-label="Previous period">
                <ChevronLeftIcon />
              </Button>
              <span className="min-w-40 text-center text-sm font-medium">{label}</span>
              <Button variant="ghost" size="icon" onClick={() => step(1)} aria-label="Next period">
                <ChevronRightIcon />
              </Button>
            </div>
            <SelectField
              value={bucket}
              onChange={(v) => setBucket(v as Bucket | "all")}
              options={BUCKETS}
              className="w-44"
            />
          </>
        }
      />

      {totals ? (
        <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>
            Discretionary <Money cents={totals.discretionary} className="font-medium text-foreground" />
          </span>
          <span>
            Fixed bills <Money cents={totals.fixed} className="font-medium text-foreground" />
          </span>
          <span>
            Lumpy <Money cents={totals.lumpy} className="font-medium text-foreground" />
          </span>
          <span>
            Savings <Money cents={totals.savings} className="font-medium text-foreground" />
          </span>
          <span>
            All spending <Money cents={totals.total} className="font-medium text-foreground" />
          </span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By category — {label}</CardTitle>
            <CardDescription>
              {detail.data?.breakdown.txn_count ?? 0} transactions, <Money cents={total} /> in total.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {pieData.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Nothing spent in this period</EmptyTitle>
                  <EmptyDescription>Try another week or month, or a different bucket.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ChartContainer config={pieConfig} className="mx-auto aspect-square max-h-72">
                <PieChart>
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        hideLabel
                        formatter={(value, name) => (
                          <div className="flex w-full items-center justify-between gap-4">
                            <span className="text-muted-foreground">{name}</span>
                            <span className="tabular font-medium">{money(Number(value) * 100)}</span>
                          </div>
                        )}
                      />
                    }
                  />
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="45%"
                    outerRadius="80%"
                    paddingAngle={2}
                    stroke="var(--card)"
                    strokeWidth={2}
                  >
                    {pieData.map((d) => (
                      <Cell key={d.name} fill={d.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
            )}
            {pieData.length > 0 ? (
              <ul className="mt-4 flex flex-col gap-1.5 text-sm">
                {pieData.map((d) => (
                  <li key={d.name} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: d.color }}
                        aria-hidden
                      />
                      <CategoryIcon name={d.icon} />
                      <span className="truncate">{d.name}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      <Money cents={Math.round(d.value * 100)} className="text-foreground" />{" "}
                      {total > 0 ? `${((d.value * 100 * 100) / total).toFixed(1)}%` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{granularity === "month" ? "Last 12 months" : "Last 12 weeks"}</CardTitle>
            <CardDescription>The selected period is the darker bar.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={trendConfig} className="h-72 w-full">
              <BarChart data={trendData} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} strokeOpacity={0.35} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
                <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => money(v * 100, { cents: false })} />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => (
                        <span className="tabular font-medium">{money(Number(value) * 100)}</span>
                      )}
                    />
                  }
                />
                <Bar dataKey="amount" radius={[4, 4, 0, 0]} maxBarSize={36}>
                  {trendData.map((d) => (
                    <Cell key={d.key} fill="var(--chart-1)" fillOpacity={d.current ? 1 : 0.45} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      {/* Only for the month in progress. Paging back to March and asking what is
          usual "by the 8th" answers a question nobody asked. */}
      {granularity === "month" && month === monthOf(todayISO()) && paceRows.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>This month, by day {pace.data!.through_day}</CardTitle>
            <CardDescription>
              Groceries and restaurants have no budgeted number and never will, so the comparison is your
              own history: the middle of the last{" "}
              {pace.data!.months_compared.length === 1
                ? "month"
                : `${pace.data!.months_compared.length} months`}{" "}
              cut at the same day of the month. Months with nothing imported are left out.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">So far</TableHead>
                  <TableHead className="text-right">Usually by now</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paceRows.map((r) => (
                  <TableRow key={r.category_id ?? "none"}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: colorOf(r.category_id) }}
                        />
                        <CategoryIcon name={iconOf(r.category_id)} />
                        {r.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Money cents={r.month_to_date_cents} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      <Money cents={r.typical_cents} />
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={r.delta_cents > 0 ? "text-destructive" : "text-muted-foreground"}>
                        {r.delta_cents > 0 ? "+" : ""}
                        {money(r.delta_cents)}
                        {/* A percentage off nothing is not a percentage. */}
                        {r.typical_cents !== 0 ? (
                          <span className="ml-1 text-xs">
                            ({r.pct_off > 0 ? "+" : ""}
                            {r.pct_off.toFixed(0)}%)
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Every category</CardTitle>
          <CardDescription>The same numbers as the chart, in full.</CardDescription>
        </CardHeader>
        <CardContent>
          {slices.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing to show for this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      Bucket
                      <Tooltip>
                        <TooltipTrigger
                          aria-label="What the buckets mean"
                          className="text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground"
                        >
                          <CircleHelpIcon className="size-3.5" />
                        </TooltipTrigger>
                        <TooltipContent className="block max-w-80 py-2">
                          <p className="mb-1.5">How a category is treated when the month is added up.</p>
                          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                            {BUCKET_ORDER.map((b) => (
                              <Fragment key={b}>
                                <dt className="font-medium">{BUCKET_LABEL[b]}</dt>
                                <dd className="opacity-80">{BUCKET_HINT[b]}</dd>
                              </Fragment>
                            ))}
                          </dl>
                        </TooltipContent>
                      </Tooltip>
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Transactions</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slices.map((s) => (
                  <TableRow key={s.category_id ?? "none"}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: colorOf(s.category_id) }}
                        />
                        <CategoryIcon name={iconOf(s.category_id)} />
                        {s.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{BUCKET_LABEL[s.bucket] ?? s.bucket}</TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">{s.txn_count}</TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">{s.pct.toFixed(1)}%</TableCell>
                    <TableCell className="text-right">
                      <Money cents={s.amount_cents} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={4}>Total</TableCell>
                  <TableCell className="text-right font-semibold">
                    <Money cents={total} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
