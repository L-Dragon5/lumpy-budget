import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { centsToInput, toCents } from "@/lib/format";

/**
 * Edit one money value in place. Enter saves, Escape cancels, a value that is
 * not money keeps the Save button disabled rather than writing a zero.
 */
export function MoneyEditor({
  cents,
  label,
  onSave,
  onCancel,
}: {
  cents: number;
  label: string;
  onSave: (cents: number) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(centsToInput(cents));
  const [saving, setSaving] = useState(false);
  const parsed = toCents(draft);

  const save = async () => {
    if (parsed === null) return;
    setSaving(true);
    try {
      await onSave(parsed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex gap-2">
      <Input
        autoFocus
        inputMode="decimal"
        value={draft}
        aria-label={label}
        aria-invalid={parsed === null || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") onCancel();
        }}
      />
      <Button size="sm" onClick={() => void save()} disabled={saving || parsed === null}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
