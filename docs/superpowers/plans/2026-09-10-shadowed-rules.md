# Shadowed Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Name every categorization rule that can never fire, because an earlier
rule already catches everything it would have.

**Architecture:** `applyRules` takes the first match by `(priority, id)`. So a
rule B is unreachable when an earlier rule A matches every haystack B could
match, and that is decidable from the two patterns alone: if A's needle occurs
inside B's needle, any string containing B's needle contains A's too. The whole
word switch is the only complication, and it is handled by asking whether B's own
text guarantees the boundary A demands. One pure function in `csv-import`, beside
`applyRules`, whose ordering it has to agree with exactly.

**Tech Stack:** Bun, zod, Elysia, Eden treaty, React, Tailwind v4, shadcn/ui.

**Spec:** `docs/superpowers/plans/2026-09-10-README.md` (shared constraints) and
the "Importing statements" section of `README.md`.

## Global Constraints

- Money is always an integer number of cents. No floats, no `DECIMAL`.
- Dates are always `YYYY-MM-DD` strings.
- Query params use `.optional()`, never `.default()`.
- Validation failures are 422 in Elysia's shape, not 400.
- Migrations are forward-only. **This plan adds none.**
- `bun run check` must be green at every commit. Never `--no-verify`.
- `bun test` needs MySQL running.
- **A pattern is user text and may hold regex metacharacters.** Scan with
  `indexOf`, never a built `RegExp`. This is why `matchesPattern` is written the
  way it is, and the new code follows it.

---

## File Structure

- `contracts/types.ts` — **modify.** Export the existing private `isLetter`.
  Duplicating that one-line definition in `csv-import` is exactly the drift
  `matchesPattern` was moved into `contracts` to prevent.
- `services/csv-import/src/shadow.ts` — **create.** `covers` and `shadowedRules`.
  Its own file rather than more of `normalize.ts`, which is already the parser,
  the mapper, the dedupe keys and the rule engine.
- `services/csv-import/src/index.ts` — **modify.** Re-export it.
- `services/api/src/resources.ts` — **modify.** `GET /category-rules/shadowed`,
  registered **before** the `crud("category-rules")` block.
- `apps/web/src/pages/Settings.tsx` — **modify.** A card in the Rules tab.
- Tests: `services/csv-import/test/shadow.test.ts`,
  `services/api/test/api.test.ts`.

---

### Task 1: Decide when one rule swallows another

**Files:**
- Modify: `contracts/types.ts` (the `isLetter` definition, around line 403)
- Create: `services/csv-import/src/shadow.ts`
- Modify: `services/csv-import/src/index.ts`
- Test: `services/csv-import/test/shadow.test.ts`

**Interfaces:**
- Consumes: `needleOf`, `isLetter`, `type CategoryRule` from `@lumpy/contracts`.
- Produces:
  ```ts
  export function covers(a: string, aWhole: boolean, b: string, bWhole: boolean): boolean;
  export type ShadowedRule = { rule: CategoryRule; shadowed_by: CategoryRule; same_category: boolean };
  export function shadowedRules(rules: CategoryRule[]): ShadowedRule[];
  ```

- [ ] **Step 1: Write the failing test**

