import { useState } from "react";
import type { CategoryProposal, UncategorizedMerchant } from "@lumpy/contracts";
import { SparklesIcon, WandSparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SelectField } from "@/components/app/controls";
import { Money } from "@/components/app/money";
import { Loading, LoadError, PageHeader } from "@/components/app/page";
import { CategoryLabel } from "@/lib/icons";
import { eden, errorText, useApi, useMutate } from "@/lib/api";
import { dateLabel, merchantTitle } from "@/lib/format";

/**
 * The backlog, one row per merchant, with a model's opinion filled in where it
 * had one.
 *
 * Three deliberate shapes here. The page renders from the backlog and overlays
 * the proposals, so a merchant the model could not answer is still a row a
 * person can settle by hand -- nothing is only visible because a model saw it.
 * A row with no category is a row that is skipped, which is why there is no
 * accept column: clearing the select is the skip. And rules are one switch for
 * the whole page rather than one per row, because a rule for a merchant seen
 * once is a rule that will never fire again.
 */

const SKIP = "";
/** A confidence below this is a row worth reading rather than scrolling past. */
const UNSURE = 0.5;

type Decision = { category_id: string; from_model: boolean; confidence: number; reason: string };

export default function Categorize() {
  const backlog = useApi(["uncategorized-merchants"], () => eden.api["uncategorized-merchants"].get());
  const categories = useApi(["categories"], () => eden.api.categories.get());

  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [writeRules, setWriteRules] = useState(true);
  const [model, setModel] = useState("");

  const classify = useMutate(() => eden.api.classify.post({}));
  const apply = useMutate((assignments: { merchant: string; category_id: number; make_rule: boolean }[]) =>
    eden.api.expenses.categorize.post({ assignments }),
  );

  const rows = backlog.data ?? [];
  const cats = categories.data ?? [];

  // ponytail: rebuilt every render. Twenty-six options is not a memo.
  const options = [
    { value: SKIP, label: <span className="text-muted-foreground">Skip</span> },
    ...cats.map((c) => ({ value: String(c.id), label: <CategoryLabel name={c.name} icon={c.icon} /> })),
  ];

  const set = (merchant: string, category_id: string) =>
    setDecisions((d) => ({
      ...d,
      // Touching the select makes the row a person's answer, not a model's: the
      // badge goes away with the opinion it was describing.
      [merchant]: { category_id, from_model: false, confidence: 1, reason: "" },
    }));

  const chosen = rows
    .map((r) => ({ row: r, decision: decisions[r.merchant] }))
    .filter((x): x is { row: UncategorizedMerchant; decision: Decision } => !!x.decision && x.decision.category_id !== SKIP);

  const ask = () =>
    classify.mutate(undefined, {
      onSuccess: (res) => {
        setModel(res.model);
        setDecisions((d) => {
          const next = { ...d };
          for (const p of res.proposals as CategoryProposal[]) {
            // A row a person already answered is never overwritten by a model.
            if (next[p.merchant]?.from_model === false) continue;
            next[p.merchant] = {
              category_id: String(p.category_id),
              from_model: true,
              confidence: p.confidence,
              reason: p.reason,
            };
          }
          return next;
        });
        const unsure = res.proposals.filter((p) => p.confidence < UNSURE).length;
        toast.success(
          `${res.proposals.length} of ${res.proposals.length + res.unresolved.length} merchants got a suggestion` +
            (unsure > 0 ? `, ${unsure} worth a look` : ""),
        );
      },
      onError: (e) => toast.error(errorText(e, "Could not reach the model.")),
    });

  const applyAll = () =>
    apply.mutate(
      chosen.map((x) => ({
        merchant: x.row.merchant,
        category_id: Number(x.decision.category_id),
        // A merchant seen once will never be seen again under that exact
        // string, so a rule for it is a row in the rules table that can only
        // ever be noise.
        make_rule: writeRules && x.row.count > 1,
      })),
      {
        onSuccess: (res) => {
          setDecisions({});
          const rules = res.rules_created > 0 ? `, ${res.rules_created} rule${res.rules_created === 1 ? "" : "s"} written` : "";
          toast.success(`${res.updated} transaction${res.updated === 1 ? "" : "s"} categorized${rules}`);
          for (const s of res.skipped) toast.warning(`${merchantTitle(s.merchant)}: ${s.reason}`);
        },
        onError: (e) => toast.error(errorText(e, "Could not save.")),
      },
    );

  if (backlog.isLoading || categories.isLoading) return <Loading />;
  if (backlog.error) return <LoadError error={backlog.error} />;

  const transactions = rows.reduce((n, r) => n + r.count, 0);
  const outstanding = rows.reduce((n, r) => n + r.total_cents, 0);

  return (
    <>
      <PageHeader
        title="Categorize"
        description={
          rows.length === 0
            ? "Nothing is waiting."
            : `${rows.length} merchants, ${transactions} transactions. Until these have a category they are all one grey wedge in every report.`
        }
        actions={
          rows.length > 0 ? (
            <>
              <div className="flex items-center gap-2">
                <Switch id="write-rules" checked={writeRules} onCheckedChange={setWriteRules} />
                <Label htmlFor="write-rules" className="text-sm font-normal text-muted-foreground">
                  Write rules for repeats
                </Label>
              </div>
              <Button variant="outline" onClick={ask} disabled={classify.isPending}>
                <SparklesIcon />
                {classify.isPending ? "Asking…" : "Suggest categories"}
              </Button>
              <Button onClick={applyAll} disabled={chosen.length === 0 || apply.isPending}>
                <WandSparklesIcon />
                Apply {chosen.length}
              </Button>
            </>
          ) : null
        }
      />

      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Everything is categorized</EmptyTitle>
            <EmptyDescription>
              Import a statement and anything the rules did not catch shows up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Uncategorized merchants</CardTitle>
            <CardDescription>
              <Money cents={outstanding} /> in total, busiest merchant first.
              {model ? ` Suggestions from ${model}.` : ""} Nothing is written until you press Apply.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Merchant</TableHead>
                  <TableHead className="text-right">Txns</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="w-56">Category</TableHead>
                  <TableHead>Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const d = decisions[r.merchant];
                  return (
                    <TableRow key={r.merchant}>
                      <TableCell className="font-medium">
                        <div>{merchantTitle(r.merchant)}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.description ? `${r.description} · ` : ""}
                          {dateLabel(r.first_seen)}
                          {r.last_seen !== r.first_seen ? ` – ${dateLabel(r.last_seen)}` : ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular">{r.count}</TableCell>
                      <TableCell className="text-right">
                        {/* Signed: a negative total is money arriving, and it is
                            the only thing on this page that is not spending. */}
                        <Money cents={r.total_cents} tone />
                      </TableCell>
                      <TableCell>
                        <SelectField
                          value={d?.category_id ?? SKIP}
                          onChange={(v) => set(r.merchant, v)}
                          options={options}
                          className="w-full"
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {d?.from_model ? (
                          <span className="flex items-center gap-2">
                            {d.confidence < UNSURE ? <Badge variant="outline">worth a look</Badge> : null}
                            {d.reason}
                          </span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
