import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/app/stat-tile";
import { api, useApi, useInvalidateAll } from "@/lib/api";
import { centsToInput, toCents } from "@/lib/format";

/**
 * A stat tile whose number is a real account balance you keep up to date by
 * hand. Editing happens where the number is read, not on a settings page two
 * clicks away, because the point is to correct it the moment it looks wrong.
 */
export function BalanceTile({
  settingKey,
  label,
  caption,
  editCaption,
}: {
  settingKey: string;
  label: string;
  caption?: ReactNode;
  editCaption?: string;
}) {
  const settings = useApi<Record<string, string>>("/api/settings");
  const invalidate = useInvalidateAll();
  const cents = Number(settings.data?.[settingKey] ?? "0") || 0;

  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const parsed = draft === null ? null : toCents(draft);

  const save = async () => {
    if (parsed === null) return;
    setSaving(true);
    try {
      await api.put("/api/settings", { name: settingKey, value: String(parsed) });
      setDraft(null);
      invalidate();
    } finally {
      setSaving(false);
    }
  };

  if (draft !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="flex gap-2">
          <Input
            autoFocus
            inputMode="decimal"
            value={draft}
            aria-invalid={parsed === null || undefined}
            aria-label={label}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setDraft(null);
            }}
          />
          <Button size="sm" onClick={() => void save()} disabled={saving || parsed === null}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{editCaption ?? "Whatever the account says right now."}</p>
      </div>
    );
  }

  return (
    <StatTile label={label} cents={cents} tone="muted" caption={caption}>
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 -ml-2 self-start text-xs"
        onClick={() => setDraft(centsToInput(cents))}
      >
        Update balance
      </Button>
    </StatTile>
  );
}
