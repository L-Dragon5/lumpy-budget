import { useState } from "react";
import type { Category, Expense, ImportBatch } from "@lumpy/contracts";
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
import { useApi, useCreate, useDelete, useUpdate } from "@/lib/api";
import { dateLabelFull, thisMonth } from "@/lib/format";

const ALL = "__all__";
const UNCATEGORIZED = "none";

type Draft = { txn_date: string; amount_cents: number | null; merchant: string; description: string; category_id: string };

export default function Expenses() {
  const [month, setMonth] = useState(thisMonth());
  const [category, setCategory] = useState(ALL);
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);

  const params = new URLSearchParams({ start: monthStart(month), end: monthEnd(month), limit: "2000" });
  if (category !== ALL) params.set("category_id", category);
  if (search.trim()) params.set("q", search.trim());

  const expenses = useApi<Expense[]>(`/api/expenses?${params}`);
  const categories = useApi<Category[]>("/api/categories");
  const batches = useApi<ImportBatch[]>("/api/import-batches");
  const create = useCreate("expenses");
  const update = useUpdate("expenses");
  const remove = useDelete("expenses");
  const removeBatch = useDelete("import-batches");

  const [draft, setDraft] = useState<Draft | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const rows = expenses.data ?? [];
  const cats = categories.data ?? [];
  const total = rows.reduce((a, e) => a + e.amount_cents, 0);
  const uncategorized = rows.filter((e) => e.category_id === null).length;

  const categoryOptions = [
    { value: ALL, label: "All categories" },
    { value: UNCATEGORIZED, label: "Uncategorized" },
    ...cats.map((c) => ({ value: String(c.id), label: c.name })),
  ];

  const recategorize = (e: Expense, value: string) =>
    update.mutate({
      id: e.id,
      body: {
        txn_date: e.txn_date,
        amount_cents: e.amount_cents,
        merchant: e.merchant,
        description: e.description,
        category_id: value === UNCATEGORIZED ? null : Number(value),
        source: e.source,
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
                  No transactions match this month and filter. Import a statement to fill it in.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Date</TableHead>
                    <TableHead>Merchant</TableHead>
                    <TableHead className="w-56">Category</TableHead>
                    <TableHead className="w-28 text-right">Amount</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-sm text-muted-foreground">{dateLabelFull(e.txn_date)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{e.merchant}</div>
                        {e.description ? <div className="text-xs text-muted-foreground">{e.description}</div> : null}
                      </TableCell>
                      <TableCell>
                        <SelectField
                          value={e.category_id === null ? UNCATEGORIZED : String(e.category_id)}
                          onChange={(v) => recategorize(e, v)}
                          options={categoryOptions.filter((o) => o.value !== ALL)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money cents={e.amount_cents} tone={e.amount_cents < 0} />
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
