/**
 * Rebuild the eval fixture from this database's own categorised rows.
 *
 *   bun run eval:build
 *
 * The ground truth is what a person actually filed, not what anybody thinks the
 * right answer is, which is the only kind of ground truth worth measuring
 * against: the classifier's job is to agree with this household, not with a
 * chart of accounts.
 *
 * The split is deterministic and disjoint. Within a category, merchants are
 * ordered busiest first; every third one becomes a held-out case and the rest
 * are eligible as worked examples. Disjoint matters more than it sounds -- an
 * example that is also a case is a test the model passes by copying, and the
 * score would mean nothing.
 *
 * Two kinds of row are dropped from both sides. A merchant string carrying a
 * long run of digits is a card or account fragment. A merchant filed under more
 * than one category is ambiguous ground truth: `Bilt Rewards` is Housing on one
 * row and Travel on another, so it arrives as two cases of which at most one can
 * be right, and it teaches the prompt a contradiction as an example. Either way
 * it measures the ledger's inconsistency rather than the model's accuracy.
 */
import { sql } from "@lumpy/db";
import { pickExamples, type Example } from "@lumpy/llm";
import type { Category } from "@lumpy/contracts";

const ACCOUNT_DIGITS = /\d{6,}/;
/** Every third merchant, so a category with three merchants still contributes one case. */
const HELD_OUT = 3;
const MAX_CASES = 80;

type Row = { category_id: number; category: string; merchant: string; n: number; total_cents: number };

const found = (await sql.unsafe(
  `SELECT e.category_id AS category_id, c.name AS category, e.merchant AS merchant,
          COUNT(*) AS n, SUM(e.amount_cents) AS total_cents
     FROM expenses e
     JOIN categories c ON c.id = e.category_id
    WHERE NOT EXISTS (SELECT 1 FROM expenses p WHERE p.parent_id = e.id)
    GROUP BY e.category_id, c.name, e.merchant
    ORDER BY e.category_id ASC, COUNT(*) DESC, e.merchant ASC`,
)) as { category_id: number | string; category: string; merchant: string; n: string | number; total_cents: string | number }[];

const categoriesPerMerchant = new Map<string, Set<number>>();
for (const r of found) {
  const set = categoriesPerMerchant.get(r.merchant) ?? new Set<number>();
  set.add(Number(r.category_id));
  categoriesPerMerchant.set(r.merchant, set);
}
const ambiguous = [...categoriesPerMerchant.entries()].filter(([, set]) => set.size > 1).map(([m]) => m);

const rows: Row[] = found
  .filter((r) => !ACCOUNT_DIGITS.test(r.merchant))
  .filter((r) => (categoriesPerMerchant.get(r.merchant)?.size ?? 1) === 1)
  .map((r) => ({
    category_id: Number(r.category_id),
    category: r.category,
    merchant: r.merchant,
    n: Number(r.n),
    total_cents: Number(r.total_cents),
  }));

const categories = (await sql.unsafe("SELECT id, name, bucket, icon, color FROM categories ORDER BY id")) as Category[];

const cases: Row[] = [];
const examplePool: Example[] = [];
const seen = new Map<number, number>();
for (const r of rows) {
  const i = seen.get(r.category_id) ?? 0;
  seen.set(r.category_id, i + 1);
  if (i % HELD_OUT === 1) cases.push(r);
  else examplePool.push({ category_id: r.category_id, merchant: r.merchant });
}

const trimmed = cases.slice(0, MAX_CASES);
const examples = pickExamples(examplePool, categories);

// Lives in scripts/ rather than beside the fixture because it reads the
// database: `services/llm` depends on `contracts` and nothing else, which is
// what keeps it a sibling of csv-import rather than something downstream of db.
const dir = new URL("../services/llm/eval/", import.meta.url).pathname;
await Bun.write(
  `${dir}cases.json`,
  JSON.stringify(
    trimmed.map((r) => ({
      merchant: r.merchant,
      description: "",
      count: r.n,
      total_cents: r.total_cents,
      first_seen: "2026-01-01",
      last_seen: "2026-09-01",
      expected: r.category,
    })),
    null,
    2,
  ) + "\n",
);
await Bun.write(`${dir}examples.json`, JSON.stringify(examples, null, 2) + "\n");
await Bun.write(`${dir}categories.json`, JSON.stringify(categories, null, 2) + "\n");

console.log(`${trimmed.length} cases, ${examples.length} examples, ${categories.length} categories`);
if (ambiguous.length > 0) {
  console.log(`dropped ${ambiguous.length} merchant(s) filed under more than one category: ${ambiguous.join(", ")}`);
}
const overlap = new Set(examples.map((e) => e.merchant));
console.log(`overlap with examples: ${trimmed.filter((c) => overlap.has(c.merchant)).length} (must be 0)`);
await sql.end();
