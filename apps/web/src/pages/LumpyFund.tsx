import { useState } from "react";
import { Link } from "react-router";
import type { LumpyItem, LumpyItemInput } from "@lumpy/contracts";
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
import { CategoryLabel } from "@/lib/icons";
import { AddButton, DeleteButton, MoneyField, RecordDialog } from "@/components/app/record-dialog";
import { Money } from "@/components/app/money";
import { BalanceTile } from "@/components/app/balance-tile";
import { StatTile } from "@/components/app/stat-tile";
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { ApiError, eden, errorText, useApi, useInvalidateAll, useMutate } from "@/lib/api";
import { CYCLE_LABEL, dateLabelFull, merchantTitle, money, monthLabel, thisMonth } from "@/lib/format";


type Draft = {
  name: string;
  amount_cents: number | null;
  frequency_months: string;
  next_due_date: string;
  category_id: string;
  merchant_pattern: string;
  merchant_whole_word: boolean;
  active: boolean;
};

const CYCLES = [1, 3, 6, 12, 24];

const emptyDraft = (): Draft => ({
  name: "", amount_cents: null, frequency_months: "12", next_due_date: "", category_id: "none",
  merchant_pattern: "", merchant_whole_word: false, active: true,
});

const toDraft = (i: LumpyItem): Draft => ({
  name: i.name,
  amount_cents: i.amount_cents,
  frequency_months: String(i.frequency_months),
  next_due_date: i.next_due_date,
  category_id: i.category_id === null ? "none" : String(i.category_id),
  merchant_pattern: i.merchant_pattern ?? "",
  merchant_whole_word: i.merchant_whole_word,
  active: i.active,
});

const toBody = (d: Draft) => ({
  name: d.name,
  amount_cents: d.amount_cents ?? 0,
  frequency_months: Number(d.frequency_months),
  next_due_date: d.next_due_date,
  category_id: d.category_id === "none" ? null : Number(d.category_id),
  // Under two characters is not a pattern, it is a needle that matches half the
  // statement; the API says so with a 422, so an empty box has to mean null.
  merchant_pattern: d.merchant_pattern.trim().length >= 2 ? d.merchant_pattern.trim() : null,
  merchant_whole_word: d.merchant_whole_word,
  active: d.active,
});

