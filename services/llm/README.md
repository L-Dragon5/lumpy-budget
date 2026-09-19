# @lumpy/llm

Turns a merchant string into a category id.

Every other service in this repo is deterministic. This one is not, and the
whole design is about keeping the non-deterministic part as small as possible:
one function makes an HTTP request, everything else is pure and tested without a
key or a network.

```
gemini.ts     the only code that talks to Google. One request, one parsed JSON object.
classify.ts   pure. Builds the prompt, reads the answer, throws away what is not safe.
index.ts      the two wired together.
```

## Why a model at all

The expenses backlog is long-tailed. On the ledger this was built against, 193
uncategorized merchants covered 305 transactions, and **129 of those merchants
appeared exactly once**. Rules do not help with a long tail; `suggestRule` on the
expenses page already clears the repeats. What is left is `Kotobukiya`,
`Pabc Multi Space 3` and `Cults3d.com 3d Models`, and no pattern gets there.

It matters because an uncategorized row is not neutral. `bucketOf` reads it as
discretionary, so between 30% and 53% of every month's discretionary spending
was one grey wedge in `breakdown`, the biggest line in `categoryPace` every
month, and a number `available` was computed from.

## The seam

`classify.ts` takes a `Generate` function. The real one is Gemini; the tests
pass a stub. That is why `services/llm/test` runs in the gate lane beside
everything else, needs no key, and makes no request.

What the answer-reader throws away, and why:

| dropped | because |
|---|---|
| a merchant nobody asked about | it names no rows; it is a hallucination or a mangled copy |
| a `category_id` that does not exist | `POST /api/expenses/categorize` would refuse it anyway |
| a second answer for the same merchant | two rows for one merchant is two chances to apply the wrong one |

Everything asked about that came back with nothing lands in `unresolved`. Nothing
is silently missing.

## Conventions come off the ledger, not out of the prompt

Whether an Uber is Travel or Transportation is not a fact, it is a habit. So the
prompt carries the household's own past decisions (`store.categorizedExamples`,
thinned by `pickExamples`) rather than a list of rules somebody wrote down here.
A household that files things differently gets a classifier that agrees with it.

The prompt still states the things that are not habits: that a positive amount is
money out, that a credit from an employer is income but a credit from a shop is a
refund, that a card payment is a transfer because its purchases are already
counted where they happened.

## Two routes, and only one of them writes

```
POST /api/classify              proposes. Writes nothing. 503 if the key is missing.
POST /api/expenses/categorize   applies what a person approved.
```

They are separate on purpose. A model cannot reach the ledger without a person
looking at the row first, and the writer re-checks every category id, because
what comes back from the browser is not what was sent to it. The writer only
ever fills a null category in; a category a person set is never overwritten.

## Configuration

```
GEMINI_API_KEY=...        required. Server-side only; it never reaches the browser.
GEMINI_MODEL=...          optional. Overrides DEFAULT_MODEL in gemini.ts.
```

`bun run llm:models` lists what the key can actually reach.

## The two lanes

```bash
bun test services/llm      # gate: free, deterministic, no key, sub-second
bun run eval:classify      # paid: a real model against real ground truth
bun run eval:build         # rebuild the fixture from this database
```

The eval scores agreement with what this household actually filed —
`cases.json`, held out from `examples.json` so nothing can be passed by copying.
Threshold 85%. It reports confident misses separately, because a wrong answer
the model was sure of is the one a person scrolls past.

`bun run eval:build` reads the live database and rewrites all three fixture
files together. **They are gitignored** -- they are real merchant strings off a
real ledger -- so a fresh clone runs that first and `eval:classify` says so if
they are missing.

It drops two kinds of row from both sides. A merchant carrying six or more
consecutive digits is a card or account fragment. A merchant filed under more
than one category is ambiguous ground truth: `Bilt Rewards` is Housing on one
row and Travel on another, so it arrives as two cases of which at most one can
be right, and as an example it teaches a contradiction. Dropping the three of
those in this ledger moved the score from 93.8% to 95.0% without touching the
prompt, which is the point -- it was measuring the ledger, not the model.

## The ceiling is label noise, not the model

At 95% the four remaining misses are all rows this ledger files inconsistently:
`DD *DOORDASH WEGMANS` is Groceries and `DD *DOORDASH HARRISTEE` is Dining. The
model picks one convention and is marked wrong for the other. Chasing that with
prompt changes is chasing a coin flip. If the number has to go higher, the ledger
is what needs tidying first.
