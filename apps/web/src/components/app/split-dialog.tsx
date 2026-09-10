import { useState } from "react";
import type { Category, Expense } from "@lumpy/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/app/controls";
import { MoneyField, RecordDialog } from "@/components/app/record-dialog";
import { Money } from "@/components/app/money";
import { eden, useMutate } from "@/lib/api";

/** The same sentinel the expenses table uses: a Select item is never an empty string here. */
const UNCATEGORIZED = "none";

type Part = { amount_cents: number | null; category_id: string; description: string };

/**
 * One charge into two or more parts.
 *
 * The remainder is shown while you type rather than checked on submit, because
 * the parts have to add up to the cent and finding that out after a failed save
 * is finding it out too late. The server checks it again -- what arrives is a
 * request -- and answers 422 with both numbers in it.
 *
 * A blank part also holds the button down. The dialog opens with the whole
 * charge in the first part and nothing in the second, which already "adds up";
 * without this, one click would write the charge again beside a $0 part.
 */
export function SplitDialog({
  expense,
  categories,
  onClose,
}: {
  expense: Expense;
  categories: Category[];
  onClose: () => void;
}) {
  const [parts, setParts] = useState<Part[]>([
    {
      amount_cents: expense.amount_cents,
      category_id: expense.category_id === null ? UNCATEGORIZED : String(expense.category_id),
      description: "",
    },
    { amount_cents: null, category_id: UNCATEGORIZED, description: "" },
  ]);
  const split = useMutate((v: { id: number; parts: { amount_cents: number; category_id: number | null; description: string }[] }) =>
    eden.api.expenses({ id: v.id }).split.post({ parts: v.parts }));

  const allocated = parts.reduce((a, p) => a + (p.amount_cents ?? 0), 0);
  const remainder = expense.amount_cents - allocated;
  const blank = parts.some((p) => p.amount_cents === null);
  const set = (i: number, patch: Partial<Part>) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <RecordDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Split ${expense.merchant}`}
      description="The parts have to add up to the charge. Each one is an ordinary transaction afterwards."
      pending={split.isPending}
      error={split.error}
      submitLabel="Split"
      onSubmit={() =>
        split.mutate(
          {
            id: expense.id,
            parts: parts.map((p) => ({
              amount_cents: p.amount_cents ?? 0,
              category_id: p.category_id === UNCATEGORIZED ? null : Number(p.category_id),
              description: p.description,
            })),
          },
          { onSuccess: onClose },
        )
      }
      submitDisabled={remainder !== 0 || blank}
    >
      <div className="flex flex-col gap-3">
        {parts.map((p, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[9rem_1fr]">
            <MoneyField
              label={`Part ${i + 1}`}
              cents={p.amount_cents}
              onChange={(amount_cents) => set(i, { amount_cents })}
            />
            <div className="flex flex-col gap-2 sm:pt-6">
              <SelectField
                value={p.category_id}
                onChange={(category_id) => set(i, { category_id })}
                options={[
                  { value: UNCATEGORIZED, label: "Uncategorized" },
                  ...categories.map((c) => ({ value: String(c.id), label: c.name })),
                ]}
              />
              <Input
                placeholder="Note (optional)"
                value={p.description}
                onChange={(e) => set(i, { description: e.target.value })}
              />
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between text-sm">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setParts((ps) => [...ps, { amount_cents: null, category_id: UNCATEGORIZED, description: "" }])}
            disabled={parts.length >= 20}
          >
            Add a part
          </Button>
          <span className={remainder === 0 ? "text-muted-foreground" : "font-medium"}>
            {remainder === 0 ? (
              "Adds up"
            ) : remainder > 0 ? (
              <>Left to allocate: <Money cents={remainder} /></>
            ) : (
              <>Over by <Money cents={-remainder} /></>
            )}
          </span>
        </div>
      </div>
    </RecordDialog>
  );
}
