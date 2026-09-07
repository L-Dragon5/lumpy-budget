import { useRef, useState } from "react";
import type { Expense, ExpenseInput } from "@lumpy/contracts";
import { monthEnd, monthStart } from "@lumpy/budget-core";
import { SearchIcon, UploadIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SelectField } from "@/components/app/controls";
import { ImportWizard } from "@/components/app/import-wizard";
import { Money } from "@/components/app/money";
import { AddButton, DeleteButton, MoneyField, RecordDialog } from "@/components/app/record-dialog";
import { Loading, LoadError, MonthNav, PageHeader } from "@/components/app/page";
import { CategoryLabel } from "@/lib/icons";
import { eden, useApi, useMutate } from "@/lib/api";
import { dateLabelFull, thisMonth } from "@/lib/format";

const ALL = "__all__";
const UNCATEGORIZED = "none";

type Draft = { txn_date: string; amount_cents: number | null; merchant: string; description: string; category_id: string };

export default function Expenses() {
  const [month, setMonth] = useState(thisMonth());
  const [category, setCategory] = useState(ALL);
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);

  const query = {
    start: monthStart(month),
    end: monthEnd(month),
    limit: 2000,
    ...(category === ALL ? {} : { category_id: category === "none" ? ("none" as const) : Number(category) }),
    ...(search.trim() ? { q: search.trim() } : {}),
  };

  const expenses = useApi(["expenses", query], () => eden.api.expenses.get({ query }));
  const categories = useApi(["categories"], () => eden.api.categories.get());
  const batches = useApi(["import-batches"], () => eden.api["import-batches"].get());
  const create = useMutate((body: ExpenseInput) => eden.api.expenses.post(body));
  const update = useMutate((v: { id: number; body: ExpenseInput }) =>
    eden.api.expenses({ id: v.id }).put(v.body));
  const remove = useMutate((id: number) => eden.api.expenses({ id }).delete());
  const removeBatch = useMutate((id: number) => eden.api["import-batches"]({ id }).delete());

  const [draft, setDraft] = useState<Draft | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const rows = expenses.data ?? [];
  const cats = categories.data ?? [];
  const total = rows.reduce((a, e) => a + e.amount_cents, 0);
  const uncategorized = rows.filter((e) => e.category_id === null).length;

  const categoryOptions = [
    { value: ALL, label: "All categories" },
    { value: UNCATEGORIZED, label: "Uncategorized" },
    ...cats.map((c) => ({ value: String(c.id), label: <CategoryLabel name={c.name} icon={c.icon} /> })),
  ];

  /** Writes are whole-row PUTs, so every inline edit goes through one body. */
  const patch = (e: Expense, changes: Partial<Expense>) =>
    update.mutate({
      id: e.id,
      body: {
        txn_date: e.txn_date,
        amount_cents: e.amount_cents,
        merchant: e.merchant,
        description: e.description,
        category_id: e.category_id,
        source: e.source,
        ...changes,
      },
    });

  if (categories.isLoading) return <Loading />;
  if (expenses.error) return <LoadError error={expenses.error} />;

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Everything that has actually been spent. Import a statement or add one by hand."
        actions={
          <>
            <MonthNav month={month} onChange={setMonth} />
            <Button variant="outline" onClick={() => setImporting(true)}>
              <UploadIcon data-icon="inline-start" />
              Import CSV
            </Button>
            <AddButton
              onClick={() =>
                setDraft({ txn_date: `${month}-01`, amount_cents: null, merchant: "", description: "", category_id: UNCATEGORIZED })
              }
            >
              Add expense
            </AddButton>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <InputGroup className="w-64">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Merchant or description"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </InputGroup>
        <SelectField value={category} onChange={setCategory} options={categoryOptions} className="w-56" />
        <div className="ml-auto flex items-center gap-3 text-sm">
          <Badge variant="secondary">{rows.length} transactions</Badge>
          {uncategorized > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setCategory(UNCATEGORIZED)}>
              {uncategorized} uncategorized
            </Button>
          ) : null}
          <span className="text-muted-foreground">
            Total <Money cents={total} className="font-medium text-foreground" />
          </span>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {expenses.isLoading ? (
            <Loading rows={5} />
          ) : rows.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing here</EmptyTitle>
                <EmptyDescription>
                  No transactions match this month and these filters. Import a statement to fill it in.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Date</TableHead>
                    <TableHead className="w-56">Category</TableHead>
                    <TableHead>Merchant</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead className="w-28 text-right">Amount</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-sm text-muted-foreground">{dateLabelFull(e.txn_date)}</TableCell>
                      <TableCell>
                        <SelectField
                          value={e.category_id === null ? UNCATEGORIZED : String(e.category_id)}
                          onChange={(v) => patch(e, { category_id: v === UNCATEGORIZED ? null : Number(v) })}
                          options={categoryOptions.filter((o) => o.value !== ALL)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{e.merchant}</TableCell>
                      <TableCell>
                        <NoteCell
                          key={`${e.id}-${e.description}`}
                          note={e.description}
                          merchant={e.merchant}
                          onSave={(description) => patch(e, { description })}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money cents={e.amount_cents} className={e.amount_cents < 0 ? "text-[var(--good)]" : undefined} />
                      </TableCell>
                      <TableCell>
                        <DeleteButton label={e.merchant} onConfirm={() => remove.mutate(e.id)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {(batches.data ?? []).length > 0 ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Imports</CardTitle>
            <CardDescription>Deleting an import removes every transaction that came in with it.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Added</TableHead>
                  <TableHead className="text-right">Skipped as duplicates</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(batches.data ?? []).map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium">{b.filename}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(b.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">{b.inserted}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{b.skipped}</TableCell>
                    <TableCell>
                      <DeleteButton label={b.filename} onConfirm={() => removeBatch.mutate(b.id)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <ImportWizard open={importing} onOpenChange={setImporting} />

      {draft ? (
        <RecordDialog
          open
          onOpenChange={(o) => !o && setDraft(null)}
          title="Add expense"
          description="Spending is positive; a refund is negative."
          onSubmit={() =>
            create.mutate(
              {
                txn_date: draft.txn_date,
                amount_cents: draft.amount_cents ?? 0,
                merchant: draft.merchant,
                description: draft.description,
                category_id: draft.category_id === UNCATEGORIZED ? null : Number(draft.category_id),
                source: "manual",
              },
              { onSuccess: () => setDraft(null) },
            )
          }
          pending={create.isPending}
          error={create.error}
        >
          <Field>
            <FieldLabel htmlFor="ex-date">Date</FieldLabel>
            <Input id="ex-date" type="date" value={draft.txn_date} onChange={(e) => set({ txn_date: e.target.value })} />
          </Field>
          <MoneyField label="Amount" cents={draft.amount_cents} onChange={(c) => set({ amount_cents: c })} />
          <Field>
            <FieldLabel htmlFor="ex-merchant">Merchant</FieldLabel>
            <Input id="ex-merchant" value={draft.merchant} onChange={(e) => set({ merchant: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ex-desc">Note</FieldLabel>
            <Input id="ex-desc" value={draft.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel>Category</FieldLabel>
            <SelectField
              value={draft.category_id}
              onChange={(v) => set({ category_id: v })}
              options={categoryOptions.filter((o) => o.value !== ALL)}
            />
          </Field>
        </RecordDialog>
      ) : null}
    </>
  );
}

/**
 * The note is edited in place: click it, type, Enter or click away to keep it,
 * Escape to drop the change. An empty note still needs something to click, so it
 * shows a muted prompt rather than an invisible cell.
 */
function NoteCell({
  note,
  merchant,
  onSave,
}: {
  note: string;
  merchant: string;
  onSave: (note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const abandoned = useRef(false);

  const commit = () => {
    setEditing(false);
    if (abandoned.current) {
      abandoned.current = false;
      setDraft(note);
      return;
    }
    const next = draft.trim();
    if (next !== note) onSave(next);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="w-full truncate rounded-sm px-1 py-0.5 text-left text-sm hover:bg-accent"
        aria-label={`Note for ${merchant}`}
        onClick={() => {
          setDraft(note);
          setEditing(true);
        }}
      >
        {note ? note : <span className="text-muted-foreground">Add note</span>}
      </button>
    );
  }

  return (
    <Input
      autoFocus
      value={draft}
      aria-label={`Note for ${merchant}`}
      className="h-7"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          abandoned.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
