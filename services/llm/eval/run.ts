/**
 * The paid lane. `bun run eval:classify`.
 *
 *   PASS is 0.85 agreement with what this household actually filed.
 *
 * Not a gate test: it calls a real model, costs money and is allowed to move a
 * point either way between runs. The gate lane pins the plumbing -- the prompt
 * carries what it claims to, a hallucinated category id never reaches the
 * writer -- and this is the only thing that can say whether the answers are any
 * good. A prompt change that passes every unit test and loses ten points here
 * is a prompt change that has to be reverted, which is the whole reason the
 * number exists.
 *
 * The ground truth is `cases.json`, held out from `examples.json` by
 * `bun run eval:build`. Rebuild both together or the score is measuring how
 * well a model copies.
 */
import type { Category, UncategorizedMerchant } from "@lumpy/contracts";
import { classifyMerchants, type Example } from "../src/classify";
import { generateJSON, model } from "../src/gemini";

const PASS = 0.85;
/** A confident miss is worse than an unsure one: it is the row a person scrolls past. */
const UNSURE = 0.5;

type Case = UncategorizedMerchant & { expected: string };

const dir = new URL(".", import.meta.url).pathname;
/** The fixture is gitignored, so a fresh clone lands here first. Say what to run. */
const load = async <T>(name: string): Promise<T> => {
  const file = Bun.file(`${dir}${name}`);
  if (!(await file.exists())) {
    console.error(`${name} is missing. It is built from the live ledger and gitignored: run \`bun run eval:build\`.`);
    process.exit(1);
  }
  return (await file.json()) as T;
};

const cases = await load<Case[]>("cases.json");
const examples = await load<Example[]>("examples.json");
const categories = await load<Category[]>("categories.json");
const nameOf = new Map(categories.map((c) => [c.id, c.name]));

const merchants: UncategorizedMerchant[] = cases.map(({ expected: _expected, ...m }) => m);
const started = Date.now();
const res = await classifyMerchants(merchants, categories, examples, (prompt, schema) =>
  generateJSON<unknown>({ prompt, schema }),
);

const got = new Map(res.proposals.map((p) => [p.merchant, p]));
type Miss = { merchant: string; expected: string; got: string; confidence: number };
const misses: Miss[] = [];
let hits = 0;
let confidentMisses = 0;

for (const c of cases) {
  const p = got.get(c.merchant);
  const actual = p ? (nameOf.get(p.category_id) ?? `#${p.category_id}`) : "(no answer)";
  if (actual === c.expected) {
    hits = hits + 1;
    continue;
  }
  const confidence = p?.confidence ?? 0;
  if (confidence >= UNSURE) confidentMisses = confidentMisses + 1;
  misses.push({ merchant: c.merchant, expected: c.expected, got: actual, confidence });
}

const score = cases.length === 0 ? 0 : hits / cases.length;
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\nmodel        ${model()}`);
console.log(`cases        ${cases.length} (${examples.length} worked examples in the prompt)`);
console.log(`agreement    ${(score * 100).toFixed(1)}%  (${hits}/${cases.length}), threshold ${(PASS * 100).toFixed(0)}%`);
console.log(`unresolved   ${res.unresolved.length}`);
console.log(`confident misses ${confidentMisses}  (wrong and sure of it: the ones a person will not catch)`);
console.log(`took         ${seconds}s\n`);

if (misses.length > 0) {
  console.log("misses, least certain last:");
  for (const m of [...misses].sort((a, b) => b.confidence - a.confidence)) {
    console.log(`  ${m.confidence.toFixed(2)}  ${m.merchant.padEnd(44)} want ${m.expected.padEnd(20)} got ${m.got}`);
  }
  console.log("");
}

if (score < PASS) {
  console.log(`FAIL: ${(score * 100).toFixed(1)}% is below the ${(PASS * 100).toFixed(0)}% threshold.`);
  process.exit(1);
}
console.log("PASS");
