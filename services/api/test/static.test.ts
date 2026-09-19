import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spa } from "../src/static";

/**
 * No database: this is the one part of the API that answers without touching one.
 * The container serves the built app off the same port as /api, so the two have to
 * share a router without either one eating the other's requests.
 */
const dir = join(import.meta.dir, "fixtures", "dist-fake");
const secret = join(import.meta.dir, "fixtures", "not-served.txt");

beforeAll(() => {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>lumpy</title>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  writeFileSync(secret, "DATABASE_URL=nope");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(secret, { force: true });
});

// The real shape: the API first, the static handler last.
const served = new Elysia()
  .get("/api/ping", () => ({ ok: true }))
  .use(spa(dir));

const get = async (path: string) => {
  const res = await served.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.text() };
};

describe("serving the built app beside the API", () => {
  test("a declared API route beats the wildcard", async () => {
    expect(await get("/api/ping")).toEqual({ status: 200, body: '{"ok":true}' });
  });

  test("an unknown /api path is 404 JSON, not the app's index.html", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toBe('{"error":"not found"}');
  });

  test("a built asset is served as itself", async () => {
    expect(await get("/assets/app.js")).toEqual({ status: 200, body: "console.log(1)" });
  });

  test("a client route falls back to index.html", async () => {
    for (const path of ["/", "/expenses", "/lumpy/3"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.body).toContain("<title>lumpy</title>");
    }
  });

  test("an encoded traversal reads the app, not a file outside dist", async () => {
    // Unencoded `..` never arrives: the URL parser collapses it. Encoded, it
    // reaches decodeURIComponent, which is why the prefix check is after resolve().
    const res = await get("/%2e%2e%2fnot-served.txt");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("DATABASE_URL");
    expect(res.body).toContain("<title>lumpy</title>");
  });
});
