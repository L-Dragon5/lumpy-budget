import { describe, expect, test } from "bun:test";
import type { Category, UncategorizedMerchant } from "@lumpy/contracts";
import {
  buildPrompt, CHUNK, classifyMerchants, EXAMPLES_MAX, EXAMPLES_PER_CATEGORY, pickExamples, readProposals,
  type Example, type RawAssignments,
} from "../src/classify";

const cats: Category[] = [
  { id: 1, name: "Groceries", bucket: "discretionary", icon: null, color: null },
  { id: 2, name: "Dining", bucket: "discretionary", icon: null, color: null },
  { id: 24, name: "Income", bucket: "income", icon: null, color: null },
];

const merchant = (m: Partial<UncategorizedMerchant> & { merchant: string }): UncategorizedMerchant => ({
  description: "",
  count: 1,
  total_cents: 1000,
  first_seen: "2026-01-01",
  last_seen: "2026-01-01",
  ...m,
});

const answer = (assignments: RawAssignments["assignments"]): RawAssignments => ({ assignments });

describe("buildPrompt", () => {
  test("carries every category with its bucket and every merchant with a signed total", () => {
    const p = buildPrompt([merchant({ merchant: "EVERTRUE INC", total_cents: -450000, count: 6 })], cats);
    expect(p).toContain("24\tIncome\t(income)");
    expect(p).toContain("2\tDining\t(discretionary)");
    expect(p).toContain('"EVERTRUE INC"');
    // The minus is the whole point: without it a paycheck reads as a purchase.
    expect(p).toContain("-$4500.00");
    expect(p).toContain("6 transaction(s)");
  });

  test("carries the household's own filing, and says its conventions win", () => {
    const p = buildPrompt([merchant({ merchant: "X" })], cats, [{ category_id: 2, merchant: "UBER   *TRIP" }]);
    expect(p).toContain("2\tUBER   *TRIP");
    expect(p).toContain("do not correct it");
  });

  test("no examples means no examples section at all, not an empty heading", () => {
    expect(buildPrompt([merchant({ merchant: "X" })], cats, [])).not.toContain("ALREADY FILES");
  });

  test("includes the bank description when there is one and omits the line when there is not", () => {
    expect(buildPrompt([merchant({ merchant: "SQ *X", description: "COFFEE" })], cats)).toContain("bank description");
    expect(buildPrompt([merchant({ merchant: "SQ *X", description: "   " })], cats)).not.toContain("bank description");
  });
});

describe("pickExamples", () => {
  const many = (categoryId: number, n: number): Example[] =>
    Array.from({ length: n }, (_, i) => ({ category_id: categoryId, merchant: `c${categoryId}-m${i}` }));

  test("caps each category, so the one with a hundred merchants cannot crowd out the one with three", () => {
    const picked = pickExamples([...many(1, 40), ...many(2, 2)], cats);
    expect(picked.filter((e) => e.category_id === 1)).toHaveLength(EXAMPLES_PER_CATEGORY);
    expect(picked.filter((e) => e.category_id === 2)).toHaveLength(2);
  });

  test("keeps the order it was given inside a category: busiest merchant first", () => {
    expect(pickExamples(many(1, 3), cats).map((e) => e.merchant)).toEqual(["c1-m0", "c1-m1", "c1-m2"]);
  });

  test("walks the category list, not the rows, so the prompt does not move with the query plan", () => {
    const shuffled = [...many(24, 2), ...many(1, 2)];
    expect(pickExamples(shuffled, cats).map((e) => e.category_id)).toEqual([1, 1, 24, 24]);
  });

  test("a category with nothing filed in it contributes nothing", () => {
    expect(pickExamples(many(1, 1), cats).every((e) => e.category_id === 1)).toBe(true);
  });

  test("capped overall", () => {
    const wide = Array.from({ length: 300 }, (_, i) => ({ category_id: 1 + (i % 3), merchant: `m${i}` }));
    expect(pickExamples(wide, cats).length).toBeLessThanOrEqual(EXAMPLES_MAX);
  });
});

