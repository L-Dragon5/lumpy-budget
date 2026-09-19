import type { Category, UncategorizedMerchant } from "@lumpy/contracts";
import { classifyMerchants, type Example, type Generate } from "./classify";
import { generateJSON } from "./gemini";

export * from "./classify";
export * from "./gemini";

/** The real thing: `classifyMerchants` wired to Gemini. */
export const geminiGenerate: Generate = (prompt, schema) => generateJSON<unknown>({ prompt, schema });

export const classify = (
  merchants: UncategorizedMerchant[],
  categories: Category[],
  examples: Example[] = [],
  generate: Generate = geminiGenerate,
) => classifyMerchants(merchants, categories, examples, generate);
