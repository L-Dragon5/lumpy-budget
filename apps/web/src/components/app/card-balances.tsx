import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BalanceTile } from "@/components/app/balance-tile";
import { Money } from "@/components/app/money";
import { LoadError } from "@/components/app/page";
import { eden, useApi } from "@/lib/api";
import { dateLabelFull } from "@/lib/format";

/**
 * What the cards are about to ask for, and what it would take to clear them.
 *
 * The cash position leaves a card charge out on purpose -- it has not left
 * checking yet -- which is right and is half an answer. The money is still owed,
 * and this is where that half goes: beside the balance it qualifies, not on a
 * page of its own.
 *
 * The headline is the payoff number: the balance somebody read off the issuer,
 * plus every row imported since they read it. Typing the balance is the whole
 * maintenance, and the caption says how long ago that was, because a card that
 * has been quiet for six weeks and a card nobody has looked at for six weeks
 * show the same number and mean opposite things.
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
          What each card would take to clear: the balance you last read off it, plus everything imported since.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {rows.map((c) => (
          <BalanceTile
            key={c.profile_id}
            settingKey={c.balance_key}
            label={c.name}
            displayCents={c.balance_cents}
            tone={c.balance_cents > 0 ? "neutral" : "muted"}
            buttonLabel={c.as_of === null ? "Set balance" : "Update balance"}
            caption={
              <>
                {c.as_of === null ? (
                  // No balance ever typed. The sum of the statements is the best
                  // this can do and it is not the same claim, so it says so.
                  <>
                    {c.txn_count === 0
                      ? "No balance set and nothing imported yet."
                      : `No balance set: this is ${c.txn_count} imported row${c.txn_count === 1 ? "" : "s"} only.`}
                  </>
                ) : (
                  <>
                    {c.balance_cents > 0 ? "Pay this to clear it. " : null}
                    Read {dateLabelFull(c.as_of)}
                    {c.since_count > 0 ? (
                      <>
                        ; <Money cents={c.since_cents} /> imported since
                      </>
                    ) : null}
                    .
                  </>
                )}
                {/* A hand-kept number goes stale exactly the way the checking
                    balance does, and two weeks of unimported charges look the
                    same as two quiet weeks. */}
                {c.days_stale >= 14 ? (
                  <span className="mt-1 block text-amber-600 dark:text-amber-500">
                    {c.days_stale} days old. Check the card.
                  </span>
                ) : null}
                {c.last_txn_date === null ? null : (
                  // With the year: a card nobody has imported since last spring
                  // should not read as though it were this spring.
                  <span className="mt-1 block">Statements through {dateLabelFull(c.last_txn_date)}.</span>
                )}
              </>
            }
            editCaption="What the card says it owes right now. Anything imported after today gets added on top."
          />
        ))}
      </CardContent>
    </Card>
  );
}
