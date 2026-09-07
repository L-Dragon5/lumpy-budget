import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { z } from "zod";

/**
 * Response schemas are only worth having if Elysia enforces them for zod, which
 * is not obvious from the docs. These two tests are the proof, and the guard: if
 * an upgrade makes standard-schema response validation a no-op, the response
 * schemas across the API become dead code and this fails first.
 */
const schema = z.object({ created_at: z.string(), n: z.number() });

const app = new Elysia()
  .get("/ok", () => ({ created_at: "2026-01-01T00:00:00.000Z", n: 1 }), { response: schema })
  // The exact shape of the bug this was added for: import_batches.created_at is a
  // TIMESTAMP, and the driver hands back a Date unless services/db coerces it.
  .get("/date", () => ({ created_at: new Date(), n: 1 }) as never, { response: schema })
  .get("/extra", () => ({ created_at: "x", n: 1, undeclared: "leak" }) as never, { response: schema });

const get = async (path: string) => {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
};

describe("response validation", () => {
  test("a well-formed response passes through untouched", async () => {
    expect(await get("/ok")).toEqual({ status: 200, body: { created_at: "2026-01-01T00:00:00.000Z", n: 1 } });
  });

  test("a Date where the contract says string is a 422, not a silent ISO string", async () => {
    const res = await get("/date");
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ type: "validation", on: "response", property: "created_at" });
  });

  test("a column the contract does not declare is stripped, not leaked", async () => {
    const res = await get("/extra");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created_at: "x", n: 1 });
    // Note the consequence: adding a DB column without adding it to
    // contracts/types.ts makes it invisible to the client rather than an error.
    expect(res.body).not.toHaveProperty("undeclared");
  });
});
