import { z } from "zod";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: CORS });

export const fail = (message: string, status = 400, extra: object = {}): Response =>
  json({ error: message, ...extra }, status);

export const preflight = (): Response => new Response(null, { status: 204, headers: CORS });

/** Every write goes through a schema. A bad body is a 400 with the offending fields, not a 500. */
export async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<
  { ok: true; data: z.infer<T> } | { ok: false; response: Response }
> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: fail("body is not valid JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: fail("validation failed", 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      }),
    };
  }
  return { ok: true, data: parsed.data };
}

export function intParam(value: string | null, fallback: number): number {
  // Number(null) is 0, not NaN, so a missing param would silently become zero
  // and clamp every default to its minimum. Check for absence first.
  if (value === null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export const isMonth = (s: string | null): s is string => !!s && /^\d{4}-\d{2}$/.test(s);
export const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * MySQL's constraint errors are user errors, not server errors: a duplicate
 * expense means "you already entered this", and it should read that way.
 */
export function dbError(err: unknown): Response {
  const e = err as { errno?: number; message?: string };
  if (e?.errno === 1062) return fail("that record already exists", 409);
  if (e?.errno === 1451 || e?.errno === 1452) return fail("that record is referenced by something else", 409);
  throw err;
}

export async function guard(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    return dbError(err);
  }
}
