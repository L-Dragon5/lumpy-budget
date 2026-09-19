/**
 * Which models this key can actually reach.
 *
 *   bun run llm:models
 *
 * A model name is a moving target, so `DEFAULT_MODEL` in `services/llm` is a
 * guess until this has been run against a real key. Set `GEMINI_MODEL` in .env
 * to override it without touching the code.
 */
import { listModels, model } from "@lumpy/llm";

const found = await listModels();
console.log(`${found.length} models reachable. Currently configured: ${model()}\n`);
for (const m of found) console.log(`  ${m.name.padEnd(42)} ${m.displayName}`);
