import type { Category, CategoryProposal, UncategorizedMerchant } from "@lumpy/contracts";

/**
 * Turning a merchant string into a category is the one job in this app that is
 * genuinely latent: `Kotobukiya` is Shopping and `Pabc Multi Space 3` is
 * parking, and no amount of pattern matching gets there. Everything around it
 * is deterministic and lives in this file -- the prompt is built the same way
 * every time, and the answer is checked against the categories that actually
 * exist before anybody sees it.
 *
 * Nothing here touches the network. `gemini.ts` is the only part that does, and
 * it is passed in, so the gate lane runs this whole file with a stub.
 */

/**
 * Merchants per request.
 *
 * Not a token budget -- a truncation guard. The failure mode of one big batch is
 * `finishReason: MAX_TOKENS`, which arrives as valid-looking JSON holding the
 * first sixty merchants and no sign that the rest existed. Chunks fail loudly
 * instead, and a chunk that dies leaves the others already answered.
 *
 * ponytail: sequential, not parallel. 200 merchants is four requests, and four
 * requests in parallel is how a free-tier key earns a 429.
 */
export const CHUNK = 50;

/** Worked examples per category, and the ceiling on all of them together. */
export const EXAMPLES_PER_CATEGORY = 8;
export const EXAMPLES_MAX = 200;

/** A merchant this household has already categorised, and where it put it. */
export type Example = { merchant: string; category_id: number };

const money = (cents: number): string => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * What the model is allowed to return. Gemini enforces it, so there is no fence
 * to strip and no prose to skip past -- but `readProposals` still checks every
 * field, because the schema guarantees the shape and says nothing about whether
 * `category_id` is a category that exists.
 */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          merchant: { type: "string" },
          category_id: { type: "integer" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["merchant", "category_id", "confidence", "reason"],
      },
    },
  },
  required: ["assignments"],
} as const;

export type RawAssignments = {
  assignments?: { merchant?: unknown; category_id?: unknown; confidence?: unknown; reason?: unknown }[];
};

/**
 * The household's own decisions, thinned to the busiest merchants per category.
 *
 * Deterministic on purpose: same ledger, same examples, so a re-run of the
 * classifier is a re-run and not a different experiment. The cap per category
 * is what stops Dining -- a hundred restaurants -- from crowding out the
 * categories with three merchants in them, which are exactly the ones a model
 * cannot guess the convention for.
 */
export function pickExamples(all: Example[], categories: Category[]): Example[] {
  const byCategory = new Map<number, Example[]>();
  for (const e of all) {
    const list = byCategory.get(e.category_id) ?? [];
    if (list.length < EXAMPLES_PER_CATEGORY) list.push(e);
    byCategory.set(e.category_id, list);
  }
  // Walked in the category list's order rather than the map's, so the prompt is
  // stable whatever order the rows arrived in.
  const out: Example[] = [];
  for (const c of categories) out.push(...(byCategory.get(c.id) ?? []));
  return out.slice(0, EXAMPLES_MAX);
}

/**
 * The sign rule and the examples are the two parts worth spelling out.
 *
 * `bucketOf` reads an uncategorised credit as `transfer` and therefore as
 * neutral, which is the safe default and also the reason a paycheck nobody
 * categorised is invisible in every report. The model sees the signed total so
 * it can say Income where Income is what it is, and the wording below is what
 * keeps it from calling a refund one.
 *
 * The examples carry every convention this household has that nobody could
 * guess: that an Uber is Travel and a parking garage is Transportation, that a
 * Venmo payment out is Misc and a Venmo cashout is a Transfer, that an LLM
 * subscription is lumpy rather than discretionary. Those rules are not written
 * down here, deliberately -- they are read off the ledger, so a household that
 * files things differently gets a classifier that agrees with it instead of one
 * that argues.
 */
