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
