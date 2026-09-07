import { useState } from "react";
import type { SavingsGoal, SavingsGoalInput } from "@lumpy/contracts";
import type { GoalProgress } from "@lumpy/budget-core";
import { goalProgress, savingsBalanceTotal } from "@lumpy/budget-core";
import { CheckCircle2Icon, PencilIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SingleToggle } from "@/components/app/controls";
import { MoneyEditor } from "@/components/app/money-editor";
import { AddButton, DeleteButton, MoneyField, RecordDialog } from "@/components/app/record-dialog";
import { Money } from "@/components/app/money";
import { StatTile } from "@/components/app/stat-tile";
import { Loading, LoadError, MonthNav, PageHeader } from "@/components/app/page";
import { eden, useApi, useMutate } from "@/lib/api";
import { dateLabel, money, monthLabel, shiftMonth, thisMonth } from "@/lib/format";

type Draft = {
  name: string;
  mode: "fixed" | "percent";
  amount_cents: number | null;
  percent: string;
  target_cents: number | null;
  active: boolean;
};

const emptyDraft = (): Draft => ({
  name: "", mode: "fixed", amount_cents: null, percent: "10", target_cents: null, active: true,
});

const toDraft = (g: SavingsGoal): Draft => ({
  name: g.name,
  mode: g.mode,
  amount_cents: g.amount_cents,
  percent: g.percent === null ? "10" : String(g.percent),
  target_cents: g.target_cents,
  active: g.active,
});

/** The balance is never edited through this form: it has its own editor on the card. */
const toBody = (d: Draft, balance_cents: number) => ({
  name: d.name,
  mode: d.mode,
  amount_cents: d.mode === "fixed" ? (d.amount_cents ?? 0) : null,
  percent: d.mode === "percent" ? Number(d.percent) : null,
  target_cents: d.target_cents,
  balance_cents,
  active: d.active,
});

export default function Savings() {
  const [month, setMonth] = useState(thisMonth());
  const goals = useApi(["savings-goals"], () => eden.api["savings-goals"].get());
  const summary = useApi(["summary", month], () => eden.api.summary.get({ query: { month } }));
  const create = useMutate((body: SavingsGoalInput) => eden.api["savings-goals"].post(body));
  const update = useMutate((v: { id: number; body: SavingsGoalInput }) =>
    eden.api["savings-goals"]({ id: v.id }).put(v.body));
  const remove = useMutate((id: number) => eden.api["savings-goals"]({ id }).delete());

  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingBalance, setEditingBalance] = useState<number | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = () => {
    if (!draft) return;
    const done = { onSuccess: () => setDraft(null) };
    const body = toBody(draft, editing?.balance_cents ?? 0);
    if (editing) update.mutate({ id: editing.id, body }, done);
    else create.mutate(body, done);
  };

  const saveBalance = (g: SavingsGoal, balance_cents: number) =>
    new Promise<void>((resolve) =>
      update.mutate(
        { id: g.id, body: toBody(toDraft(g), balance_cents) },
        { onSettled: () => { setEditingBalance(null); resolve(); } },
      ),
    );

  if (goals.isLoading || summary.isLoading) return <Loading />;
  if (goals.error) return <LoadError error={goals.error} />;
  if (summary.error) return <LoadError error={summary.error} />;

  const rows = goals.data ?? [];
  const s = summary.data!;
  const progress = goalProgress(rows, s.income_cents);
  const totalBalance = savingsBalanceTotal(rows);
  const totalTarget = progress.reduce((a, p) => a + (p.target_cents ?? 0), 0);
  const paychecks = s.paychecks.filter((p) => !p.prior_month);

  return (
    <>
      <PageHeader
        title="Savings"
        description="Each goal is its own bucket, with its own balance and its own finish line."
        actions={
          <>
            <MonthNav month={month} onChange={setMonth} />
            <AddButton onClick={() => { setEditing(null); setDraft(emptyDraft()); }}>Add goal</AddButton>
          </>
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={`Saving in ${monthLabel(month)}`}
          cents={s.savings_cents}
          caption={`${((s.savings_cents / Math.max(1, s.income_cents)) * 100).toFixed(1)}% of this month's income`}
        />
        <StatTile
          label="Across every bucket"
          cents={totalBalance}
          tone="muted"
          caption={
            totalTarget > 0
              ? `${((totalBalance / totalTarget) * 100).toFixed(0)}% of ${money(totalTarget, { cents: false })} in targets`
              : "No targets set yet."
          }
        />
        <StatTile label="Income this month" cents={s.income_cents} tone="muted" caption="What percent goals are measured against." />
        <StatTile
          label="Left after everything"
          cents={s.planned_free_cents}
          tone={s.planned_free_cents < 0 ? "critical" : "good"}
          caption="Income minus bills, lumpy fund and savings."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          {rows.length === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No savings goals</EmptyTitle>
                    <EmptyDescription>
                      An emergency fund, a down payment, a vacation. Give each one a target and it tells you when
                      it gets there.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          ) : (
            progress.map((p) => (
              <GoalCard
                key={p.goal.id}
                progress={p}
                month={month}
                editingBalance={editingBalance === p.goal.id}
                onEditBalance={() => setEditingBalance(p.goal.id)}
                onCancelBalance={() => setEditingBalance(null)}
                onSaveBalance={(cents) => saveBalance(p.goal, cents)}
                onEdit={() => { setEditing(p.goal); setDraft(toDraft(p.goal)); }}
                onDelete={() => remove.mutate(p.goal.id)}
              />
            ))
          )}
          {rows.filter((g) => !g.active).length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {rows.filter((g) => !g.active).length} inactive goal(s) holding{" "}
              <Money cents={savingsBalanceTotal(rows.filter((g) => !g.active))} /> are not shown.
            </p>
          ) : null}
        </div>

        <Card className="h-fit">
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
            <MoneyField label="Amount per month" cents={draft.amount_cents} onChange={(c) => set({ amount_cents: c })} />
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

          <MoneyField
            label="Target"
            cents={draft.target_cents}
            required={false}
            onChange={(c) => set({ target_cents: c })}
            description="Leave empty for an open-ended fund. With a target, the bucket shows how far along it is and when it gets there."
          />

          <Field orientation="horizontal">
            <Switch id="sg-active" checked={draft.active} onCheckedChange={(v) => set({ active: v })} />
            <FieldLabel htmlFor="sg-active">Active</FieldLabel>
          </Field>
        </RecordDialog>
      ) : null}
    </>
  );
}

