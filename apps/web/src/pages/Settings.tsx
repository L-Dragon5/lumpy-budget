import { useState } from "react";
import type { Category, CategoryRule, ImportProfile } from "@lumpy/contracts";
import { PencilIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SelectField } from "@/components/app/controls";
import { AddButton, DeleteButton, RecordDialog } from "@/components/app/record-dialog";
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { useApi, useCreate, useDelete, useUpdate } from "@/lib/api";

const BUCKETS = [
  { value: "discretionary", label: "Discretionary — counts against what you can spend" },
  { value: "fixed", label: "Fixed — a monthly bill being paid" },
  { value: "lumpy", label: "Lumpy — paid out of the lumpy fund" },
  { value: "savings", label: "Savings — money moved, not spent" },
  { value: "transfer", label: "Transfer — card payments, moving money around" },
];

export default function Settings() {
  const categories = useApi<Category[]>("/api/categories");
  const rules = useApi<CategoryRule[]>("/api/category-rules");
  const profiles = useApi<ImportProfile[]>("/api/import-profiles");

  const createCategory = useCreate("categories");
  const updateCategory = useUpdate("categories");
  const removeCategory = useDelete("categories");
  const createRule = useCreate("category-rules");
  const removeRule = useDelete("category-rules");
  const removeProfile = useDelete("import-profiles");

  const [catDraft, setCatDraft] = useState<{ id: number | null; name: string; bucket: string } | null>(null);
  const [ruleDraft, setRuleDraft] = useState<{ pattern: string; category_id: string; priority: string } | null>(null);

  if (categories.isLoading) return <Loading />;
  if (categories.error) return <LoadError error={categories.error} />;

  const cats = categories.data ?? [];
  const catName = (id: number) => cats.find((c) => c.id === id)?.name ?? `#${id}`;

  return (
    <>
      <PageHeader title="Settings" description="Categories, the rules that apply them, and saved import formats." />

      <Tabs defaultValue="categories">
        <TabsList>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="imports">Import formats</TabsTrigger>
        </TabsList>

        <TabsContent value="categories">
          <Card>
            <CardHeader>
              <CardTitle>Categories</CardTitle>
              <CardDescription>
                The bucket is what matters: only <strong>discretionary</strong> spending reduces what is available.
                A mortgage payment landing in your statement is the fixed cost being paid, not a second expense.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-3">
                <AddButton onClick={() => setCatDraft({ id: null, name: "", bucket: "discretionary" })}>
                  Add category
                </AddButton>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Bucket</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cats.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>
                        <Badge variant={c.bucket === "discretionary" ? "default" : "secondary"}>{c.bucket}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit ${c.name}`}
                            onClick={() => setCatDraft({ id: c.id, name: c.name, bucket: c.bucket })}
                          >
                            <PencilIcon />
                          </Button>
                          <DeleteButton label={c.name} onConfirm={() => removeCategory.mutate(c.id)} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules">
          <Card>
            <CardHeader>
              <CardTitle>Categorization rules</CardTitle>
              <CardDescription>
                On import, the first rule whose text appears in the merchant or description wins. Lower priority
                numbers are checked first.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-3">
                <AddButton
                  onClick={() => setRuleDraft({ pattern: "", category_id: String(cats[0]?.id ?? ""), priority: "100" })}
                >
                  Add rule
                </AddButton>
              </div>
              <div className="max-h-[32rem] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>If the text contains</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Priority</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(rules.data ?? []).map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-sm">{r.pattern}</TableCell>
                        <TableCell>{catName(r.category_id)}</TableCell>
                        <TableCell className="text-right tabular text-muted-foreground">{r.priority}</TableCell>
                        <TableCell>
                          <DeleteButton label={r.pattern} onConfirm={() => removeRule.mutate(r.id)} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="imports">
          <Card>
            <CardHeader>
              <CardTitle>Saved import formats</CardTitle>
              <CardDescription>Column mappings saved from the import wizard, one per bank or card.</CardDescription>
            </CardHeader>
            <CardContent>
              {(profiles.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None yet. Save one the next time you import a statement.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Date column</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(profiles.data ?? []).map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {p.mapping.date_column} ({p.mapping.date_format})
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {p.mapping.amount_column ?? `${p.mapping.debit_column ?? "?"} / ${p.mapping.credit_column ?? "?"}`}
                          {p.mapping.flip_sign ? " (flipped)" : ""}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{p.mapping.merchant_column}</TableCell>
                        <TableCell>
                          <DeleteButton label={p.name} onConfirm={() => removeProfile.mutate(p.id)} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>

      {catDraft ? (
        <RecordDialog
          open
          onOpenChange={(o) => !o && setCatDraft(null)}
          title={catDraft.id ? "Edit category" : "Add category"}
          onSubmit={() => {
            const body = { name: catDraft.name, bucket: catDraft.bucket, color: null };
            const done = { onSuccess: () => setCatDraft(null) };
            if (catDraft.id) updateCategory.mutate({ id: catDraft.id, body }, done);
            else createCategory.mutate(body, done);
          }}
          pending={createCategory.isPending || updateCategory.isPending}
          error={createCategory.error ?? updateCategory.error}
        >
          <Field>
            <FieldLabel htmlFor="cat-name">Name</FieldLabel>
            <Input
              id="cat-name"
              value={catDraft.name}
              onChange={(e) => setCatDraft({ ...catDraft, name: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel>Bucket</FieldLabel>
            <SelectField
              value={catDraft.bucket}
              onChange={(bucket) => setCatDraft({ ...catDraft, bucket })}
              options={BUCKETS}
            />
          </Field>
        </RecordDialog>
      ) : null}

      {ruleDraft ? (
        <RecordDialog
          open
          onOpenChange={(o) => !o && setRuleDraft(null)}
          title="Add rule"
          description="Case-insensitive; matched against the merchant and description together."
          onSubmit={() =>
            createRule.mutate(
              {
                pattern: ruleDraft.pattern,
                category_id: Number(ruleDraft.category_id),
                priority: Number(ruleDraft.priority),
              },
              { onSuccess: () => setRuleDraft(null) },
            )
          }
          pending={createRule.isPending}
          error={createRule.error}
        >
          <Field>
            <FieldLabel htmlFor="rule-pattern">Text to look for</FieldLabel>
            <Input
              id="rule-pattern"
              value={ruleDraft.pattern}
              onChange={(e) => setRuleDraft({ ...ruleDraft, pattern: e.target.value })}
              placeholder="wegmans"
            />
          </Field>
          <Field>
            <FieldLabel>Category</FieldLabel>
            <SelectField
              value={ruleDraft.category_id}
              onChange={(category_id) => setRuleDraft({ ...ruleDraft, category_id })}
              options={cats.map((c) => ({ value: String(c.id), label: c.name }))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="rule-priority">Priority</FieldLabel>
            <Input
              id="rule-priority"
              type="number"
              value={ruleDraft.priority}
              onChange={(e) => setRuleDraft({ ...ruleDraft, priority: e.target.value })}
            />
            <FieldDescription>Checked lowest first, so 10 beats 100.</FieldDescription>
          </Field>
        </RecordDialog>
      ) : null}
    </>
  );
}
