import { useState } from "react";
import { CATEGORY_ICONS, type Bucket, type CategoryIconName, type CategoryInput, type CategoryRuleInput } from "@lumpy/contracts";
import { DownloadIcon, PencilIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SelectField } from "@/components/app/controls";
import { CategoryIcon, CategoryLabel } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { AddButton, DeleteButton, RecordDialog } from "@/components/app/record-dialog";
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { eden, useApi, useMutate } from "@/lib/api";
import { BUCKET_HINT, BUCKET_LABEL, BUCKET_ORDER } from "@/lib/format";

const BUCKETS: { value: Bucket; label: string }[] = BUCKET_ORDER.map((value) => ({
  value,
  label: `${BUCKET_LABEL[value]} — ${BUCKET_HINT[value]}`,
}));

export default function Settings() {
  const categories = useApi(["categories"], () => eden.api.categories.get());
  const rules = useApi(["category-rules"], () => eden.api["category-rules"].get());
  const profiles = useApi(["import-profiles"], () => eden.api["import-profiles"].get());

  const createCategory = useMutate((body: CategoryInput) => eden.api.categories.post(body));
  const updateCategory = useMutate((v: { id: number; body: CategoryInput }) =>
    eden.api.categories({ id: v.id }).put(v.body));
  const removeCategory = useMutate((id: number) => eden.api.categories({ id }).delete());
  const createRule = useMutate((body: CategoryRuleInput) => eden.api["category-rules"].post(body));
  const removeRule = useMutate((id: number) => eden.api["category-rules"]({ id }).delete());
  const removeProfile = useMutate((id: number) => eden.api["import-profiles"]({ id }).delete());

  const [catDraft, setCatDraft] = useState<{ id: number | null; name: string; bucket: Bucket; icon: CategoryIconName | null } | null>(null);
  const [ruleDraft, setRuleDraft] = useState<{ pattern: string; category_id: string; priority: string } | null>(null);

  if (categories.isLoading) return <Loading />;
  if (categories.error) return <LoadError error={categories.error} />;

  const cats = categories.data ?? [];
  const catName = (id: number) => cats.find((c) => c.id === id)?.name ?? `#${id}`;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Categories, the rules that apply them, and saved import formats."
        actions={
          // A plain link: the server names the file and marks it an attachment, so
          // there is nothing for JavaScript to do here.
          <Button variant="outline" render={<a href="/api/export" />} nativeButton={false}>
            <DownloadIcon data-icon="inline-start" />
            Download a backup
          </Button>
        }
      />

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
                A mortgage payment in your statement is that fixed cost going out, not a second expense.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-3">
                <AddButton onClick={() => setCatDraft({ id: null, name: "", bucket: "discretionary", icon: null })}>
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
                      <TableCell className="font-medium">
                        <CategoryLabel name={c.name} icon={c.icon} />
                      </TableCell>
                      <TableCell>
                        <Badge variant={c.bucket === "discretionary" ? "default" : "secondary"}>{BUCKET_LABEL[c.bucket] ?? c.bucket}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit ${c.name}`}
                            onClick={() => setCatDraft({ id: c.id, name: c.name, bucket: c.bucket, icon: c.icon })}
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
                On import, a rule applies when its text appears in the merchant or description. If several match,
                the lowest priority number wins.
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
            const body = { name: catDraft.name, bucket: catDraft.bucket, icon: catDraft.icon, color: null };
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
              onChange={(bucket) => setCatDraft({ ...catDraft, bucket: bucket as Bucket })}
              options={BUCKETS}
            />
          </Field>

          <Field>
            <FieldLabel>Icon</FieldLabel>
            <div className="grid max-h-48 grid-cols-10 gap-1 overflow-y-auto rounded-md border p-2">
              {CATEGORY_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  aria-label={icon}
                  aria-pressed={catDraft.icon === icon}
                  title={icon}
                  className={cn(
                    "flex items-center justify-center rounded-md p-2 hover:bg-accent",
                    catDraft.icon === icon && "bg-accent ring-1 ring-ring",
                  )}
                  onClick={() =>
                    setCatDraft({ ...catDraft, icon: catDraft.icon === icon ? null : icon })
                  }
                >
                  <CategoryIcon name={icon} className={cn(catDraft.icon === icon && "text-foreground")} />
                </button>
              ))}
            </div>
            <FieldDescription>Click the selected icon again to clear it.</FieldDescription>
          </Field>
        </RecordDialog>
      ) : null}

      {ruleDraft ? (
        <RecordDialog
          open
          onOpenChange={(o) => !o && setRuleDraft(null)}
          title="Add rule"
          description="The rule matches the merchant and description together. Capital letters do not matter."
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
            <FieldDescription>The lowest number wins, so 10 beats 100.</FieldDescription>
          </Field>
        </RecordDialog>
      ) : null}
    </>
  );
}