Create `services/csv-import/test/shadow.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { CategoryRule } from "@lumpy/contracts";
import { shadowedRules } from "../src/shadow";

let seq = 0;
const rule = (p: Partial<CategoryRule> = {}): CategoryRule => ({
  id: ++seq, pattern: "x", whole_word: false, category_id: 1, priority: 100, ...p,
});

describe("shadowedRules", () => {
  test("a broad rule swallows the specific rule behind it", () => {
    const broad = rule({ pattern: "amazon", priority: 100, category_id: 1 });
    const narrow = rule({ pattern: "amazon fresh", priority: 150, category_id: 2 });
    const found = shadowedRules([narrow, broad]);
    expect(found).toHaveLength(1);
    expect(found[0]!.rule.pattern).toBe("amazon fresh");
    expect(found[0]!.shadowed_by.pattern).toBe("amazon");
    expect(found[0]!.same_category).toBe(false);
  });

  test("the specific rule in front of the broad one is fine", () => {
    // This is the ordering that works, and reporting it would train people to
    // ignore the report.
    const narrow = rule({ pattern: "amazon fresh", priority: 100 });
    const broad = rule({ pattern: "amazon", priority: 150 });
    expect(shadowedRules([narrow, broad])).toEqual([]);
  });

  test("two rules that reduce to the same needle are one live rule", () => {
    const first = rule({ pattern: "Wegmans", priority: 100 });
    const second = rule({ pattern: "  wegmans  ", priority: 200 });
    expect(shadowedRules([first, second])[0]!.shadowed_by.id).toBe(first.id);
  });

  test("equal priority is broken by id, the way applyRules breaks it", () => {
    const older = rule({ pattern: "shell", priority: 100 });
    const newer = rule({ pattern: "shell oil", priority: 100 });
    expect(shadowedRules([newer, older])[0]!.rule.id).toBe(newer.id);
  });

  test("a shadow inside one category is named but marked harmless", () => {
    const broad = rule({ pattern: "uber", priority: 100, category_id: 7 });
    const narrow = rule({ pattern: "uber eats", priority: 150, category_id: 7 });
    expect(shadowedRules([narrow, broad])[0]!.same_category).toBe(true);
  });

  describe("the whole-word switch", () => {
    test("a whole-word rule does not shadow one whose edge it sits on", () => {
      // `bp` needs a non-letter on each side. In "ABP FUEL" the plain rule
      // `bp fuel` fires and `bp` does not, so `bp fuel` is reachable.
      const bp = rule({ pattern: "bp", whole_word: true, priority: 100 });
      const bpFuel = rule({ pattern: "bp fuel", whole_word: false, priority: 150 });
      expect(shadowedRules([bpFuel, bp])).toEqual([]);
    });

    test("unless the shadowed rule guarantees the boundary itself", () => {
      // `bp fuel` whole-word promises a non-letter after "fuel" and before "bp",
      // so wherever it fires, `bp` fires too.
      const bp = rule({ pattern: "bp", whole_word: true, priority: 100 });
      const bpFuel = rule({ pattern: "bp fuel", whole_word: true, priority: 150 });
      expect(shadowedRules([bpFuel, bp])).toHaveLength(1);
    });

    test("a boundary in the middle of the needle is guaranteed by the needle", () => {
      // "fuel" sits between a space and a space inside "bp fuel card", so the
      // haystack cannot take the boundary away.
      const fuel = rule({ pattern: "fuel", whole_word: true, priority: 100 });
      const long = rule({ pattern: "bp fuel card", whole_word: false, priority: 150 });
      expect(shadowedRules([long, fuel])).toHaveLength(1);
    });

    test("a plain rule shadows a whole-word rule that contains it", () => {
      const plain = rule({ pattern: "bp", whole_word: false, priority: 100 });
      const strict = rule({ pattern: "bp fuel", whole_word: true, priority: 150 });
      expect(shadowedRules([strict, plain])).toHaveLength(1);
    });
  });

  test("reports the first rule that swallows it, not every one", () => {
    const a = rule({ pattern: "a b", priority: 100 });
    const b = rule({ pattern: "b", priority: 110 });
    const c = rule({ pattern: "x a b y", priority: 200 });
    // "b" is the earlier of the two that cover "x a b y"? No: "a b" is at
    // priority 100 and covers it, so that is the one named.
    expect(shadowedRules([c, b, a])[0]!.shadowed_by.pattern).toBe("a b");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test services/csv-import -t shadowedRules`
Expected: FAIL — cannot resolve `../src/shadow`.

- [ ] **Step 3: Export `isLetter` from contracts**

In `contracts/types.ts`, change the private definition:

```ts
const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);
```

to:

```ts
/**
 * What `whole_word` means by "the end of a word": a letter, not a word
 * character, because a merchant descriptor glues its store number straight onto
 * the name and `bp` has to keep finding BP1234.
 *
 * Exported because the shadowed-rule report has to agree with `matchesPattern`
 * about this exactly. Two definitions of a boundary is two answers to whether a
 * rule can fire.
 */
export const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);
```

- [ ] **Step 4: Write the function**

Create `services/csv-import/src/shadow.ts`:

