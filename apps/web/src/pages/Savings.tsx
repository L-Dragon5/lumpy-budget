import { useState } from "react";
import type { SavingsGoal } from "@lumpy/contracts";
import type { MonthSummary } from "@lumpy/budget-core";
import { PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SingleToggle } from "@/components/app/controls";
import { AddButton, DeleteButton, MoneyField, RecordDialog } from "@/components/app/record-dialog";
import { Money } from "@/components/app/money";
import { StatTile } from "@/components/app/stat-tile";
import { Loading, LoadError, MonthNav, PageHeader } from "@/components/app/page";
import { useApi, useCreate, useDelete, useUpdate } from "@/lib/api";
import { dateLabel, monthLabel, thisMonth } from "@/lib/format";

type Draft = {
  name: string;
  mode: "fixed" | "percent";
  amount_cents: number | null;
  percent: string;
  active: boolean;
};

const emptyDraft = (): Draft => ({ name: "", mode: "fixed", amount_cents: null, percent: "10", active: true });

const toDraft = (g: SavingsGoal): Draft => ({
  name: g.name,
  mode: g.mode,
  amount_cents: g.amount_cents,
  percent: g.percent === null ? "10" : String(g.percent),
  active: g.active,
});

const toBody = (d: Draft) => ({
  name: d.name,
  mode: d.mode,
  amount_cents: d.mode === "fixed" ? (d.amount_cents ?? 0) : null,
  percent: d.mode === "percent" ? Number(d.percent) : null,
  active: d.active,
});

export default function Savings() {
  const [month, setMonth] = useState(thisMonth());
  const goals = useApi<SavingsGoal[]>("/api/savings-goals");
  const summary = useApi<MonthSummary>(`/api/summary?month=${month}`);
  const create = useCreate("savings-goals");
  const update = useUpdate("savings-goals");
  const remove = useDelete("savings-goals");

  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = () => {
    if (!draft) return;
    const done = { onSuccess: () => setDraft(null) };
    if (editing) update.mutate({ id: editing.id, body: toBody(draft) }, done);
    else create.mutate(toBody(draft), done);
  };

  if (goals.isLoading || summary.isLoading) return <Loading />;
  if (goals.error) return <LoadError error={goals.error} />;
  if (summary.error) return <LoadError error={summary.error} />;

  const rows = goals.data ?? [];
  const s = summary.data!;
  const perGoal = new Map(s.savings_breakdown.map((b) => [b.name, b.amount_cents]));
  const paychecks = s.paychecks.filter((p) => !p.prior_month);

  return (
    <>
      <PageHeader
        title="Savings"
        description="A flat amount or a share of what comes in, taken off the top and split across the month's paychecks."
        actions={
          <>
            <MonthNav month={month} onChange={setMonth} />
            <AddButton onClick={() => { setEditing(null); setDraft(emptyDraft()); }}>Add goal</AddButton>
          </>
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatTile label={`Saving in ${monthLabel(month)}`} cents={s.savings_cents} caption={`${((s.savings_cents / Math.max(1, s.income_cents)) * 100).toFixed(1)}% of this month's income`} />
        <StatTile label="Income this month" cents={s.income_cents} tone="muted" caption="What percent goals are measured against." />
        <StatTile label="Left after everything" cents={s.planned_free_cents} tone={s.planned_free_cents < 0 ? "critical" : "good"} caption="Income minus bills, lumpy fund and savings." />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Goals</CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No savings goals</EmptyTitle>
                  <EmptyDescription>An emergency fund, a down payment, a brokerage transfer.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Goal</TableHead>
                    <TableHead>Rule</TableHead>
                    <TableHead className="text-right">This month</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((g) => (
                    <TableRow key={g.id} className={g.active ? "" : "opacity-50"}>
                      <TableCell className="font-medium">{g.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {g.mode === "fixed" ? "Fixed amount" : `${g.percent}% of income`}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money cents={perGoal.get(g.name) ?? 0} />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Button variant="ghost" size="icon" onClick={() => { setEditing(g); setDraft(toDraft(g)); }} aria-label={`Edit ${g.name}`}>
                            <PencilIcon />
                          </Button>
                          <DeleteButton label={g.name} onConfirm={() => remove.mutate(g.id)} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Take from each paycheck</CardTitle>
            <CardDescription>
              Split in proportion to paycheck size, so a small cheque is never asked to carry a big transfer.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {paychecks.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No paychecks this month</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Paycheck</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">To savings</TableHead>
                    <TableHead className="text-right">To lumpy fund</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paychecks.map((p) => (
                    <TableRow key={`${p.date}-${p.stream_id}`}>
                      <TableCell>
                        <div className="font-medium">{dateLabel(p.date)}</div>
                        <div className="text-xs text-muted-foreground">{p.stream_name}</div>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        <Money cents={p.amount_cents} />
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        <Money cents={p.savings_cents} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money cents={p.lumpy_cents} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {draft ? (
        <RecordDialog
          open
          onOpenChange={(o) => !o && setDraft(null)}
          title={editing ? `Edit ${editing.name}` : "Add savings goal"}
          onSubmit={save}
          pending={create.isPending || update.isPending}
          error={create.error ?? update.error}
        >
          <Field>
            <FieldLabel htmlFor="sg-name">Name</FieldLabel>
            <Input id="sg-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Emergency fund" />
          </Field>

          <Field>
            <FieldLabel>How it is calculated</FieldLabel>
            <SingleToggle<"fixed" | "percent">
              className="w-full"
              value={draft.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: "fixed" as const, label: "A fixed amount" },
                { value: "percent" as const, label: "A percent of income" },
              ]}
            />
          </Field>

          {draft.mode === "fixed" ? (
            <MoneyField
              label="Amount per month"
              cents={draft.amount_cents}
              onChange={(c) => set({ amount_cents: c })}
            />
          ) : (
            <Field>
              <FieldLabel htmlFor="sg-pct">Percent of monthly income</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="sg-pct"
                  inputMode="decimal"
                  value={draft.percent}
                  onChange={(e) => set({ percent: e.target.value })}
                />
                <InputGroupAddon align="inline-end">%</InputGroupAddon>
              </InputGroup>
              <FieldDescription>
                Measured against what actually arrives that month, so an extra-paycheck month saves more.
              </FieldDescription>
            </Field>
          )}

          <Field orientation="horizontal">
            <Switch id="sg-active" checked={draft.active} onCheckedChange={(v) => set({ active: v })} />
            <FieldLabel htmlFor="sg-active">Active</FieldLabel>
          </Field>
        </RecordDialog>
      ) : null}
    </>
  );
}
