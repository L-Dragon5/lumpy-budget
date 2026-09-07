import { useState } from "react";
import { Link } from "react-router";
import type { Category, LumpyItem } from "@lumpy/contracts";
import type { LumpyPlan, Timeline } from "@lumpy/budget-core";
import { ArrowRightIcon, PencilIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SelectField } from "@/components/app/controls";
import { AddButton, DeleteButton, MoneyField, RecordDialog } from "@/components/app/record-dialog";
import { Money } from "@/components/app/money";
import { StatTile } from "@/components/app/stat-tile";
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { useApi, useCreate, useDelete, useUpdate } from "@/lib/api";
import { CYCLE_LABEL, dateLabelFull, thisMonth } from "@/lib/format";

type TimelineResponse = Timeline & { opening_balance_cents: number; plan: LumpyPlan[] };

type Draft = {
  name: string;
  amount_cents: number | null;
  frequency_months: string;
  next_due_date: string;
  category_id: string;
  active: boolean;
};

const CYCLES = [1, 3, 6, 12, 24];

const emptyDraft = (): Draft => ({
  name: "", amount_cents: null, frequency_months: "12", next_due_date: "", category_id: "none", active: true,
});

const toDraft = (i: LumpyItem): Draft => ({
  name: i.name,
  amount_cents: i.amount_cents,
  frequency_months: String(i.frequency_months),
  next_due_date: i.next_due_date,
  category_id: i.category_id === null ? "none" : String(i.category_id),
  active: i.active,
});

const toBody = (d: Draft) => ({
  name: d.name,
  amount_cents: d.amount_cents ?? 0,
  frequency_months: Number(d.frequency_months),
  next_due_date: d.next_due_date,
  category_id: d.category_id === "none" ? null : Number(d.category_id),
  active: d.active,
});