```ts
import { isLetter, needleOf, type CategoryRule } from "@lumpy/contracts";

/**
 * Does rule A fire on every string rule B fires on?
 *
 * `applyRules` matches with `indexOf` against `merchant + " " + description`,
 * lowercased. So if B fires, the haystack contains B's needle somewhere; and if
 * A's needle sits inside B's needle, that same haystack contains A's needle too.
 * Containment of the needles is the whole test for the plain case.
 *
 * `whole_word` is the only complication, and it is a question about the two
 * characters around A's hit. Inside B's needle they are B's own characters and
 * the haystack cannot change them. At B's edge they belong to the haystack,
 * which may well supply a letter -- unless B is itself whole-word, in which case
 * B has already promised a non-letter there. Anything not guaranteed is not a
 * shadow: this report is only worth reading if every line on it is true.
 *
 * Scanned with `indexOf`, never a built RegExp, for the same reason
 * `matchesPattern` is: a pattern is user text and may hold metacharacters.
 */
export function covers(a: string, aWhole: boolean, b: string, bWhole: boolean): boolean {
  if (a.length === 0) return false;
  for (let at = b.indexOf(a); at !== -1; at = b.indexOf(a, at + 1)) {
    if (!aWhole) return true;
    // undefined means "the haystack decides", and it is allowed to decide with a
    // letter. "" is B's own guarantee of a non-letter at its edge.
    const left = at > 0 ? b[at - 1] : bWhole ? "" : undefined;
    const right = at + a.length < b.length ? b[at + a.length] : bWhole ? "" : undefined;
    if (left !== undefined && right !== undefined && !isLetter(left) && !isLetter(right)) return true;
  }
  return false;
}

/** A rule that can never fire, and the rule in front of it that takes everything. */
export type ShadowedRule = {
  rule: CategoryRule;
  shadowed_by: CategoryRule;
  /** True when both point at the same category, so the outcome is right anyway. */
  same_category: boolean;
};

/**
 * Every rule that can never fire.
 *
 * Rules are tried lowest priority number first, ties by id -- exactly what
 * `applyRules` does, and the two orderings have to stay identical or this
 * reports rules that work and misses rules that do not. A rule is dead when
 * something ahead of it covers it.
 *
 * A shadow inside one category is reported too, marked `same_category`: it is
 * not a wrong answer, only a row that will never do anything, and the page sorts
 * those below the ones that change where money is counted.
 *
 * ponytail: first cover wins rather than all of them. The answer to a dead rule
 * is to delete it or move it, and one culprit is enough to decide which.
 */
export function shadowedRules(rules: CategoryRule[]): ShadowedRule[] {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
  const needles = ordered.map((r) => ({ rule: r, needle: needleOf(r.pattern) }));

  const out: ShadowedRule[] = [];
  for (let i = 0; i < needles.length; i++) {
    const b = needles[i]!;
    const by = needles
      .slice(0, i)
      .find((a) => covers(a.needle, a.rule.whole_word, b.needle, b.rule.whole_word));
    if (by) {
      out.push({ rule: b.rule, shadowed_by: by.rule, same_category: by.rule.category_id === b.rule.category_id });
    }
  }
  return out;
}
```

- [ ] **Step 5: Re-export it**

In `services/csv-import/src/index.ts`, add:

```ts
export * from "./shadow";
```

- [ ] **Step 6: Run the tests**

Run: `bun test services/csv-import`
Expected: PASS, every case in the new file plus the existing parse/normalize/match
suites untouched.

- [ ] **Step 7: Commit**

```bash
git add contracts/types.ts services/csv-import/src/shadow.ts \
        services/csv-import/src/index.ts services/csv-import/test/shadow.test.ts
git commit -m "A rule behind a broader rule is a rule that never runs"
```

---

### Task 2: Ask the API which rules are dead

**Files:**
- Modify: `services/api/src/resources.ts:105-127`
- Test: `services/api/test/api.test.ts`

**Interfaces:**
- Consumes: `shadowedRules` from `@lumpy/csv-import`, `store.categoryRules()`.
- Produces: `GET /api/category-rules/shadowed` returning
  `{ pattern, category_id, priority, id, shadowed_by: { id, pattern, priority, category_id }, same_category }[]`,
  different-category first.

- [ ] **Step 1: Write the failing test**

Append to `services/api/test/api.test.ts`:

