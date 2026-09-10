import { describe, expect, test } from "bun:test";
import { matchesPattern, needleOf, type CategoryRule } from "@lumpy/contracts";
import { applyRules } from "../src/normalize";
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

/**
 * The tests above check `shadowedRules` against what it says it does. This one
 * checks it against `applyRules`, which is the only thing it has to be right
 * about: a rule on the report must never win a row, and a rule off the report
 * must win at least one.
 *
 * Thousands of small rule sets drawn from a seeded generator over a tiny
 * alphabet, so needles contain each other constantly. Letters, a digit, a space
 * and a hyphen, because those are the characters that decide a whole-word
 * boundary; upper case, because a pattern is lowercased before it is a needle.
 * "z" is kept out of every pattern so it can stand in for "a letter the rules
 * have never heard of".
 *
 * Seeded, not random: same input, same answer, and a failure names the rule set
 * that broke it.
 */
describe("shadowedRules agrees with applyRules", () => {
  // mulberry32
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rand = prng(20260910);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: ArrayLike<T>) => xs[int(0, xs.length - 1)]!;
  const text = (alphabet: string, lo: number, hi: number) =>
    Array.from({ length: int(lo, hi) }, () => pick(alphabet)).join("");

  const PATTERN = "abAB1 -";
  const NOISE = "abz1 -";

  const ruleSet = (): CategoryRule[] => {
    const n = int(2, 5);
    const out: CategoryRule[] = [];
    for (let id = 1; id <= n; id++) {
      let pattern = "";
      while (needleOf(pattern).length === 0) pattern = text(PATTERN, 1, 4);
      // category_id = id, so the category a row lands in names the rule that won it.
      out.push({ id, pattern, whole_word: rand() < 0.4, category_id: id, priority: pick([10, 20, 20, 30]) });
    }
    // Handed over out of order: the priority/id sort is part of what is tested.
    return out.sort(() => rand() - 0.5);
  };

  const winner = (rules: CategoryRule[], merchant: string, description: string) =>
    applyRules([{ merchant, description, category_id: null as number | null }], rules)[0]!.category_id;

  test("a reported rule never wins, and an unreported rule wins its witness", () => {
    let live = 0, dead = 0, deadBehindWholeWord = 0, fuzzed = 0;
    for (let set = 0; set < 3000; set++) {
      const rules = ruleSet();
      const found = new Map(shadowedRules(rules).map((s) => [s.rule.id, s]));
      for (const b of rules) {
        const needle = needleOf(b.pattern);
        const label = `${JSON.stringify(rules)} rule ${b.id}`;
        const shadow = found.get(b.id);
        if (!shadow) {
          // The haystack that proves it can fire. Whole-word: the needle alone,
          // whose edges are the string's edges. Plain: the needle wrapped in a
          // letter no pattern holds, which takes every edge boundary away from
          // the rules in front of it.
          live++;
          const merchant = b.whole_word ? needle : `z${needle}z`;
          expect(winner(rules, merchant, ""), label).toBe(b.id);
          continue;
        }
        dead++;
        if (shadow.shadowed_by.whole_word) deadBehindWholeWord++;
        for (let k = 0; k < 20; k++) {
          const merchant = text(NOISE, 0, 3) + needle + text(NOISE, 0, 3);
          const description = text(NOISE, 0, 3);
          if (!matchesPattern(`${merchant} ${description}`.toLowerCase(), needle, b.whole_word)) continue;
          fuzzed++;
          const got = winner(rules, merchant, description);
          expect(got, `${label} on ${JSON.stringify(merchant)}`).not.toBe(b.id);
          expect(got, `${label} on ${JSON.stringify(merchant)}`).not.toBeNull();
        }
      }
    }
    // Guard against a generator that stopped producing the interesting cases
    // (at seed 20260910: 8966 live, 1596 dead, 219 behind a whole-word rule,
    // 23491 fuzzed haystacks). Mutating `covers` to try only the first
    // occurrence of A in B is caught here and by none of the cases above.
    expect(live).toBeGreaterThan(1000);
    expect(dead).toBeGreaterThan(1000);
    expect(deadBehindWholeWord).toBeGreaterThan(200);
    expect(fuzzed).toBeGreaterThan(10000);
  });
});
