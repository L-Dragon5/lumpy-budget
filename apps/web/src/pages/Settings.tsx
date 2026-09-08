import { useRef, useState } from "react";
import {
  CATEGORY_ICONS,
  type Backup, type Bucket, type CategoryIconName, type CategoryInput, type CategoryRuleInput,
} from "@lumpy/contracts";
import { DownloadIcon, PencilIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SelectField } from "@/components/app/controls";
import { CategoryIcon, CategoryLabel } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { AddButton, DeleteButton, FormError, RecordDialog } from "@/components/app/record-dialog";
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { eden, errorText, useApi, useMutate } from "@/lib/api";
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
  const updateRule = useMutate((v: { id: number; body: CategoryRuleInput }) =>
    eden.api["category-rules"]({ id: v.id }).put(v.body));
  const removeRule = useMutate((id: number) => eden.api["category-rules"]({ id }).delete());
  const removeProfile = useMutate((id: number) => eden.api["import-profiles"]({ id }).delete());

  const [catDraft, setCatDraft] = useState<{ id: number | null; name: string; bucket: Bucket; icon: CategoryIconName | null } | null>(null);
  const [ruleDraft, setRuleDraft] = useState<
    { id: number | null; pattern: string; whole_word: boolean; category_id: string; priority: string } | null
  >(null);

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
          <div className="flex gap-2">
            {/* A plain link: the server names the file and marks it an attachment,
                so there is nothing for JavaScript to do here. */}
            <Button variant="outline" render={<a href="/api/export" />} nativeButton={false}>
              <DownloadIcon data-icon="inline-start" />
              Download a backup
            </Button>
            <RestoreButton />
          </div>
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
                the lowest priority number wins. A backup file from another machine can hand over its rules; each
                one lands on the local category of the same name, and any whose category you do not have is skipped.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex gap-2">
                <AddButton
                  onClick={() =>
                    setRuleDraft({
                      id: null, pattern: "", whole_word: false,
                      category_id: String(cats[0]?.id ?? ""), priority: "100",
                    })
                  }
                >
                  Add rule
                </AddButton>
                <MergeRulesButton />
              </div>
              <div className="max-h-[32rem] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>If the text contains</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Priority</TableHead>
                      <TableHead className="w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(rules.data ?? []).map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-sm">
                          {r.pattern}
                          {r.whole_word ? (
                            <Badge variant="secondary" className="ml-2 font-sans">whole word</Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>{catName(r.category_id)}</TableCell>
                        <TableCell className="text-right tabular text-muted-foreground">{r.priority}</TableCell>
                        <TableCell>
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${r.pattern}`}
                              onClick={() =>
                                setRuleDraft({
                                  id: r.id, pattern: r.pattern, whole_word: r.whole_word,
                                  category_id: String(r.category_id), priority: String(r.priority),
                                })
                              }
                            >
                              <PencilIcon />
                            </Button>
                            <DeleteButton label={r.pattern} onConfirm={() => removeRule.mutate(r.id)} />
                          </div>
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
              <CardDescription>
                Column mappings saved from the import wizard, one per bank or card. A backup file
                from another machine can hand over its formats without bringing its spending too.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-3">
                <MergeProfilesButton />
              </div>
              {(profiles.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None yet. Save one the next time you import a statement, or add them from a backup.
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
          title={ruleDraft.id ? "Edit rule" : "Add rule"}
          description="The rule matches the merchant and description together. Capital letters do not matter."
          onSubmit={() => {
            const body = {
              pattern: ruleDraft.pattern,
              whole_word: ruleDraft.whole_word,
              category_id: Number(ruleDraft.category_id),
              priority: Number(ruleDraft.priority),
            };
            const done = { onSuccess: () => setRuleDraft(null) };
            if (ruleDraft.id) updateRule.mutate({ id: ruleDraft.id, body }, done);
            else createRule.mutate(body, done);
          }}
          pending={createRule.isPending || updateRule.isPending}
          error={createRule.error ?? updateRule.error}
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
          <Field orientation="horizontal">
            <Switch
              id="rule-whole-word"
              checked={ruleDraft.whole_word}
              onCheckedChange={(whole_word) => setRuleDraft({ ...ruleDraft, whole_word })}
            />
            <div>
              <FieldLabel htmlFor="rule-whole-word">Match as a whole word</FieldLabel>
              <FieldDescription>
                On, <span className="font-mono">bp</span> finds BP #4021 and BP1234 but not BPOST. Off, it finds
                all three. Leave it off for a name a statement adds letters to, like{" "}
                <span className="font-mono">trader joe</span> in TRADER JOES.
              </FieldDescription>
            </div>
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

/** How many rows a picked file is about to write, for the confirmation. */
const rowCount = (b: Backup): number =>
  Object.values(b.tables ?? {}).reduce((n, t) => n + (Array.isArray(t) ? t.length : 0), 0);

/**
 * "Added Big Bank, updated Card." Named rather than counted, because which ones
 * it touched is the question you are actually asking. Empty when it touched none.
 */
function touched(added: string[], updated: string[]): string {
  const parts: string[] = [];
  if (added.length) parts.push(`Added ${added.join(", ")}`);
  if (updated.length) parts.push(`${parts.length ? "updated" : "Updated"} ${updated.join(", ")}`);
  return parts.length ? `${parts.join(", ")}.` : "";
}

/**
 * Read a picked file as a backup. Parsed here rather than posted raw so "that is
 * not a backup" is a local answer and the server only ever sees JSON.
 */
async function readBackup(file: File): Promise<Backup | null> {
  try {
    return JSON.parse(await file.text()) as Backup;
  } catch {
    return null;
  }
}

/**
 * A button that hands you a backup file. The input is hidden rather than
 * sr-only: a file input is its own button, and two buttons for one action is one
 * too many. click() still reaches it.
 */
function PickBackupButton({
  label, icon: Icon, onPick,
}: {
  label: string;
  icon: typeof UploadIcon;
  onPick: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file twice still fires a change event.
          e.target.value = "";
          if (file) onPick(file);
        }}
      />
      <Button variant="outline" onClick={() => input.current?.click()}>
        <Icon data-icon="inline-start" />
        {label}
      </Button>
    </>
  );
}

/**
 * Take only the saved import formats out of a backup file. Additive, so there is
 * nothing to confirm: a format you already have has its columns updated, the
 * rest are added, and everything else in the file is ignored.
 */
function MergeProfilesButton() {
  const merge = useMutate((body: Backup) => eden.api["import-profiles"].merge.post(body));

  const pick = async (file: File) => {
    const body = await readBackup(file);
    if (!body) return void toast.error(`${file.name} is not a file this can read.`);
    merge.mutate(body, {
      onSuccess: ({ added, updated }) => {
        const done = touched(added, updated);
        if (done) toast.success(done);
        else toast.info("That file has no import formats in it.");
      },
      onError: (error) => toast.error(errorText(error, "Could not read those formats.")),
    });
  };

  return <PickBackupButton label="Add from a backup" icon={UploadIcon} onPick={(f) => void pick(f)} />;
}

/**
 * The same trade for categorization rules. A rule points at a category, so the
 * file's categories go with it as a lookup and each rule is re-pointed at the
 * local category of the same name; one whose category is not here is reported
 * rather than silently dropped.
 */
function MergeRulesButton() {
  const merge = useMutate((body: Backup) => eden.api["category-rules"].merge.post(body));

  const pick = async (file: File) => {
    const body = await readBackup(file);
    if (!body) return void toast.error(`${file.name} is not a file this can read.`);
    merge.mutate(body, {
      onSuccess: ({ added, updated, skipped }) => {
        if (added.length + updated.length === 0 && skipped.length === 0)
          return toast.info("That file has no rules in it.");
        const done = touched(added, updated);
        // Skipped is the half you have to act on, so it gets its own toast with
        // the category names to create rather than a clause at the end of a line.
        if (done) toast.success(done);
        if (skipped.length > 0)
          toast.warning(
            `Skipped ${skipped.length} rule${skipped.length === 1 ? "" : "s"}: no category named ${
              [...new Set(skipped.map((r) => r.category))].join(", ")
            }.`,
          );
      },
      onError: (error) => toast.error(errorText(error, "Could not read those rules.")),
    });
  };

  return <PickBackupButton label="Add from a backup" icon={UploadIcon} onPick={(f) => void pick(f)} />;
}

/**
 * Load a downloaded backup, here or in another environment. It replaces every
 * table, so it asks first and says how many rows are in the file; the server
 * does the whole thing in one transaction, so a "no" from the validator or the
 * database leaves what is already here untouched.
 */
function RestoreButton() {
  const [picked, setPicked] = useState<{ name: string; body: Backup } | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const restore = useMutate((body: Backup) => eden.api.restore.post(body));

  const pick = async (file: File) => {
    setUnreadable(null);
    restore.reset();
    const body = await readBackup(file);
    if (body) setPicked({ name: file.name, body });
    else setUnreadable(`${file.name} is not a file this can read.`);
  };

  return (
    <>
      <PickBackupButton label="Restore a backup" icon={UploadIcon} onPick={(f) => void pick(f)} />

      <AlertDialog open={picked !== null || unreadable !== null} onOpenChange={(o) => {
        if (!o) { setPicked(null); setUnreadable(null); }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{unreadable ? "Could not read that file" : `Restore ${picked?.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {unreadable ?? (picked
                ? `This replaces everything in this environment with the ${rowCount(picked.body).toLocaleString()} rows in the file. Download a backup first if you want the current data back.`
                : null)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {restore.error ? <FormError error={restore.error} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{unreadable ? "Close" : "Cancel"}</AlertDialogCancel>
            {unreadable ? null : (
              // Not a Close: only a success clears `picked`, so a rejected file
              // keeps the dialog up with the reason on it.
              <AlertDialogAction
                disabled={restore.isPending || !picked}
                onClick={() =>
                  picked && restore.mutate(picked.body, {
                    onSuccess: (res) => {
                      setPicked(null);
                      toast.success(`Restored ${res.total.toLocaleString()} rows.`);
                    },
                  })
                }
              >
                {restore.isPending ? "Restoring..." : "Replace everything"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