```ts
describe("shadowed rules", () => {
  beforeEach(() => resetDb());

  test("names the rule that can never fire and the one taking its traffic", async () => {
    const shopping = await post("/api/categories", { name: "Shopping", bucket: "discretionary", icon: "bag", color: null });
    const groceries = await post("/api/categories", { name: "Groceries", bucket: "discretionary", icon: "cart", color: null });
    await post("/api/category-rules", { pattern: "amazon", whole_word: false, category_id: shopping.body.id, priority: 100 });
    const dead = await post("/api/category-rules", { pattern: "amazon fresh", whole_word: false, category_id: groceries.body.id, priority: 150 });

    const body = (await api("/api/category-rules/shadowed")).body;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: dead.body.id, pattern: "amazon fresh", same_category: false,
      shadowed_by: { pattern: "amazon" },
    });
  });

  test("is empty when every rule can fire", async () => {
    const c = await post("/api/categories", { name: "Groceries", bucket: "discretionary", icon: "cart", color: null });
    await post("/api/category-rules", { pattern: "amazon fresh", whole_word: false, category_id: c.body.id, priority: 100 });
    await post("/api/category-rules", { pattern: "amazon", whole_word: false, category_id: c.body.id, priority: 150 });
    expect((await api("/api/category-rules/shadowed")).body).toEqual([]);
  });

  test("the route is not read as a rule id", async () => {
    // `/category-rules/:id` would try to parse "shadowed" as an id and 422 if
    // this were registered after the crud block. Same trap as /merge.
    expect((await api("/api/category-rules/shadowed")).status).toBe(200);
  });

  test("a shadow inside one category is reported below one that crosses categories", async () => {
    const a = await post("/api/categories", { name: "Travel", bucket: "discretionary", icon: "plane", color: null });
    const b = await post("/api/categories", { name: "Dining", bucket: "discretionary", icon: "utensils", color: null });
    await post("/api/category-rules", { pattern: "uber", whole_word: false, category_id: a.body.id, priority: 100 });
    await post("/api/category-rules", { pattern: "uber pool", whole_word: false, category_id: a.body.id, priority: 150 });
    await post("/api/category-rules", { pattern: "uber eats", whole_word: false, category_id: b.body.id, priority: 160 });

    const body = (await api("/api/category-rules/shadowed")).body;
    expect(body.map((r: { pattern: string }) => r.pattern)).toEqual(["uber eats", "uber pool"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test services/api -t "shadowed rules"`
Expected: FAIL — 422, because `/category-rules/:id` is matching and
`"shadowed"` is not a positive integer.

- [ ] **Step 3: Add the route before the crud block**

In `services/api/src/resources.ts`, add `shadowedRules` to the
`@lumpy/csv-import` imports at the top:

```ts
import { shadowedRules } from "@lumpy/csv-import";
```

Then, directly above `export const resources = new Elysia({ prefix: "/api" })`,
add:

```ts
/**
 * Rules that can never fire, because something ahead of them takes everything
 * they would have matched.
 *
 * Registered before the crud block for the same reason `/merge` is:
 * `/category-rules/:id` would otherwise try to read "shadowed" as an id.
 *
 * Cross-category shadows first. Those are the ones that put money in the wrong
 * place; a rule shadowed inside its own category is dead weight and nothing
 * more, and burying it below the real findings is the difference between a
 * report people read and one they learn to close.
 */
const categoryRuleShadows = new Elysia({ name: "category-rule-shadows" }).get(
  "/category-rules/shadowed",
  async () => {
    const found = shadowedRules(await store.categoryRules());
    return found
      .map((s) => ({
        id: s.rule.id,
        pattern: s.rule.pattern,
        category_id: s.rule.category_id,
        priority: s.rule.priority,
        same_category: s.same_category,
        shadowed_by: {
          id: s.shadowed_by.id,
          pattern: s.shadowed_by.pattern,
          category_id: s.shadowed_by.category_id,
          priority: s.shadowed_by.priority,
        },
      }))
      .sort((a, b) => Number(a.same_category) - Number(b.same_category));
  },
);
```

Then register it in the chain, immediately after `.use(categoryRuleMerge)` and
**before** `.use(crud("category-rules", ...))`:

```ts
  .use(categoryRuleMerge)
  .use(categoryRuleShadows)
  .use(crud("category-rules", "category_rules", categoryRuleInput, categoryRule))
```

- [ ] **Step 4: Run the API suite**

Run: `bun test services/api`
Expected: PASS. `.sort` on `Number(same_category)` is stable in Bun, so within a
group the `shadowedRules` order (priority, then id) survives, which is what the
fourth test asserts.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/resources.ts services/api/test/api.test.ts
git commit -m "Ask the rules which of them are already unreachable"
```

---

### Task 3: Show it where the rules are edited

**Files:**
- Modify: `apps/web/src/pages/Settings.tsx` (the `rules` `TabsContent`, around
  line 147)

**Interfaces:**
- Consumes: `GET /api/category-rules/shadowed` through Eden.
- Produces: nothing other tasks read.

- [ ] **Step 1: Fetch it**

In `apps/web/src/pages/Settings.tsx`, beside the existing
`const rules = useApi(["category-rules"], ...)` on line 37:

```tsx
  const shadowed = useApi(["category-rules-shadowed"], () => eden.api["category-rules"].shadowed.get());