describe("readProposals", () => {
  const asked = [merchant({ merchant: "Wegmans" }), merchant({ merchant: "Kusshi" })];

  test("keeps a well-formed assignment and carries the merchant's own facts through", () => {
    const { proposals, unresolved } = readProposals(
      answer([
        { merchant: "Wegmans", category_id: 1, confidence: 0.9, reason: "supermarket" },
        { merchant: "Kusshi", category_id: 2, confidence: 0.8, reason: "sushi" },
      ]),
      asked,
      cats,
    );
    expect(unresolved).toEqual([]);
    expect(proposals[0]).toMatchObject({ merchant: "Wegmans", category_id: 1, confidence: 0.9, count: 1 });
  });

  test("drops a category id that does not exist here rather than passing it to the writer", () => {
    const { proposals, unresolved } = readProposals(
      answer([{ merchant: "Wegmans", category_id: 999, confidence: 1, reason: "invented" }]),
      asked,
      cats,
    );
    expect(proposals).toEqual([]);
    expect(unresolved.map((m) => m.merchant)).toEqual(["Wegmans", "Kusshi"]);
  });

  test("drops a merchant nobody asked about", () => {
    const { proposals } = readProposals(
      answer([{ merchant: "Hallucinated Cafe", category_id: 2, confidence: 1, reason: "" }]),
      asked,
      cats,
    );
    expect(proposals).toEqual([]);
  });

  test("first answer wins when one merchant is answered twice", () => {
    const { proposals } = readProposals(
      answer([
        { merchant: "Wegmans", category_id: 1, confidence: 0.9, reason: "first" },
        { merchant: "Wegmans", category_id: 2, confidence: 0.1, reason: "second" },
      ]),
      asked,
      cats,
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.reason).toBe("first");
  });

  test("confidence is clamped and a missing one is zero, not certainty", () => {
    const { proposals } = readProposals(
      answer([
        { merchant: "Wegmans", category_id: 1, confidence: 7, reason: "" },
        { merchant: "Kusshi", category_id: 2, reason: "" },
      ]),
      asked,
      cats,
    );
    expect(proposals.find((p) => p.merchant === "Wegmans")!.confidence).toBe(1);
    expect(proposals.find((p) => p.merchant === "Kusshi")!.confidence).toBe(0);
  });

  test("a reason longer than the column is cut, not rejected", () => {
    const { proposals } = readProposals(
      answer([{ merchant: "Wegmans", category_id: 1, confidence: 1, reason: "x".repeat(500) }]),
      asked,
      cats,
    );
    expect(proposals[0]!.reason).toHaveLength(200);
  });

  test("an empty or malformed answer leaves every merchant unresolved", () => {
    expect(readProposals({}, asked, cats).unresolved).toHaveLength(2);
    expect(readProposals(answer([{ category_id: 1 }]), asked, cats).unresolved).toHaveLength(2);
  });
});

describe("classifyMerchants", () => {
  test("chunks, and every merchant in a chunk is both asked about and accounted for", async () => {
    const many = Array.from({ length: CHUNK + 3 }, (_, i) => merchant({ merchant: `M${i}` }));
    const prompts: string[] = [];
    const res = await classifyMerchants(many, cats, [], async (prompt: string) => {
      prompts.push(prompt);
      // Answer only the merchants this prompt actually named.
      const named = many.filter((m) => prompt.includes(`"${m.merchant}"`));
      return {
        data: answer(named.map((m) => ({ merchant: m.merchant, category_id: 1, confidence: 0.5, reason: "" }))),
        model: "stub",
      };
    });

    expect(prompts).toHaveLength(2);
    expect(res.proposals).toHaveLength(CHUNK + 3);
    expect(res.unresolved).toEqual([]);
    expect(res.model).toBe("stub");
  });

  test("least confident first, then the merchant with the most transactions", async () => {
    const asked = [
      merchant({ merchant: "sure" }),
      merchant({ merchant: "vague-few", count: 1 }),
      merchant({ merchant: "vague-many", count: 9 }),
    ];
    const res = await classifyMerchants(asked, cats, [], async () => ({
      data: answer([
        { merchant: "sure", category_id: 1, confidence: 0.99, reason: "" },
        { merchant: "vague-few", category_id: 1, confidence: 0.2, reason: "" },
        { merchant: "vague-many", category_id: 1, confidence: 0.2, reason: "" },
      ]),
      model: "stub",
    }));
    expect(res.proposals.map((p) => p.merchant)).toEqual(["vague-many", "vague-few", "sure"]);
  });

  test("a chunk that fails fails the batch, so nothing looks complete that is not", async () => {
    const many = Array.from({ length: CHUNK + 1 }, (_, i) => merchant({ merchant: `M${i}` }));
    let calls = 0;
    const run = classifyMerchants(many, cats, [], async () => {
      calls = calls + 1;
      if (calls === 2) throw new Error("upstream 503");
      return { data: answer([]), model: "stub" };
    });
    expect(run).rejects.toThrow("upstream 503");
  });
});
