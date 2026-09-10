import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatTile } from "@/components/app/stat-tile";
import { BalanceTile } from "@/components/app/balance-tile";
import { LoadError } from "@/components/app/page";
import { eden, useApi } from "@/lib/api";
import { dateLabelFull } from "@/lib/format";

/**
 * What the cards are about to ask for.
 *
 * The cash position leaves a card charge out on purpose -- it has not left
 * checking yet -- which is right and is half an answer. The money is still owed,
 * and this is where that half goes: beside the balance it qualifies, not on a
 * page of its own.
 *
 * Nothing at all when no import format is marked as a card, because a household
 * with one checking account should not be shown an empty card section forever.
 * A failed fetch is not the same as no cards, so it says so instead.
 */
export function CardBalances() {
  const cards = useApi(["card-balances"], () => eden.api["card-balances"].get());
  if (cards.error) return <LoadError error={cards.error} />;
  const rows = cards.data ?? [];
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Owed on cards</CardTitle>
        <CardDescription>
          Charges minus payments, from the statements imported under each card format. As current as the last
          statement you imported and no more, which is what the date beside each one is for.
        </CardDescription>
      </CardHeader>
      {/* One column in the dashboard's narrow side column on a wide screen, two
          when that column is the full width of a tablet. */}
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
        {rows.map((c) => (
          <div key={c.profile_id} className="flex flex-col gap-2">
            <StatTile
              label={c.name}
              cents={c.balance_cents}
              tone={c.balance_cents > 0 ? "neutral" : "muted"}
              caption={
                c.last_txn_date === null
                  ? "No statement imported yet"
                  : // With the year: a card nobody has imported since last spring
                    // should not read as though it were this spring.
                    `${c.txn_count} row${c.txn_count === 1 ? "" : "s"} through ${dateLabelFull(c.last_txn_date)}`
              }
            />
            <BalanceTile
              settingKey={c.opening_key}
              label={`${c.name} opening balance`}
              caption="What the card owed before your first import."
              editCaption="What the card owed before the first statement you imported."
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
