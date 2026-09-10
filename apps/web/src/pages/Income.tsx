import { useState } from "react";
import { Link } from "react-router";
import { PER_YEAR, type Frequency, type IncomeStream, type IncomeStreamInput } from "@lumpy/contracts";
import { PencilIcon, SparklesIcon } from "lucide-react";
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
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { eden, useApi, useMutate } from "@/lib/api";
import { FREQUENCY_LABEL, monthLabel, ordinal, thisMonth } from "@/lib/format";

type Draft = {
  name: string;
  amount_cents: number | null;
  frequency: Frequency;
  anchor_date: string;
  day_1: string;
  day_2: string;
  day_of_month: string;
  active: boolean;
};

const emptyDraft = (): Draft => ({
  name: "",
  amount_cents: null,
  frequency: "biweekly",
  anchor_date: "",
  day_1: "15",
  day_2: "0",
  day_of_month: "1",
  active: true,
});

const toDraft = (s: IncomeStream): Draft => ({
  name: s.name,
  amount_cents: s.amount_cents,
  frequency: s.frequency,
  anchor_date: s.anchor_date ?? "",
  day_1: s.day_1 === null ? "15" : String(s.day_1),
  day_2: s.day_2 === null ? "0" : String(s.day_2),
  day_of_month: s.day_of_month === null ? "1" : String(s.day_of_month),
  active: s.active,
});

const toBody = (d: Draft) => ({
  name: d.name,
  amount_cents: d.amount_cents ?? 0,
  frequency: d.frequency,
  anchor_date: d.anchor_date || null,
  day_1: d.frequency === "semimonthly" ? Number(d.day_1) : null,
  day_2: d.frequency === "semimonthly" ? Number(d.day_2) : null,
  day_of_month: d.frequency === "monthly" ? Number(d.day_of_month) : null,
  active: d.active,
});

/** Plain English for however this stream actually pays. */
function scheduleText(s: IncomeStream): string {
  switch (s.frequency) {
    case "weekly":
    case "biweekly":
      return s.anchor_date ? `From ${s.anchor_date}` : "No anchor date";
    case "semimonthly":
      return `On the ${ordinal(s.day_1 ?? 0)} and ${ordinal(s.day_2 ?? 0)}`;
    case "monthly":
      return `On the ${ordinal(s.day_of_month ?? 0)}`;
    case "annual":
      return s.anchor_date ? `Every ${s.anchor_date.slice(5)}` : "No anchor date";
    case "one_time":
      return s.anchor_date ? `Once, on ${s.anchor_date}` : "No date";
  }
}

