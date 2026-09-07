import { useState } from "react";
import type { FixedCost, FixedCostInput } from "@lumpy/contracts";
import { AlertTriangleIcon, PencilIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SelectField } from "@/components/app/controls";
import { CategoryLabel } from "@/lib/icons";
import { AddButton, DeleteButton, MoneyField, RecordDialog } from "@/components/app/record-dialog";
import { Money } from "@/components/app/money";
import { Loading, LoadError, MonthNav, PageHeader } from "@/components/app/page";
import { eden, useApi, useMutate } from "@/lib/api";
import { dateLabel, monthLabel, ordinal, thisMonth } from "@/lib/format";

type Draft = {
  name: string;
  amount_cents: number | null;
  due_day: string;
  lead_days: string;
  category_id: string;
  active: boolean;
};

const emptyDraft = (): Draft => ({ name: "", amount_cents: null, due_day: "1", lead_days: "3", category_id: "none", active: true });

const toDraft = (c: FixedCost): Draft => ({
  name: c.name,
  amount_cents: c.amount_cents,
  due_day: String(c.due_day),
  lead_days: String(c.lead_days),
  category_id: c.category_id === null ? "none" : String(c.category_id),
  active: c.active,
});

const toBody = (d: Draft) => ({
  name: d.name,
  amount_cents: d.amount_cents ?? 0,
  due_day: Number(d.due_day),
  lead_days: Number(d.lead_days),
  category_id: d.category_id === "none" ? null : Number(d.category_id),
  active: d.active,
});