export default function LumpyFund() {
  const month = thisMonth();
  const items = useApi(["lumpy-items"], () => eden.api["lumpy-items"].get());
  const categories = useApi(["categories"], () => eden.api.categories.get());
  const timeline = useApi(["lumpy-timeline", month], () =>
    eden.api["lumpy-timeline"].get({ query: { start: month, months: 12 } }));
  const drift = useApi(["lumpy-drift"], () => eden.api["lumpy-drift"].get());
  const found = useApi(["recurring-candidates"], () => eden.api["recurring-candidates"].get());
  const paid = useApi(["lumpy-paid"], () => eden.api["lumpy-paid"].get());
  const create = useMutate((body: LumpyItemInput) => eden.api["lumpy-items"].post(body));
  const update = useMutate((v: { id: number; body: LumpyItemInput }) =>
    eden.api["lumpy-items"]({ id: v.id }).put(v.body));
  const remove = useMutate((id: number) => eden.api["lumpy-items"]({ id }).delete());

  const [editing, setEditing] = useState<LumpyItem | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const invalidate = useInvalidateAll();
  const [paying, setPaying] = useState<number | null>(null);
  const [payError, setPayError] = useState<unknown>(null);

  /**
   * Record a payment the statement already proves: roll the item to its next
   * occurrence and take the charge out of the fund's balance.
   *
   * Two writes rather than one route, because both of them already exist and a
   * new endpoint would only be a transaction around a number that a person types
   * in by hand anyway. If the second fails the first still happened, and the page
   * says so -- with the balance still showing what the account really holds,
   * which is the safer half to be stale.
   */
  const markPaid = async (row: NonNullable<typeof paid.data>["rows"][number]) => {
    setPaying(row.item.id);
    setPayError(null);
    try {
      const { id: _id, ...rest } = row.item;
      const rolled = await eden.api["lumpy-items"]({ id: row.item.id }).put({
        ...rest,
        next_due_date: row.rolls_to,
      });
      if (rolled.error) throw ApiError.from(rolled.error);
      const saved = await eden.api.settings.put({
        name: "lumpy_opening_balance_cents",
        value: String(row.balance_after_cents),
      });
      if (saved.error) throw ApiError.from(saved.error);
      invalidate();
    } catch (e) {
      setPayError(e);
    } finally {
      setPaying(null);
    }
  };

  // A detected cycle the list has no word for still has to be selectable, or the
  // dropdown opens blank on a suggestion of, say, every four months.
  const cycleOptions = [...new Set([...CYCLES, Number(draft?.frequency_months ?? 12)])].sort((a, b) => a - b);

  const applySuggestion = (c: NonNullable<typeof found.data>["rows"][number]) => {
    setEditing(null);
    setDraft({
      name: merchantTitle(c.name),
      amount_cents: c.amount_cents,
      frequency_months: String(c.frequency_months),
      next_due_date: c.next_due_date,
      category_id: c.category_id === null ? "none" : String(c.category_id),
      // The first word of the key the charges were grouped on, which is the part
      // of the name a statement does not decorate. Not the whole key: that is
      // built from the *normalized* merchant, and "GEICO AUTO" is not a substring
      // of "GEICO *AUTO 8829" while "geico" is. It is a prefill in a form nobody
      // can save without looking at, which is the only reason a guess is allowed
      // to be here at all.
      merchant_pattern: c.key.split(" ")[0] ?? "",
      merchant_whole_word: false,
      active: true,
    });
  };

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
  // rows[0] is the current month, so rows[1] is what the fund has to cover next.
  const nextMonth = timeline.data?.rows[1];
  const drifted = drift.data?.total_cents ?? 0;
  const suggestions = found.data?.rows ?? [];
  const payments = paid.data?.rows ?? [];

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
              ? `Includes catch-up. Once you are on schedule it would be ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(steady / 100)}.`
              : "You are on schedule. This is the flat monthly amount."
          }
        />
        <BalanceTile
          settingKey="lumpy_opening_balance_cents"
          label="In the fund now"
          caption={
            // The schedule rolls a passed due date forward on its own; this number
            // cannot. Saying what has left the account since you last typed it in is
            // the difference between a stale balance and a silently wrong one.
            drifted > 0 ? (
              <span className="text-destructive">
                <Money cents={drifted} /> left the fund since you set this on{" "}
                {dateLabelFull(drift.data!.since)}. Check the account.
              </span>
            ) : (
              "What the savings account behind this fund actually holds."
            )
          }
          editCaption="Whatever the account says right now. The 12-month timeline starts from it."
        />
        <StatTile
          label="Leaves next month"
          cents={nextMonth?.outflow_cents ?? 0}
          tone="muted"
          caption={
            nextMonth
              ? nextMonth.due.length > 0
                ? `${monthLabel(nextMonth.month)}: ${nextMonth.due.map((d) => d.name).join(", ")}`
                : `Nothing comes due in ${monthLabel(nextMonth.month)}.`
              : "No timeline yet."
          }
        />
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

      {payments.length > 0 ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Looks like {payments.length === 1 ? "this was" : "these were"} paid</CardTitle>
            <CardDescription>
              A charge matching the item landed near its due date, so the money has left the fund and the
              schedule has not moved. Recording it rolls the item to its next occurrence and takes the
              charge off the balance. Nothing happens until you press it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Charge</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead>Rolls to</TableHead>
                  <TableHead className="text-right">Fund after</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((row) => (
                  <TableRow key={row.item.id}>
                    <TableCell>
                      <div className="font-medium">{row.item.name}</div>
                      <div className="text-xs text-muted-foreground">
                        was due {dateLabelFull(row.due_date)}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {merchantTitle(row.expense.merchant)}
                      <span className="block text-xs text-muted-foreground">
                        {dateLabelFull(row.expense.txn_date)}
                        {row.days_off === 0
                          ? " (on the day)"
                          : ` (${Math.abs(row.days_off)} day${Math.abs(row.days_off) === 1 ? "" : "s"} ${row.days_off > 0 ? "late" : "early"})`}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Money cents={row.expense.amount_cents} />
                      {/* The bill going up is the second thing this finds, and the
                          reason the amount is worth showing next to the plan. */}
                      {row.delta_cents !== 0 ? (
                        <div className="text-xs text-muted-foreground">
                          planned {money(row.item.amount_cents, { cents: false })}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{dateLabelFull(row.rolls_to)}</TableCell>
                    <TableCell className="text-right">
                      <Money cents={row.balance_after_cents} />
                      {row.balance_after_cents < 0 ? (
                        <div className="text-xs text-destructive">more than the fund holds</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={paying !== null}
                          onClick={() => markPaid(row)}
                        >
                          {paying === row.item.id ? "Recording..." : "Record payment"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {payError ? <p className="mt-3 text-sm text-destructive">{errorText(payError)}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      {suggestions.length > 0 ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Found in your statements</CardTitle>
            <CardDescription>
              Charges that have arrived on a cycle longer than a month and are not in the fund or on the fixed
              costs page. Nothing is added until you say so: Add opens the form filled in, and every field is
              still yours to change.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Charge</TableHead>
                  <TableHead>Seen</TableHead>
                  <TableHead>Cycle</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Per year</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {suggestions.map((c) => (
                  <TableRow key={c.key}>
                    <TableCell>
                      <div className="font-medium">{merchantTitle(c.name)}</div>
                      {/* The merchants actually seen, so a suggestion that grouped
                          two different things is visible rather than trusted. */}
                      <div className="text-xs text-muted-foreground">{c.merchants.join(", ")}</div>
                    </TableCell>
                    {/* The count and the last one, not every date: a quarterly bill
                        across three years is twelve dates and one useful fact. */}
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {c.occurrences.length} times, last {dateLabelFull(c.last_date)}
                      {c.regular ? null : <span className="block text-xs">spacing varies by a month</span>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {CYCLE_LABEL(c.frequency_months)}
                      <span className="block text-xs text-muted-foreground">next {dateLabelFull(c.next_due_date)}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Money cents={c.amount_cents} />
                      {c.typical_cents !== c.amount_cents ? (
                        <div className="text-xs text-muted-foreground">
                          was {money(c.typical_cents, { cents: false })} on average
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      <Money cents={c.annual_cents} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button variant="outline" size="sm" onClick={() => applySuggestion(c)}>
                          Add
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
              options={cycleOptions.map((m) => ({ value: String(m), label: CYCLE_LABEL(m) }))}
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
              options={[{ value: "none", label: "None" }, ...(categories.data ?? []).map((c) => ({
                  value: String(c.id),
                  label: <CategoryLabel name={c.name} icon={c.icon} />,
                }))]}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="lf-merchant">Shows up on the statement as</FieldLabel>
            <Input
              id="lf-merchant"
              value={draft.merchant_pattern}
              onChange={(e) => set({ merchant_pattern: e.target.value })}
              placeholder="GEICO"
            />
            <FieldDescription>
              Optional, and any part of the name will do. Fill it in and the app can find the payment in
              your imported statements and offer to roll this item forward, instead of you remembering to.
            </FieldDescription>
          </Field>

          {/* Only worth asking once there is a pattern for it to change. */}
          {draft.merchant_pattern.trim().length >= 2 ? (
            <Field orientation="horizontal">
              <Switch
                id="lf-whole-word"
                checked={draft.merchant_whole_word}
                onCheckedChange={(v) => set({ merchant_whole_word: v })}
              />
              <div>
                <FieldLabel htmlFor="lf-whole-word">Match as a whole word</FieldLabel>
                <FieldDescription>
                  On, <span className="font-mono">bp</span> matches BP #4021 and BP1234 but not BPOST.
                  Leave it off for a name a statement adds letters to.
                </FieldDescription>
              </div>
            </Field>
          ) : null}

          <Field orientation="horizontal">
            <Switch id="lf-active" checked={draft.active} onCheckedChange={(v) => set({ active: v })} />
            <FieldLabel htmlFor="lf-active">Active</FieldLabel>
          </Field>
        </RecordDialog>
      ) : null}
    </>
  );
}
