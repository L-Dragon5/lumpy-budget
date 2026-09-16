import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BalanceTile } from "@/components/app/balance-tile";
import { MoneyEditor } from "@/components/app/money-editor";
import { Money } from "@/components/app/money";
import { LoadError } from "@/components/app/page";
import { eden, useApi, useInvalidateAll } from "@/lib/api";
import { dateLabel } from "@/lib/format";

/** The part of a position that both tiles read the same way. */
type Position = {
  days_stale: number;
  spent_since_cents: number;
  next_paycheck_date: string | null;
  due_before_next_paycheck_cents: number;
  projected_cents: number;
  short: boolean;
  due: { name: string }[];
};

/** What the plan is about to ask of this account before the next paycheck. */
function Due({ p }: { p: Position }) {
  if (p.due.length === 0) {
    return (
      <>No bills due before {p.next_paycheck_date ? dateLabel(p.next_paycheck_date) : "the next paycheck"}.</>
    );
  }
  return (
    <span className={p.short ? "text-destructive" : undefined}>
      <Money cents={p.due_before_next_paycheck_cents} /> of bills due before{" "}
      {p.next_paycheck_date ? dateLabel(p.next_paycheck_date) : "the next paycheck"} (
      {p.due.map((x) => x.name).join(", ")}), leaving <Money cents={p.projected_cents} />.
    </span>
  );
}

/**
 * A hand-kept number goes stale, and a stale balance says you are fine on the
 * strength of a week-old fact.
 */
function Stale({ p }: { p: Position }) {
  if (p.days_stale === 0 || p.spent_since_cents <= 0) return null;
  return (
    <span className="mt-1 block text-amber-600 dark:text-amber-500">
      Set {p.days_stale} day{p.days_stale === 1 ? "" : "s"} ago; <Money cents={p.spent_since_cents} /> has been
      recorded since.
    </span>
  );
}

/**
 * The money that is actually there, in the one or two checking accounts it is
 * actually in.
 *
 * A household that keeps its bills in one account and spends out of another is
 * asking two different questions of two different balances: whether the bills
 * account survives the next eleven days, and how much of the other one is free.
 * Pooled, both answers are wrong in the same direction -- the bills look like a
 * claim on spending money that is already funded somewhere else.
 *
 * The second account exists once a balance has been typed for it. No flag, no
 * setup screen: a household with one account never sees a second tile, and the
 * one below the first is how a household with two says so.
 */
export function CheckingBalances() {
  const cash = useApi(["cash-position"], () => eden.api["cash-position"].get());
  const invalidate = useInvalidateAll();
  const [adding, setAdding] = useState(false);
  if (cash.error) return <LoadError error={cash.error} />;
  const c = cash.data;
  const f = c?.fixed ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>In the bank</CardTitle>
        <CardDescription>
          {f
            ? "Bills come out of one account and everything else out of the other, so each balance answers its own question."
            : "What the account holds right now, against what the plan is about to ask of it."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <BalanceTile
          settingKey="checking_balance_cents"
          label={f ? "Everyday account" : "In checking"}
          caption={
            c === undefined ? (
              "What the account holds right now."
            ) : (
              <>
                {/* Split in two, the bills are not a claim on this balance: they
                    are counted once, on the account they actually leave. */}
                {f ? <>Spending money. Bills come out of the bills account.</> : <Due p={c} />}
                <Stale p={c} />
              </>
            )
          }
          editCaption={
            f
              ? "Whatever the everyday account says right now."
              : "Whatever the account says right now. The bills due before your next paycheck come off it."
          }
        />

        {f ? (
          <BalanceTile
            settingKey="fixed_balance_cents"
            label="Bills account"
            tone={f.short ? "critical" : "muted"}
            caption={
              <>
                <Due p={f} />
                <Stale p={f} />
              </>
            }
            editCaption="Whatever the bills account says right now. The bills due before your next paycheck come off it."
            removeLabel="Not a second account after all"
            onRemove={async () => {
              // Removing the balance is what removes the account: the row
              // existing is the whole switch, so the tile and the split go
              // together and nothing is left half on.
              await eden.api.settings({ name: "fixed_balance_cents" }).delete();
              invalidate();
            }}
          />
        ) : adding ? (
          <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bills account</div>
            <MoneyEditor
              cents={0}
              label="Bills account balance"
              onCancel={() => setAdding(false)}
              onSave={async (next) => {
                await eden.api.settings.put({ name: "fixed_balance_cents", value: String(next) });
                setAdding(false);
                invalidate();
              }}
            />
            <p className="text-xs text-muted-foreground">
              What the second account holds. Once it has a balance the bills come off it instead, and statements
              imported under a format marked as the bills account are counted against it.
            </p>
          </div>
        ) : (
          <div className="flex flex-col justify-center gap-2 rounded-xl border border-dashed p-4">
            <p className="text-xs text-muted-foreground">
              Keep your bills in a second checking account? Add its balance and the two are tracked apart.
            </p>
            <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}>
              Add a bills account
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