export function buildPrompt(
  merchants: UncategorizedMerchant[],
  categories: Category[],
  examples: Example[] = [],
): string {
  const cats = categories.map((c) => `  ${c.id}\t${c.name}\t(${c.bucket})`).join("\n");
  const worked = examples.map((e) => `  ${e.category_id}\t${e.merchant}`).join("\n");
  const rows = merchants
    .map((m) => {
      const desc = m.description.trim();
      return [
        `- merchant: ${JSON.stringify(m.merchant)}`,
        desc ? `  bank description: ${JSON.stringify(desc.slice(0, 120))}` : null,
        `  ${m.count} transaction(s), ${money(m.total_cents)} total, ${m.first_seen} to ${m.last_seen}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return `You are categorising bank and credit card transactions for one household's budget.

CATEGORIES (id, name, bucket):
${cats}
${
  worked
    ? `
HOW THIS HOUSEHOLD ALREADY FILES THINGS (category id, merchant). These are their
own past decisions. Where they disagree with what you would have guessed, they
win -- match the convention, do not correct it:
${worked}
`
    : ""
}
MERCHANTS TO CATEGORISE:
${rows}

RULES:
- Amounts are signed: positive is money leaving the account (a purchase), negative is money arriving (a deposit, a refund, a payment received).
- A negative total from an employer, a payroll processor, a government agency, or a deposit ("Check deposit", "Direct dep", "interest") is the income bucket.
- A negative total that is money back from a merchant you would otherwise categorise as spending is a REFUND or a statement credit: file it where that spending goes, not as income.
- Moving money between the household's own accounts, and paying off a credit card, is the transfer bucket. The purchases on that card are already counted where they happened, so a card payment must never be spending.
- Merchant strings are bank-mangled: store numbers, city and state codes, "SQ *", "DD *", "TST*", "AplPay", "PY *", "POS DEBIT" and trailing card digits are noise. Read through them to the business.
- Pick from the category list only. Never invent an id.
- confidence is 0 to 1 and must be honest: use below 0.5 when the merchant string genuinely does not say what was bought, so a person knows to look at that row.
- reason is at most one short clause, e.g. "bubble tea shop" or "payroll deposit". Do not restate the merchant.

Return one assignment for every merchant listed, with the merchant string copied exactly as given.`;
}

/**
 * The model's answer, reduced to what is safe to show a person.
 *
 * Three things get dropped and one gets reported. A merchant nobody asked about
 * is dropped: it is either a hallucination or a mangled copy, and in both cases
 * it names no rows. A category id that does not exist is dropped for the same
 * reason -- `POST /api/expenses/categorize` would reject it anyway, and a row
 * the person cannot approve is worse than a row that is missing. A second
 * answer for a merchant already answered is dropped, first one winning, because
 * two rows for one merchant in a review table is two chances to apply the wrong
 * one. What gets reported is the remainder: every merchant that went out and
 * came back with nothing lands in `unresolved`, never silently gone.
 */
export function readProposals(
  raw: RawAssignments,
  asked: UncategorizedMerchant[],
  categories: Category[],
): { proposals: CategoryProposal[]; unresolved: UncategorizedMerchant[] } {
  const byMerchant = new Map(asked.map((m) => [m.merchant, m]));
  const known = new Set(categories.map((c) => c.id));
  const seen = new Set<string>();
  const proposals: CategoryProposal[] = [];

  for (const a of raw.assignments ?? []) {
    if (typeof a?.merchant !== "string") continue;
    const fact = byMerchant.get(a.merchant);
    if (!fact || seen.has(a.merchant)) continue;
    const categoryId = typeof a.category_id === "number" ? Math.trunc(a.category_id) : NaN;
    if (!known.has(categoryId)) continue;
    seen.add(a.merchant);
    // A model that omits confidence is not a model that is certain.
    const c = typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : 0;
    proposals.push({
      ...fact,
      category_id: categoryId,
      confidence: Math.min(1, Math.max(0, c)),
      reason: typeof a.reason === "string" ? a.reason.slice(0, 200) : "",
    });
  }

  return { proposals, unresolved: asked.filter((m) => !seen.has(m.merchant)) };
}

/** Injected so the gate lane never needs a key. `gemini.generateJSON` is the real one. */
export type Generate = (prompt: string, schema: Record<string, unknown>) => Promise<{ data: unknown; model: string }>;

/**
 * Every merchant, in chunks, answers merged.
 *
 * A chunk that throws is not caught: a half-classified batch that looks whole
 * is how a person approves fifty rows and never learns the other hundred were
 * never asked about. The caller sees the error and re-runs; nothing was
 * written, because this route writes nothing.
 */
export async function classifyMerchants(
  merchants: UncategorizedMerchant[],
  categories: Category[],
  examples: Example[],
  generate: Generate,
): Promise<{ proposals: CategoryProposal[]; unresolved: UncategorizedMerchant[]; model: string }> {
  const proposals: CategoryProposal[] = [];
  const unresolved: UncategorizedMerchant[] = [];
  let model = "";

  for (let i = 0; i < merchants.length; i += CHUNK) {
    const chunk = merchants.slice(i, i + CHUNK);
    const res = await generate(
      buildPrompt(chunk, categories, examples),
      RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    );
    model = res.model;
    const read = readProposals((res.data ?? {}) as RawAssignments, chunk, categories);
    proposals.push(...read.proposals);
    unresolved.push(...read.unresolved);
  }

  // Least certain first: the rows that need a person are the rows a person
  // should hit first, and the confident ones are a scroll away either way.
  proposals.sort((a, b) => a.confidence - b.confidence || b.count - a.count);
  return { proposals, unresolved, model };
}
