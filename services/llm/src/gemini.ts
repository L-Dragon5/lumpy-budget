/**
 * The one place in the app that talks to a model.
 *
 * Everything above it is pure: `classify.ts` builds a prompt and reads a
 * response, and neither half needs a key or a network to be tested. This file
 * is the seam -- swap it for a stub and the whole classifier runs in the gate
 * lane.
 *
 * Google's API rather than the local Claude Code the other services would use:
 * asked for explicitly. The key lives in `GEMINI_API_KEY` and is never logged,
 * never echoed in an error, and never reaches the browser -- the web app calls
 * `POST /api/classify`, and the server calls this.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Overridden with `GEMINI_MODEL`. `bun run llm:models` lists what the key can
 * actually reach, which is the only honest way to pick one -- a model name is a
 * moving target and a wrong one is a 404 at the worst moment.
 *
 * Flash-Lite rather than a Pro: this is classification against a list of 26
 * categories with the household's own filing in the prompt, and `eval:classify`
 * is what says whether that holds. Change it here, re-run the eval, and keep the
 * score in the commit message.
 */
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

export const model = (): string => process.env.GEMINI_MODEL || DEFAULT_MODEL;

/**
 * Just the call signature. `typeof fetch` in Bun carries `preconnect` as well,
 * which a stub has no reason to implement.
 */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** A JSON Schema subset Gemini accepts as `responseSchema`. */
export type ResponseSchema = Record<string, unknown>;

export class LlmError extends Error {
  // Assigned in the body rather than a parameter property: `erasableSyntaxOnly`
  // is on, and a parameter property is syntax that has to be compiled away.
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new LlmError("GEMINI_API_KEY is not set. Put it in .env; it never leaves the server.");
  return key;
}

/** Retried once each: a transient upstream failure should not cost a 191-merchant batch. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export type GenerateOptions = {
  prompt: string;
  /** Structured output. Gemini then returns JSON with no fence to strip and no prose to skip past. */
  schema: ResponseSchema;
  /** 0 by default: this is classification, not writing. Same merchants, same answer. */
  temperature?: number;
  /** Milliseconds. A 200-merchant batch on a thinking model is genuinely slow. */
  timeoutMs?: number;
  attempts?: number;
  /** Injected by the tests. Left alone, it is the real `fetch`. */
  fetchImpl?: Fetch;
};

/**
 * One request, one parsed JSON object.
 *
 * Throws rather than returning a partial answer: a caller that cannot tell a
 * refusal from an empty result writes an empty result to the database.
 */
export async function generateJSON<T>(opts: GenerateOptions): Promise<{ data: T; model: string }> {
  const name = model();
  // Read once, outside the loop: a missing key is not a transient failure, and
  // throwing it from inside the try would dress it up as "request failed".
  const key = apiKey();
  const doFetch = opts.fetchImpl ?? fetch;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0,
      responseMimeType: "application/json",
      responseSchema: opts.schema,
    },
  });

  let last: LlmError | null = null;
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await doFetch(`${ENDPOINT}/${encodeURIComponent(name)}:generateContent`, {
        method: "POST",
        // Header, not a query string: a key in a URL lands in every access log
        // between here and Google.
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
    } catch (e) {
      last = new LlmError(`${name}: request failed (${e instanceof Error ? e.message : String(e)})`);
      if (i + 1 < attempts) continue;
      throw last;
    }

    if (!res.ok) {
      // The body carries Google's own message, which is the useful half. It can
      // hold the request but never the key -- that went in a header.
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      last = new LlmError(`${name}: HTTP ${res.status} ${detail}`, res.status);
      if (RETRYABLE.has(res.status) && i + 1 < attempts) continue;
      throw last;
    }

    const payload = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    const blocked = payload.promptFeedback?.blockReason;
    if (blocked) throw new LlmError(`${name}: prompt blocked (${blocked})`);

    const candidate = payload.candidates?.[0];
    // MAX_TOKENS is the failure that looks like success: truncated JSON parses
    // as nothing, or worse, parses as half the merchants.
    if (candidate?.finishReason && candidate.finishReason !== "STOP") {
      throw new LlmError(`${name}: finished as ${candidate.finishReason}`);
    }
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text.trim()) throw new LlmError(`${name}: empty response`);

    try {
      return { data: JSON.parse(text) as T, model: name };
    } catch {
      throw new LlmError(`${name}: response was not JSON (${text.slice(0, 200)})`);
    }
  }
  throw last ?? new LlmError(`${name}: no attempts made`);
}

/** `bun run llm:models`. Which models this key can reach, best guess first. */
export async function listModels(): Promise<{ name: string; displayName: string }[]> {
  const res = await fetch(`${ENDPOINT}?pageSize=200`, { headers: { "x-goog-api-key": apiKey() } });
  if (!res.ok) throw new LlmError(`list models: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
  const body = (await res.json()) as {
    models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
  };
  return (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => ({ name: m.name.replace(/^models\//, ""), displayName: m.displayName ?? "" }));
}