export default function FixedCosts() {
  const [month, setMonth] = useState(thisMonth());
  const costs = useApi(["fixed-costs"], () => eden.api["fixed-costs"].get());
  const categories = useApi(["categories"], () => eden.api.categories.get());
  const allocation = useApi(["allocation", month], () => eden.api.allocation.get({ query: { month } }));
  const create = useMutate((body: FixedCostInput) => eden.api["fixed-costs"].post(body));
  const update = useMutate((v: { id: number; body: FixedCostInput }) =>
    eden.api["fixed-costs"]({ id: v.id }).put(v.body));
  const remove = useMutate((id: number) => eden.api["fixed-costs"]({ id }).delete());

  const [editing, setEditing] = useState<FixedCost | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = () => {
    if (!draft) return;
    const done = { onSuccess: () => setDraft(null) };
    if (editing) update.mutate({ id: editing.id, body: toBody(draft) }, done);
    else create.mutate(toBody(draft), done);
  };

  if (costs.isLoading || allocation.isLoading) return <Loading />;
  if (costs.error) return <LoadError error={costs.error} />;
  if (allocation.error) return <LoadError error={allocation.error} />;

  const rows = costs.data ?? [];
  const alloc = allocation.data;
  const monthlyTotal = rows.filter((c) => c.active).reduce((a, c) => a + c.amount_cents, 0);
  const categoryOf = (id: number | null) =>
    id === null ? null : (categories.data ?? []).find((c) => c.id === id) ?? null;

  return (
    <>
      <PageHeader
        title="Fixed costs"
        description="The bills that arrive every month, and which paycheck has to hold the money for each one."
        actions={
          <>
            <MonthNav month={month} onChange={setMonth} />
            <AddButton onClick={() => { setEditing(null); setDraft(emptyDraft()); }}>Add cost</AddButton>
          </>
        }
      />

      {alloc && alloc.unfunded.length > 0 ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangleIcon />
          <AlertTitle>No income to cover {alloc.unfunded.length} bill(s)</AlertTitle>
          <AlertDescription>
            {alloc.unfunded.map((u) => u.name).join(", ")} — add an income stream so these can be assigned.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Bills</CardTitle>
            <CardDescription>
              <Money cents={monthlyTotal} /> a month across {rows.filter((c) => c.active).length} active bills.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No fixed costs yet</EmptyTitle>
                  <EmptyDescription>Rent or mortgage, car loan, utilities, phone, insurance premiums.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bill</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c) => (
                    <TableRow key={c.id} className={c.active ? "" : "opacity-50"}>
                      <TableCell>
                        <div className="font-medium">{c.name}</div>
                        {categoryOf(c.category_id) ? (
                          <CategoryLabel
                            name={categoryOf(c.category_id)!.name}
                            icon={categoryOf(c.category_id)!.icon}
                            className="text-xs text-muted-foreground [&>svg]:size-3"
                          />
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {ordinal(c.due_day)}
                        {c.lead_days > 0 ? <span className="block text-xs">hold {c.lead_days}d early</span> : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money cents={c.amount_cents} />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Button variant="ghost" size="icon" onClick={() => { setEditing(c); setDraft(toDraft(c)); }} aria-label={`Edit ${c.name}`}>
                            <PencilIcon />
                          </Button>
                          <DeleteButton label={c.name} onConfirm={() => remove.mutate(c.id)} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Set aside first — {monthLabel(month)}</CardTitle>
            <CardDescription>
              Each paycheck, and what to hold back from it before you spend anything. A bill goes to the last
              paycheck that arrives in time to pay it and is big enough to cover it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {(alloc?.paychecks ?? []).length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No paychecks this month</EmptyTitle>
                  <EmptyDescription>Add income to see the allocation.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              alloc?.paychecks.map((p) => (
                <div key={`${p.date}-${p.stream_id}-${p.holds.length}`} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{dateLabel(p.date)}</span>
                      <span className="text-sm text-muted-foreground">{p.stream_name}</span>
                      {p.prior_month ? <Badge variant="outline">last month</Badge> : null}
                      {p.over_committed ? <Badge variant="destructive">over-committed</Badge> : null}
                    </div>
                    <Money cents={p.amount_cents} className="font-medium" />
                  </div>

                  {p.holds.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1 border-t pt-2">
                      {p.holds.map((h) => (
                        <li key={h.fixed_cost_id} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">
                            {h.name}
                            <span className="ml-2 text-xs">due {dateLabel(h.due_date)}</span>
                            {h.late ? <Badge variant="destructive" className="ml-2">late</Badge> : null}
                          </span>
                          <Money cents={h.amount_cents} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 border-t pt-2 text-sm text-muted-foreground">No bills held from this one.</p>
                  )}

                  <div className="mt-2 flex flex-wrap justify-between gap-x-6 gap-y-1 border-t pt-2 text-sm">
                    <span className="text-muted-foreground">
                      Bills <Money cents={p.hold_total_cents} /> · Lumpy <Money cents={p.lumpy_cents} /> · Savings{" "}
                      <Money cents={p.savings_cents} />
                    </span>
                    <span className="font-medium">
                      Free to spend <Money cents={p.free_cents} tone />
                    </span>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {draft ? (
        <RecordDialog
          open
          onOpenChange={(o) => !o && setDraft(null)}
          title={editing ? `Edit ${editing.name}` : "Add fixed cost"}
          description="A bill that comes every month for roughly the same amount."
          onSubmit={save}
          pending={create.isPending || update.isPending}
          error={create.error ?? update.error}
        >
          <Field>
            <FieldLabel htmlFor="fc-name">Name</FieldLabel>
            <Input id="fc-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Mortgage, car loan, internet" />
          </Field>

          <MoneyField label="Amount" cents={draft.amount_cents} onChange={(c) => set({ amount_cents: c })} />

          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="fc-due">Due day</FieldLabel>
              <Input id="fc-due" type="number" min={0} max={31} value={draft.due_day} onChange={(e) => set({ due_day: e.target.value })} />
              <FieldDescription>0 means the last day.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="fc-lead">Days of lead time</FieldLabel>
              <Input id="fc-lead" type="number" min={0} max={31} value={draft.lead_days} onChange={(e) => set({ lead_days: e.target.value })} />
              <FieldDescription>How early the cash has to be sitting there.</FieldDescription>
            </Field>
          </div>

          <Field>
            <FieldLabel>Category</FieldLabel>
            <SelectField
              value={draft.category_id}
              onChange={(v) => set({ category_id: v })}
              options={[{ value: "none", label: "None" }, ...(categories.data ?? []).map((c) => ({
                  value: String(c.id),
                  label: <CategoryLabel name={c.name} icon={c.icon} />,
                }))]}
            />
            <FieldDescription>
              Matching imported transactions to a fixed-bucket category keeps them out of your spending total.
            </FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <Switch id="fc-active" checked={draft.active} onCheckedChange={(v) => set({ active: v })} />
            <FieldLabel htmlFor="fc-active">Active</FieldLabel>
          </Field>
        </RecordDialog>
      ) : null}
    </>
  );
}
