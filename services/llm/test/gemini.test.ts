import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateJSON, LlmError, type Fetch } from "../src/gemini";

/**
 * The transport, with `fetch` stubbed. No key is ever needed and no request
 * ever leaves the machine: these run in the gate lane beside everything else.
 */

const KEY = "GEMINI_API_KEY";
const MODEL = "GEMINI_MODEL";
let savedKey: string | undefined;
let savedModel: string | undefined;

beforeEach(() => {
  savedKey = process.env[KEY];
  savedModel = process.env[MODEL];
  process.env[KEY] = "test-key";
  process.env[MODEL] = "stub-model";
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY];
  else process.env[KEY] = savedKey;
  if (savedModel === undefined) delete process.env[MODEL];
  else process.env[MODEL] = savedModel;
});

const ok = (text: string): Response =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }), {
    headers: { "content-type": "application/json" },
  });

const call = (fetchImpl: Fetch, attempts = 3) =>
  generateJSON<{ a: number }>({ prompt: "p", schema: { type: "object" }, fetchImpl, attempts });

describe("generateJSON", () => {
  test("parses the candidate text and reports which model answered", async () => {
    const res = await call(async () => ok('{"a":1}'));
    expect(res.data).toEqual({ a: 1 });
    expect(res.model).toBe("stub-model");
  });

  test("sends the key as a header, never in the URL", async () => {
    let url = "";
    let headers: Headers | undefined;
    await call(async (u, init) => {
      url = u;
      headers = new Headers(init.headers);
      return ok("{}");
    });
    expect(url).not.toContain("test-key");
    expect(headers!.get("x-goog-api-key")).toBe("test-key");
  });

  test("a missing key is a clear error and no request at all", async () => {
    delete process.env[KEY];
    let called = false;
    const run = call(async () => {
      called = true;
      return ok("{}");
    });
    expect(run).rejects.toThrow("GEMINI_API_KEY is not set");
    await run.catch(() => {});
    expect(called).toBe(false);
    // Not dressed up as a transient failure, and not retried three times.
    expect(String(await run.catch((e) => e))).not.toContain("request failed");
  });

  test("retries a 503 and succeeds on the second try", async () => {
    let n = 0;
    const res = await call(async () => {
      n = n + 1;
      return n === 1 ? new Response("upstream", { status: 503 }) : ok('{"a":2}');
    });
    expect(n).toBe(2);
    expect(res.data).toEqual({ a: 2 });
  });

  test("does not retry a 400, because the request is what is wrong", async () => {
    let n = 0;
    const run = call(async () => {
      n = n + 1;
      return new Response("bad model", { status: 400 });
    });
    expect(run).rejects.toThrow("HTTP 400");
    await run.catch(() => {});
    expect(n).toBe(1);
  });

  test("gives up after the last attempt rather than looping", async () => {
    let n = 0;
    const run = call(async () => {
      n = n + 1;
      return new Response("busy", { status: 429 });
    });
    expect(run).rejects.toThrow("HTTP 429");
    await run.catch(() => {});
    expect(n).toBe(3);
  });

  test("a truncated answer throws instead of returning half the merchants", async () => {
    const run = call(
      async () =>
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"a":' }] }, finishReason: "MAX_TOKENS" }] }),
        ),
    );
    expect(run).rejects.toThrow("MAX_TOKENS");
  });

  test("a blocked prompt is named, not returned as empty", async () => {
    const run = call(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })));
    expect(run).rejects.toThrow("blocked (SAFETY)");
  });

  test("text that is not JSON is an error carrying what came back", async () => {
    const run = call(async () => ok("I'm sorry, I can't"));
    expect(run).rejects.toThrow("not JSON");
  });

  test("an empty response is an error", async () => {
    const run = call(async () => ok("   "));
    expect(run).rejects.toThrow("empty response");
  });

  test("a network failure retries and then surfaces the cause", async () => {
    let n = 0;
    const run = call(async () => {
      n = n + 1;
      throw new Error("ECONNRESET");
    });
    expect(run).rejects.toThrow("ECONNRESET");
    await run.catch(() => {});
    expect(n).toBe(3);
    expect(await run.catch((e) => e instanceof LlmError)).toBe(true);
  });
});