export default function LumpyFund() {
  const month = thisMonth();
  const items = useApi<LumpyItem[]>("/api/lumpy-items");
  const categories = useApi<Category[]>("/api/categories");
  const timeline = useApi<TimelineResponse>(`/api/lumpy-timeline?start=${month}&months=12`);
  const create = useCreate("lumpy-items");
  const update = useUpdate("lumpy-items");
  const remove = useDelete("lumpy-items");

  const [editing, setEditing] = useState<LumpyItem | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = () => {
    if (!draft) return;
    const done = { onSuccess: () => setDraft(null) };
    if (editing) update.mutate({ id: editing.id, body: toBody(draft) }, done);
    else create.mutate(toBody(draft), done);
  };

  if (items.isLoading || timeline.isLoading) return <Loading />;
  if (items.error) return <LoadError error={items.error} />;
  if (timeline.error) return <LoadError error={timeline.error} />;

  const rows = items.data ?? [];
  const plans = timeline.data?.plan ?? [];
  const planFor = (id: number) => plans.find((p) => p.item.id === id);
  const steady = plans.reduce((a, p) => a + p.steady_cents, 0);
  const recommended = timeline.data?.monthly_contribution_cents ?? 0;
  const behind = plans.filter((p) => p.behind);
  const yearlyTotal = rows.filter((r) => r.active).reduce((a, r) => a + Math.round((r.amount_cents * 12) / r.frequency_months), 0);

  return (
    <>
      <PageHeader
        title="Lumpy fund"
        description="The costs that do not arrive monthly but still have to be paid: insurance, registrations, annual fees, property taxes. Save for them every month so none of them is ever a surprise."
        actions={
          <>
            <Button variant="outline" render={<Link to="/lumpy/timeline" />} nativeButton={false}>
              12-month timeline
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
            <AddButton onClick={() => { setEditing(null); setDraft(emptyDraft()); }}>Add item</AddButton>
          </>
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Save each month"
          cents={recommended}
          emphasis={false}
          tone={recommended > steady ? "critical" : "neutral"}
          caption={
            recommended > steady
              ? `Includes catch-up. At a steady state it would be ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(steady / 100)}.`
              : "You are on schedule: this is the steady-state number."
          }
        />
        <StatTile label="In the fund now" cents={timeline.data?.opening_balance_cents ?? 0} caption="Set this on the Settings page." tone="muted" />
        <StatTile label="Leaves in 12 months" cents={timeline.data?.total_outflow_cents ?? 0} caption="Everything coming due within the year." tone="muted" />
        <StatTile label="Cost per year" cents={yearlyTotal} caption="All items, annualized." tone="muted" />
      </div>

      {behind.length > 0 ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Behind on {behind.length} item{behind.length === 1 ? "" : "s"}</CardTitle>
            <CardDescription>
              These come due sooner than a full cycle away, so the monthly number is higher than the long-run cost
              until they are paid.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {behind.map((p) => (
                <li key={p.item.id} className="flex items-center justify-between">
                  <span>
                    {p.item.name}
                    <span className="ml-2 text-muted-foreground">
                      due in {p.months_until_due} month{p.months_until_due === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span>
                    <Money cents={p.catch_up_cents} /> <span className="text-muted-foreground">vs</span>{" "}
                    <Money cents={p.steady_cents} className="text-muted-foreground" />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing in the fund yet</EmptyTitle>
                <EmptyDescription>
                  Car insurance, property taxes, registrations, domain renewals, annual subscriptions, HOA dues.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Cycle</TableHead>
                  <TableHead>Next due</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Per month</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((i) => {
                  const p = planFor(i.id);
                  return (
                    <TableRow key={i.id} className={i.active ? "" : "opacity-50"}>
                      <TableCell className="font-medium">{i.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{CYCLE_LABEL(i.frequency_months)}</TableCell>
                      <TableCell className="text-sm">
                        {dateLabelFull(i.next_due_date)}
                        {p?.behind ? <Badge variant="destructive" className="ml-2">catching up</Badge> : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money cents={i.amount_cents} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money cents={p?.recommended_cents ?? 0} />
                        {p && p.recommended_cents !== p.steady_cents ? (
                          <div className="text-xs text-muted-foreground">
                            steady <Money cents={p.steady_cents} />
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Button variant="ghost" size="icon" onClick={() => { setEditing(i); setDraft(toDraft(i)); }} aria-label={`Edit ${i.name}`}>
                            <PencilIcon />
                          </Button>
                          <DeleteButton label={i.name} onConfirm={() => remove.mutate(i.id)} />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {draft ? (
        <RecordDialog
          open
          onOpenChange={(o) => !o && setDraft(null)}
          title={editing ? `Edit ${editing.name}` : "Add lumpy item"}
          description="Something you pay on a cycle longer than a month."
          onSubmit={save}
          pending={create.isPending || update.isPending}
          error={create.error ?? update.error}
        >
          <Field>
            <FieldLabel htmlFor="lf-name">Name</FieldLabel>
            <Input id="lf-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Car insurance, property taxes" />
          </Field>

          <MoneyField
            label="Amount each time"
            cents={draft.amount_cents}
            onChange={(c) => set({ amount_cents: c })}
            description="The full bill, not the monthly share."
          />

          <Field>
            <FieldLabel>How often</FieldLabel>
            <SelectField
              value={draft.frequency_months}
              onChange={(v) => set({ frequency_months: v })}
              options={CYCLES.map((m) => ({ value: String(m), label: CYCLE_LABEL(m) }))}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="lf-due">Next due date</FieldLabel>
            <Input id="lf-due" type="date" value={draft.next_due_date} onChange={(e) => set({ next_due_date: e.target.value })} />
            <FieldDescription>
              If this is sooner than a full cycle away, the monthly amount goes up to catch up in time.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Category</FieldLabel>
            <SelectField
              value={draft.category_id}
              onChange={(v) => set({ category_id: v })}
              options={[{ value: "none", label: "None" }, ...(categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))]}
            />
          </Field>

          <Field orientation="horizontal">
            <Switch id="lf-active" checked={draft.active} onCheckedChange={(v) => set({ active: v })} />
            <FieldLabel htmlFor="lf-active">Active</FieldLabel>
          </Field>
        </RecordDialog>
      ) : null}
    </>
  );
}
