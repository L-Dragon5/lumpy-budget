import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/app/stat-tile";
import { MoneyEditor } from "@/components/app/money-editor";
import { eden, useApi, useInvalidateAll } from "@/lib/api";

/**
 * A stat tile whose number is a real account balance you keep up to date by
 * hand. Editing happens where the number is read, not on a settings page two
 * clicks away, because the point is to correct it the moment it looks wrong.
 *
 * `displayCents` is for the tiles whose headline is not the number you typed: a
 * card shows what it would take to clear it, which is the balance you read off
 * the issuer plus everything imported since. The editor still opens on the typed
 * number, because that is the one a person can check.
 */
export function BalanceTile({
  settingKey,
  label,
  caption,
  editCaption,
  displayCents,
  tone = "muted",
  buttonLabel = "Update balance",
  onRemove,
  removeLabel = "Remove",
}: {
  settingKey: string;
  label: string;
  caption?: ReactNode;
  editCaption?: string;
  displayCents?: number;
  tone?: "neutral" | "good" | "critical" | "muted";
  buttonLabel?: string;
  /** Offered inside the editor, not on the face: taking an account away is not a thing to misclick. */
  onRemove?: () => Promise<void> | void;
  removeLabel?: string;
}) {
  const settings = useApi(["settings"], () => eden.api.settings.get());
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
            await eden.api.settings.put({ name: settingKey, value: String(next) });
            setEditing(false);
            invalidate();
          }}
        />
        <p className="text-xs text-muted-foreground">{editCaption ?? "Whatever the account says right now."}</p>
        {onRemove ? (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 self-start text-xs text-destructive"
            onClick={async () => {
              await onRemove();
              setEditing(false);
            }}
          >
            {removeLabel}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <StatTile label={label} cents={displayCents ?? cents} tone={tone} caption={caption}>
      <Button variant="ghost" size="sm" className="mt-1 -ml-2 self-start text-xs" onClick={() => setEditing(true)}>
        {buttonLabel}
      </Button>
    </StatTile>
  );
}