export default function Income() {
  const year = Number(thisMonth().slice(0, 4));
  const streams = useApi(["income-streams"], () => eden.api["income-streams"].get());
  const calendar = useApi(["income-calendar", year], () =>
    eden.api["income-calendar"].get({ query: { year } }));
  const create = useMutate((body: IncomeStreamInput) => eden.api["income-streams"].post(body));
  const update = useMutate((v: { id: number; body: IncomeStreamInput }) =>
    eden.api["income-streams"]({ id: v.id }).put(v.body));
  const remove = useMutate((id: number) => eden.api["income-streams"]({ id }).delete());

  const [editing, setEditing] = useState<IncomeStream | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const openNew = () => {
    setEditing(null);
    setDraft(emptyDraft());
  };
  const openEdit = (s: IncomeStream) => {
    setEditing(s);
    setDraft(toDraft(s));
  };
  const save = () => {
    if (!draft) return;
    const body = toBody(draft);
    const done = { onSuccess: () => setDraft(null) };
    if (editing) update.mutate({ id: editing.id, body }, done);
    else create.mutate(body, done);
  };

  if (streams.isLoading || calendar.isLoading) return <Loading />;
  if (streams.error) return <LoadError error={streams.error} />;
  if (calendar.error) return <LoadError error={calendar.error} />;

  const rows = streams.data ?? [];
  const months = calendar.data?.months ?? [];
  const normalized = months[0]?.normalized_cents ?? 0;
  const extras = months.filter((m) => m.extra_paycheck);
  // The surplus column only holds its width in a year that has one to show; a
  // semimonthly year never does, and the deposited column needs the room.
  const anySurplus = months.some((m) => m.surplus_cents > 0);

  return (
    <>
      <PageHeader
        title="Income"
        description="Every stream, normalized to a monthly figure, with the months that pay an extra time."
        actions={<AddButton onClick={openNew}>Add income</AddButton>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Streams</CardTitle>
            <CardDescription>
              <Money cents={normalized} /> a month on average across all active streams.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No income yet</EmptyTitle>
                  <EmptyDescription>
                    Add a paycheck, rental income, or a one-off like a gift or a savings withdrawal.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead className="text-right">Per payment</TableHead>
                    <TableHead className="text-right">Per month</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => {
                    const perYear = PER_YEAR[s.frequency];
                    return (
                      <TableRow key={s.id} className={s.active ? "" : "opacity-50"}>
                        <TableCell>
                          <div className="font-medium">{s.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {FREQUENCY_LABEL[s.frequency]}
                            {s.active ? "" : " · inactive"}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{scheduleText(s)}</TableCell>
                        <TableCell className="text-right">
                          <Money cents={s.amount_cents} />
                        </TableCell>
                        <TableCell className="text-right">
                          {/* A one-off has no per-month figure; showing $0 next to
                              a $2,000 gift reads as a bug rather than as "never repeats". */}
                          {s.frequency === "one_time" ? (
                            <span className="text-muted-foreground">once</span>
                          ) : (
                            <Money cents={Math.round((s.amount_cents * perYear) / 12)} />
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end">
                            <Button variant="ghost" size="icon" onClick={() => openEdit(s)} aria-label={`Edit ${s.name}`}>
                              <PencilIcon />
                            </Button>
                            <DeleteButton label={s.name} onConfirm={() => remove.mutate(s.id)} />
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

        <Card>
          <CardHeader>
            <CardTitle>{year}</CardTitle>
            <CardDescription>
              {extras.length > 0 ? (
                <>
                  <SparklesIcon className="mr-1 inline size-3.5" />
                  {extras.length} month{extras.length === 1 ? "" : "s"} pay more than the average. That surplus is
                  the money to send at the lumpy fund.
                </>
              ) : (
                "No extra-paycheck months this year. Only weekly and every-2-weeks pay can produce one."
              )}
              {" "}Each month also shows what the statements actually deposited,
              and the gap. A month with no statement imported says so instead of
              reporting a paycheck as missing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1">
              {months.map((m) => (
                <li
                  key={m.month}
                  className={`grid grid-cols-[auto_1fr] items-center gap-x-3 rounded-md px-2 py-1.5 text-sm ${
                    m.extra_paycheck ? "bg-accent font-medium" : ""
                  }`}
                >
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    {monthLabel(m.month, true)}
                    {m.extra_paycheck ? <Badge variant="secondary">extra</Badge> : null}
                  </span>
                  <span className="flex items-center justify-end gap-3">
                    <Money cents={m.total_cents} className="text-sm" />
                    {/* Only the surplus is worth calling out: every other month
                        is just the average, and a red minus on nine of twelve
                        months reads as a problem when nothing is wrong. */}
                    {m.surplus_cents > 0 ? (
                      <Money cents={m.surplus_cents} sign tone className="w-24 text-right text-xs" />
                    ) : anySurplus ? (
                      <span className="w-24" />
                    ) : null}
                  </span>
                  {/* What the bank says, against what the schedules assumed, on a
                      line of its own so a phone-width card never has to fit four
                      amounts across. A month nobody imported is silent: a red
                      -$2,400 there is a missing statement wearing the face of a
                      missing paycheck, and the two need opposite responses. */}
                  <span className="col-start-2 flex items-center justify-end gap-2 text-xs font-normal text-muted-foreground">
                    {m.imported ? (
                      <>
                        deposited <Money cents={m.deposited_cents} className="text-xs" />
                        {m.delta_cents !== 0 ? <Money cents={m.delta_cents} sign tone className="text-xs" /> : null}
                      </>
                    ) : (
                      "not imported"
                    )}
                  </span>
                  {/* A short month with an uncategorized credit in it may be
                      short only on paper: the cheque came in under a descriptor
                      no rule knew. Said here so the gap reads as a job on the
                      expenses page, not as a paycheck that never came. The link
                      cannot carry the month: the expenses page keeps its month
                      and category filters as component state, not in the URL,
                      so it opens on the current month and the title names the
                      one to step back to. */}
                  {m.imported && m.delta_cents < 0 && m.uncategorized_credit_cents > 0 ? (
                    <span className="col-start-2 flex items-center justify-end gap-1 text-xs font-normal text-muted-foreground">
                      <Money cents={m.uncategorized_credit_cents} className="text-xs" /> uncategorized:
                      <Link
                        className="underline underline-offset-2 hover:text-foreground"
                        to="/expenses"
                        title={`On Expenses, go to ${monthLabel(m.month)} and filter to uncategorized`}
                      >
                        categorize {m.uncategorized_credit_count === 1 ? "it" : "them"}
                      </Link>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {draft ? (
        <RecordDialog
          open
          onOpenChange={(o) => !o && setDraft(null)}
          title={editing ? `Edit ${editing.name}` : "Add income"}
          description="How much arrives, and when."
          onSubmit={save}
          pending={create.isPending || update.isPending}
          error={create.error ?? update.error}
        >
          <Field>
            <FieldLabel htmlFor="income-name">Name</FieldLabel>
            <Input
              id="income-name"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Day job, rental, birthday gift"
            />
          </Field>

          <MoneyField
            label={draft.frequency === "one_time" ? "Amount" : "Amount per payment"}
            cents={draft.amount_cents}
            onChange={(c) => set({ amount_cents: c })}
            description="Take-home, not gross. This is money that actually lands."
          />

          <Field>
            <FieldLabel>How often</FieldLabel>
            <SelectField
              value={draft.frequency}
              onChange={(v) => set({ frequency: v as Frequency })}
              options={Object.entries(FREQUENCY_LABEL).map(([value, label]) => ({ value, label }))}
            />
          </Field>

          {draft.frequency === "weekly" ||
          draft.frequency === "biweekly" ||
          draft.frequency === "annual" ||
          draft.frequency === "one_time" ? (
            <Field>
              <FieldLabel htmlFor="anchor">
                {draft.frequency === "annual" || draft.frequency === "one_time" ? "Date it arrives" : "Next pay date"}
              </FieldLabel>
              <Input
                id="anchor"
                type="date"
                value={draft.anchor_date}
                onChange={(e) => set({ anchor_date: e.target.value })}
              />
              <FieldDescription>
                {draft.frequency === "one_time"
                  ? "It counts in that month only, as surplus. It does not lift the monthly average."
                  : draft.frequency === "biweekly"
                    ? "Pay dates count forward and back from this date. That is what sets the extra-paycheck months."
                    : "Any known payment date works. The schedule counts from it."}
              </FieldDescription>
            </Field>
          ) : null}

          {draft.frequency === "semimonthly" ? (
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="day1">First pay day</FieldLabel>
                <Input id="day1" type="number" min={0} max={31} value={draft.day_1} onChange={(e) => set({ day_1: e.target.value })} />
                <FieldDescription>0 means the last day.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="day2">Second pay day</FieldLabel>
                <Input id="day2" type="number" min={0} max={31} value={draft.day_2} onChange={(e) => set({ day_2: e.target.value })} />
                <FieldDescription>0 means the last day.</FieldDescription>
              </Field>
            </div>
          ) : null}

          {draft.frequency === "monthly" ? (
            <Field>
              <FieldLabel htmlFor="dom">Day of the month</FieldLabel>
              <Input id="dom" type="number" min={0} max={31} value={draft.day_of_month} onChange={(e) => set({ day_of_month: e.target.value })} />
              <FieldDescription>0 means the last day. The 31st becomes the 30th or 28th in shorter months.</FieldDescription>
            </Field>
          ) : null}

          <Field orientation="horizontal">
            <Switch id="active" checked={draft.active} onCheckedChange={(v) => set({ active: v })} />
            <FieldLabel htmlFor="active">Active</FieldLabel>
          </Field>
        </RecordDialog>
      ) : null}
    </>
  );
}
