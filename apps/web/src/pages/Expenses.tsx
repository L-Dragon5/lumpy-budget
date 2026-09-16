import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { Expense, ExpenseInput } from "@lumpy/contracts";
import { SPENDING, bucketOf, categoryIndex, monthEnd, monthStart, totalsByBucket } from "@lumpy/budget-core";
import { applyRules, suggestRule } from "@lumpy/csv-import";
import { SearchIcon, SplitIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { SplitDialog } from "@/components/app/split-dialog";
import { Loading, LoadError, MonthNav, PageHeader } from "@/components/app/page";
import { CategoryLabel } from "@/lib/icons";
import { ApiError, eden, errorText, useApi, useMutate } from "@/lib/api";
import { dateLabelFull, monthParam, thisMonth } from "@/lib/format";

const ALL = "__all__";
const NOT_SPENDING =
  "Card payments, transfers between your own accounts, and income. Not spending, so not in the total.";
const UNCATEGORIZED = "none";

type Draft = { txn_date: string; amount_cents: number | null; merchant: string; description: string; category_id: string };

export default function Expenses() {
  // Read once, on arrival: a link can open the page on a month and on the
  // uncategorized queue (the income page sends a short month here). After that
  // the controls own both.
  const [params] = useSearchParams();
  const [month, setMonth] = useState(() => monthParam(params.get("month")) ?? thisMonth());
  const [category, setCategory] = useState(() => (params.get("category") === UNCATEGORIZED ? UNCATEGORIZED : ALL));
  const [search, setSearch] = useState("");
  const [showNonSpending, setShowNonSpending] = useState(false);
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
  const rules = useApi(["category-rules"], () => eden.api["category-rules"].get());
  const create = useMutate((body: ExpenseInput) => eden.api.expenses.post(body));
  const update = useMutate((v: { id: number; body: ExpenseInput }) =>
    eden.api.expenses({ id: v.id }).put(v.body));
  const remove = useMutate((id: number) => eden.api.expenses({ id }).delete());
  const removeBatch = useMutate((id: number) => eden.api["import-batches"]({ id }).delete());
  const [splitting, setSplitting] = useState<Expense | null>(null);
  const unsplit = useMutate((id: number) => eden.api.expenses({ id }).split.delete());

  const [draft, setDraft] = useState<Draft | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const all = expenses.data ?? [];
  const cats = categories.data ?? [];
  // The same definition every report totals with: a card payment or a transfer
  // between your own accounts is not spending (the charges it pays were already
  // counted on the day they happened), and a paycheck is money arriving.
  const totals = totalsByBucket(all, cats);
  const notSpending = totals.transfer + totals.income;
  const byId = categoryIndex(cats);
  const isSpending = (e: Expense) => SPENDING.includes(bucketOf(e, byId));
  // Those rows are not in the total, so by default they are not in the list
  // either -- a card payment is the biggest number on the page and says
  // nothing about the month. Asking for one category shows that category
  // whatever bucket it is in, which is the only way to look at them.
  const hiding = category === ALL && !showNonSpending;
  const rows = hiding ? all.filter(isSpending) : all;
  // Counted over every row: an uncategorized credit is hidden by the line
  // above, and the queue is how you find it.
  const uncategorized = all.filter((e) => e.category_id === null).length;

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

  /**
   * Writes the rule, then lets it loose on everything already imported that is
   * still uncategorized. A rule only ran at import time, so without this second
   * half the rule you just wrote fixes next month and leaves the six rows that
   * prompted it sitting there. Resolves to how many of those moved.
   */
  const makeRule = useMutate(async (v: { pattern: string; category_id: number }) => {
    const created = await eden.api["category-rules"].post({ pattern: v.pattern, category_id: v.category_id });
    if (created.error) throw ApiError.from(created.error);
    const stale = await eden.api.expenses.get({ query: { category_id: "none" as const, limit: 5000 } });
    if (stale.error) throw ApiError.from(stale.error);
    // The importer's own categorizer, so a row moves here exactly when the same
    // row would have arrived categorized.
    const hits = applyRules(stale.data, [created.data]).filter((e) => e.category_id !== null);
    for (const e of hits) {
      const moved = await eden.api.expenses({ id: e.id }).put({
        txn_date: e.txn_date,
        amount_cents: e.amount_cents,
        merchant: e.merchant,
        description: e.description,
        category_id: e.category_id,
        source: e.source,
      });
      if (moved.error) throw ApiError.from(moved.error);
    }
    return { data: hits.length, error: null, status: 200 };
  });

  /**
   * Categorizing a row by hand is the one moment both halves of a rule are
   * known, and the only moment you are looking at the merchant. Offered, never
   * written: the pattern is on the button and nothing happens until it is
   * pressed. Nothing is offered when a rule already covers the row.
   */
  const offerRule = (e: Expense, categoryId: number) => {
    const pattern = suggestRule(e, rules.data ?? []);
    if (pattern === null) return;
    const name = cats.find((c) => c.id === categoryId)?.name ?? "that category";
    toast(`Always ${name} for "${pattern}"?`, {
      description: "Categorizes it on every future import, and fixes the ones already imported.",
      duration: 12000,
      action: {
        label: "Make rule",
        onClick: () =>
          makeRule.mutate(
            { pattern, category_id: categoryId },
            {
              onSuccess: (moved) =>
                toast.success(
                  moved === 0
                    ? `"${pattern}" is ${name} from now on.`
                    : `"${pattern}" is ${name}, and ${moved} older ${moved === 1 ? "transaction" : "transactions"} moved with it.`,
                ),
              onError: (error) => toast.error(errorText(error, "Could not add that rule.")),
            },
          ),
      },
    });
  };

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
            Spent <Money cents={totals.total} className="font-medium text-foreground" />
          </span>
          {notSpending === 0 ? null : category !== ALL ? (
            <span className="text-muted-foreground" title={NOT_SPENDING}>
              <Money cents={notSpending} /> not spending
            </span>
          ) : (
            <Button variant="ghost" size="sm" title={NOT_SPENDING} onClick={() => setShowNonSpending((v) => !v)}>
              <Money cents={notSpending} /> not spending{hiding ? ", hidden" : ""}
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-3">
            <AddButton
              onClick={() =>
                setDraft({ txn_date: `${month}-01`, amount_cents: null, merchant: "", description: "", category_id: UNCATEGORIZED })
              }
            >
              Add expense
            </AddButton>
          </div>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Date</TableHead>
                  <TableHead className="w-56">Category</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead className="w-64">Note</TableHead>
                  <TableHead className="w-28 text-right">Amount</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-sm text-muted-foreground">{dateLabelFull(e.txn_date)}</TableCell>
                    <TableCell>
                      <SelectField
                        value={e.category_id === null ? UNCATEGORIZED : String(e.category_id)}
                        onChange={(v) => {
                          const next = v === UNCATEGORIZED ? null : Number(v);
                          patch(e, { category_id: next });
                          // Only on the way out of uncategorized: fixing a
                          // miscategorized row is not a new rule, it is a
                          // correction, and offering there would nag.
                          if (next !== null && e.category_id === null) offerRule(e, next);
                        }}
                        options={categoryOptions.filter((o) => o.value !== ALL)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {e.merchant}
                      {/* So a $120 row does not read as a $120 charge. */}
                      {e.parent_id !== null ? (
                        <Badge variant="secondary" className="ml-2 text-[10px]">part of a split</Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-64">
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
                      <div className="flex items-center justify-end">
                        {e.parent_id === null ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSplitting(e)}
                            aria-label={`Split ${e.merchant}`}
                          >
                            <SplitIcon />
                          </Button>
                        ) : (
                          <UnsplitButton
                            merchant={e.merchant}
                            disabled={unsplit.isPending}
                            onConfirm={() => unsplit.mutate(e.parent_id!)}
                          />
                        )}
                        <DeleteButton label={e.merchant} onConfirm={() => remove.mutate(e.id)} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

      {splitting ? (
        <SplitDialog
          expense={splitting}
          categories={categories.data ?? []}
          onClose={() => setSplitting(null)}
        />
      ) : null}

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
        // Two lines, then an ellipsis. `whitespace-normal` undoes the
        // nowrap TableCell puts on every cell, which line-clamp needs.
        className="line-clamp-2 w-full rounded-sm px-1 py-0.5 text-left text-xs break-words whitespace-normal hover:bg-accent"
        title={note || undefined}
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

/**
 * Unsplit throws away every part's category and note, which nothing can bring
 * back, so it asks first -- the same way deleting a row does.
 */
function UnsplitButton({ merchant, disabled, onConfirm }: { merchant: string; disabled: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="ghost" size="sm" className="text-xs" disabled={disabled}>
            Unsplit
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsplit {merchant}?</AlertDialogTitle>
          <AlertDialogDescription>
            The charge goes back to being one row. Every part is removed, along with the category and note you gave it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Unsplit</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