function GoalCard({
  progress: p,
  month,
  editingBalance,
  onEditBalance,
  onCancelBalance,
  onSaveBalance,
  onEdit,
  onDelete,
}: {
  progress: GoalProgress;
  month: string;
  editingBalance: boolean;
  onEditBalance: () => void;
  onCancelBalance: () => void;
  onSaveBalance: (cents: number) => Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { goal, pct } = p;
  // The bar caps at the finish line; the label above it carries the real number,
  // so an overfunded bucket reads as 125% rather than as merely full.
  const barValue = pct === null ? 0 : Math.min(100, pct);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              {goal.name}
              {p.funded ? (
                <Badge variant="secondary">
                  <CheckCircle2Icon data-icon="inline-start" />
                  Funded
                </Badge>
              ) : null}
            </CardTitle>
            <CardDescription>
              {goal.mode === "fixed" ? "Fixed amount" : `${goal.percent}% of income`} ·{" "}
              <Money cents={p.monthly_cents} /> in {monthLabel(month)}
            </CardDescription>
          </div>
          <div className="flex">
            <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`Edit ${goal.name}`}>
              <PencilIcon />
            </Button>
            <DeleteButton label={goal.name} onConfirm={onDelete} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <Money cents={p.balance_cents} className="text-2xl font-semibold" />
          {p.target_cents !== null ? (
            <span className="text-sm text-muted-foreground">
              of <Money cents={p.target_cents} className="text-foreground" />
              {pct !== null ? <span className="ml-2 tabular font-medium text-foreground">{pct.toFixed(0)}%</span> : null}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">No target</span>
          )}
        </div>

        {p.target_cents !== null ? (
          <Progress
            value={barValue}
            style={{ ["--progress-color" as string]: p.funded ? "var(--good)" : "var(--chart-1)" }}
          />
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            {p.target_cents === null ? (
              <>Open-ended — the balance is the whole story.</>
            ) : p.funded ? (
              <>
                Fully funded, <Money cents={p.balance_cents - p.target_cents} className="text-foreground" /> over.
              </>
            ) : p.months_to_target === null ? (
              <>
                <Money cents={p.remaining_cents} className="text-foreground" /> to go, with nothing going in.
              </>
            ) : (
              <>
                <Money cents={p.remaining_cents} className="text-foreground" /> to go —{" "}
                <span className="text-foreground">{monthLabel(shiftMonth(month, p.months_to_target))}</span> at this
                rate.
              </>
            )}
          </span>
          {!editingBalance ? (
            <Button variant="ghost" size="sm" className="text-xs" onClick={onEditBalance}>
              Update balance
            </Button>
          ) : null}
        </div>

        {editingBalance ? (
          <MoneyEditor
            cents={p.balance_cents}
            label={`${goal.name} balance`}
            onCancel={onCancelBalance}
            onSave={onSaveBalance}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
