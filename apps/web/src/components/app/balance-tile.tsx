import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/app/stat-tile";
import { MoneyEditor } from "@/components/app/money-editor";
import { api, useApi, useInvalidateAll } from "@/lib/api";

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
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <MoneyEditor
          cents={cents}
          label={label}
          onCancel={() => setEditing(false)}
          onSave={async (next) => {
            await api.put("/api/settings", { name: settingKey, value: String(next) });
            setEditing(false);
            invalidate();
          }}
        />
        <p className="text-xs text-muted-foreground">{editCaption ?? "Whatever the account says right now."}</p>
      </div>
    );
  }

  return (
    <StatTile label={label} cents={cents} tone="muted" caption={caption}>
      <Button variant="ghost" size="sm" className="mt-1 -ml-2 self-start text-xs" onClick={() => setEditing(true)}>
        Update balance
      </Button>
    </StatTile>
  );
}