```

If Eden's path builder rejects `.shadowed` on that node, use
`eden.api["category-rules"]["shadowed"].get()`.

- [ ] **Step 2: Render the card above the rules table**

Inside `<TabsContent value="rules">`, directly before the existing
`<Card>` that holds "Categorization rules", add:

```tsx
            {(shadowed.data ?? []).length > 0 ? (
              <Card className="mb-4">
                <CardHeader>
                  <CardTitle>Rules that can never fire</CardTitle>
                  <CardDescription>
                    A rule is tried lowest priority number first, and the first match wins. These rules sit behind
                    one that already catches everything they would have. Give one a lower priority number than the
                    rule named beside it, or delete it.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Never fires</TableHead>
                        <TableHead>Because of</TableHead>
                        <TableHead className="text-right">Effect</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(shadowed.data ?? []).map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-mono text-xs">
                            {s.pattern} <span className="text-muted-foreground">· {s.priority}</span>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {s.shadowed_by.pattern} <span className="text-muted-foreground">· {s.shadowed_by.priority}</span>
                          </TableCell>
                          <TableCell className="text-right">
                            {/* A shadow inside one category still lands in the
                                right place. It is clutter, not a wrong number,
                                and saying so is what keeps the real findings
                                worth looking at. */}
                            <Badge variant={s.same_category ? "secondary" : "default"}>
                              {s.same_category ? "same category" : "wrong category"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : null}
```

`Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `Table`,
`TableHeader`, `TableRow`, `TableHead`, `TableBody`, `TableCell` and `Badge` are
all already imported by this file, so this step adds no import.

- [ ] **Step 3: Typecheck and lint**

Run: `bun run typecheck && bun run --cwd apps/web lint`
Expected: PASS.

- [ ] **Step 4: See it with the seeded rules**

```bash
bun run reset --yes
bun run dev
```
Open http://localhost:5173/settings, Rules tab. The ~94 seeded rules should
produce few or no findings; add a rule `wegmans gas` at priority 300 and confirm
it appears, named against `wegmans`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Settings.tsx
git commit -m "Name the dead rules on the page where rules get written"
```

---

### Task 4: Write it down

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `README.md`, under "Importing statements"**

After the paragraph explaining priority order:

```markdown
Because the first match wins, a broad rule in front of a specific one makes the
specific one dead code, and nothing used to say so: `amazon` at priority 100
means `amazon fresh` at 150 never runs, and every grocery order lands in
Shopping. Settings -> Rules names every rule that can never fire and the rule
taking its traffic. A shadow inside one category is listed too and marked as
such: the answer is still right, the row is just never used.
```

- [ ] **Step 2: `CLAUDE.md`, under the traps list**

```markdown
- **`shadowedRules` must sort exactly the way `applyRules` does** -- priority
  ascending, ties by id -- or it reports rules that work and stays quiet about
  rules that do not. `covers` decides containment on the needles alone, which is
  sound because `applyRules` matches with `indexOf`: a haystack holding B's
  needle holds A's too. `whole_word` is the only wrinkle, and an unguaranteed
  boundary is never called a shadow -- at B's own edge the haystack picks the
  neighbouring character, and it is allowed to pick a letter. `isLetter` is
  exported from `contracts` rather than rewritten here, for the same reason
  `matchesPattern` lives there.
```

- [ ] **Step 3: Full gate lane**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit and push**

```bash
git add README.md CLAUDE.md
git commit -m "Write down why a needle inside a needle is a dead rule"
git push
```

**Restart after merging:** restart the API (`bun run api`). No migration. The web
app needs no restart in dev.

---

## Self-Review

**Spec coverage.** Detection (Task 1), route ordered ahead of the id route
(Task 2), UI where rules are edited (Task 3), docs (Task 4). The
same-category-versus-different-category distinction is carried end to end.

**Placeholders.** None. The one open choice is Eden's path syntax for a
segment with a hyphen in the parent, and the step names the bracket form to use
if the dotted one is rejected.

**Type consistency.** `covers(a, aWhole, b, bWhole)` has the same parameter order
in its definition and in the one call inside `shadowedRules`. `ShadowedRule`'s
fields are `rule`, `shadowed_by`, `same_category`; the route flattens `rule` and
keeps `shadowed_by` and `same_category`, which is what both the API tests and the
Settings table read.
