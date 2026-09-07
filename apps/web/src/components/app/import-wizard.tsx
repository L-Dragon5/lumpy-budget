import { useMemo, useState } from "react";
import type { Category, CategoryRule, ImportMapping, ImportProfile } from "@lumpy/contracts";
import { applyRules, guessMapping, normalize, parseCsv, type ParsedCsv } from "@lumpy/csv-import";
import { CheckCircle2Icon, FileTextIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SelectField } from "@/components/app/controls";
import { Money } from "@/components/app/money";
import { FormError } from "@/components/app/record-dialog";
import { api, useApi, useInvalidateAll } from "@/lib/api";

const NONE = "__none__";

/**
 * The file is parsed in the browser and posted as normalized rows: one parse, no
 * upload plumbing, and the server still validates every row it stores.
 */
export function ImportWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const categories = useApi<Category[]>("/api/categories");
  const rules = useApi<CategoryRule[]>("/api/category-rules");
  const profiles = useApi<ImportProfile[]>("/api/import-profiles");
  const invalidate = useInvalidateAll();

  const [filename, setFilename] = useState("");
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [rawText, setRawText] = useState("");
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [profileId, setProfileId] = useState<string>(NONE);
  const [profileName, setProfileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ inserted: number; skipped: number } | null>(null);

  const reset = () => {
    setCsv(null); setMapping(null); setFilename(""); setRawText("");
    setProfileId(NONE); setProfileName(""); setError(null); setDone(null);
  };

  const loadFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseCsv(text);
    setRawText(text);
    setFilename(file.name);
    setCsv(parsed);
    setMapping(guessMapping(parsed));
    setProfileName(file.name.replace(/\.csv$/i, ""));
    setDone(null);
    setError(null);
  };

  // Re-parse whenever skip_rows changes: the header row moves with it.
  const effectiveCsv = useMemo(() => {
    if (!csv || !mapping) return csv;
    return mapping.skip_rows > 0 ? parseCsv(rawText, mapping.skip_rows) : csv;
  }, [csv, rawText, mapping?.skip_rows]);

  const result = useMemo(() => {
    if (!effectiveCsv || !mapping) return null;
    const { rows, errors } = normalize(effectiveCsv, mapping, "import");
    const categorized = applyRules(rows, rules.data ?? []);
    return { rows: categorized, errors };
  }, [effectiveCsv, mapping, rules.data]);

  const categoryName = (id: number | null) =>
    id === null ? null : (categories.data ?? []).find((c) => c.id === id)?.name ?? null;

  const commit = async () => {
    if (!result || result.rows.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let savedProfileId: number | null = profileId === NONE ? null : Number(profileId);
      if (profileName.trim() && profileId === NONE && mapping) {
        const created = await api.post<ImportProfile>("/api/import-profiles", {
          name: profileName.trim(),
          mapping,
        }).catch(() => null); // A name clash just means we reuse nothing; the import still runs.
        savedProfileId = created?.id ?? null;
      }
      const res = await api.post<{ inserted: number; skipped: number }>("/api/import", {
        filename: filename || "import.csv",
        profile_id: savedProfileId,
        rows: result.rows,
      });
      setDone(res);
      invalidate();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const columnOptions = (effectiveCsv?.headers ?? []).map((h) => ({ value: h, label: h }));
  const optionalColumns = [{ value: NONE, label: "None" }, ...columnOptions];
  const uncategorized = result?.rows.filter((r) => r.category_id === null).length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Import a statement</DialogTitle>
          <DialogDescription>
            Any CSV a bank or card will export. Nothing is saved until you press Import.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col gap-4 py-4">
            <Alert>
              <CheckCircle2Icon />
              <AlertTitle>Imported {done.inserted} transactions</AlertTitle>
              <AlertDescription>
                {done.skipped > 0
                  ? `${done.skipped} were already in the ledger and were skipped.`
                  : "Nothing was a duplicate."}
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Import another
              </Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : !csv ? (
          <div className="flex flex-col gap-4 py-6">
            <Field>
              <FieldLabel htmlFor="csv-file">CSV file</FieldLabel>
              <Input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadFile(file);
                }}
              />
              <FieldDescription>
                Chase, Amex, Capital One and plain bank exports all work. Columns are matched automatically and
                you can correct them on the next step.
              </FieldDescription>
            </Field>
            {(profiles.data ?? []).length > 0 ? (
              <p className="text-sm text-muted-foreground">
                <FileTextIcon className="mr-1 inline size-3.5" />
                Saved formats: {(profiles.data ?? []).map((p) => p.name).join(", ")}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {(profiles.data ?? []).length > 0 ? (
              <Field>
                <FieldLabel>Use a saved format</FieldLabel>
                <SelectField
                  value={profileId}
                  onChange={(v) => {
                    setProfileId(v);
                    const p = (profiles.data ?? []).find((x) => String(x.id) === v);
                    if (p) setMapping(p.mapping);
                  }}
                  options={[
                    { value: NONE, label: "Detect from the file" },
                    ...(profiles.data ?? []).map((p) => ({ value: String(p.id), label: p.name })),
                  ]}
                />
              </Field>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field>
                <FieldLabel>Date column</FieldLabel>
                <SelectField
                  value={mapping?.date_column ?? ""}
                  onChange={(v) => setMapping((m) => (m ? { ...m, date_column: v } : m))}
                  options={columnOptions}
                />
              </Field>
              <Field>
                <FieldLabel>Date format</FieldLabel>
                <SelectField
                  value={mapping?.date_format ?? "auto"}
                  onChange={(v) => setMapping((m) => (m ? { ...m, date_format: v as ImportMapping["date_format"] } : m))}
                  options={["auto", "YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "MM-DD-YYYY", "DD-MM-YYYY"].map((v) => ({
                    value: v,
                    label: v === "auto" ? "Detect" : v,
                  }))}
                />
              </Field>
              <Field>
                <FieldLabel>Merchant column</FieldLabel>
                <SelectField
                  value={mapping?.merchant_column ?? ""}
                  onChange={(v) => setMapping((m) => (m ? { ...m, merchant_column: v } : m))}
                  options={columnOptions}
                />
              </Field>
              <Field>
                <FieldLabel>Amount column</FieldLabel>
                <SelectField
                  value={mapping?.amount_column ?? NONE}
                  onChange={(v) =>
                    setMapping((m) => (m ? { ...m, amount_column: v === NONE ? null : v } : m))
                  }
                  options={optionalColumns}
                />
                <FieldDescription>Leave as None if the file splits debit and credit.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Debit column</FieldLabel>
                <SelectField
                  value={mapping?.debit_column ?? NONE}
                  onChange={(v) => setMapping((m) => (m ? { ...m, debit_column: v === NONE ? null : v } : m))}
                  options={optionalColumns}
                />
              </Field>
              <Field>
                <FieldLabel>Credit column</FieldLabel>
                <SelectField
                  value={mapping?.credit_column ?? NONE}
                  onChange={(v) => setMapping((m) => (m ? { ...m, credit_column: v === NONE ? null : v } : m))}
                  options={optionalColumns}
                />
              </Field>
              <Field>
                <FieldLabel>Extra detail column</FieldLabel>
                <SelectField
                  value={mapping?.description_column ?? NONE}
                  onChange={(v) => setMapping((m) => (m ? { ...m, description_column: v === NONE ? null : v } : m))}
                  options={optionalColumns}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skip">Header rows to skip</FieldLabel>
                <Input
                  id="skip"
                  type="number"
                  min={0}
                  max={50}
                  value={mapping?.skip_rows ?? 0}
                  onChange={(e) => setMapping((m) => (m ? { ...m, skip_rows: Number(e.target.value) || 0 } : m))}
                />
              </Field>
              <Field orientation="horizontal">
                <Switch
                  id="flip"
                  checked={mapping?.flip_sign ?? false}
                  onCheckedChange={(v) => setMapping((m) => (m ? { ...m, flip_sign: v } : m))}
                />
                <FieldLabel htmlFor="flip">Spending is negative in this file</FieldLabel>
              </Field>
            </div>

            {result && result.errors.length > 0 ? (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>{result.errors.length} row(s) could not be read and will be skipped</AlertTitle>
                <AlertDescription>
                  {result.errors.slice(0, 4).map((e) => `line ${e.row}: ${e.message} ("${e.value}")`).join("; ")}
                  {result.errors.length > 4 ? ` and ${result.errors.length - 4} more` : ""}
                </AlertDescription>
              </Alert>
            ) : null}

            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary">{result?.rows.length ?? 0} to import</Badge>
                {uncategorized > 0 ? <Badge variant="outline">{uncategorized} uncategorized</Badge> : null}
                <span className="text-muted-foreground">Showing the first 8 rows as they will be saved.</span>
              </div>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(result?.rows ?? []).slice(0, 8).map((r, i) => (
                      <TableRow key={`${r.txn_date}-${r.merchant}-${i}`}>
                        <TableCell>{r.txn_date}</TableCell>
                        <TableCell className="max-w-64 truncate">{r.merchant}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {categoryName(r.category_id) ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={r.amount_cents} tone />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            {profileId === NONE ? (
              <Field>
                <FieldLabel htmlFor="profile-name">Save this column mapping as</FieldLabel>
                <Input
                  id="profile-name"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="Chase Sapphire"
                />
                <FieldDescription>Next month's statement from the same bank is then one click.</FieldDescription>
              </Field>
            ) : null}

            {error ? <FormError error={error} /> : null}

            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Choose a different file
              </Button>
              <Button onClick={commit} disabled={busy || (result?.rows.length ?? 0) === 0}>
                Import {result?.rows.length ?? 0} transactions
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
