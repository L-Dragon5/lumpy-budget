import { Elysia } from "elysia";
import { join, resolve, sep } from "node:path";

/**
 * The built web app served beside the API on one origin, which is what
 * apps/web/src/lib/api.ts already assumes (`treaty(window.location.origin)`).
 * In dev there is no build: Vite serves the app and proxies /api here, so
 * server.ts only mounts this when a `dist` exists.
 *
 * Mounted after the API so a declared route always beats the wildcard, and /api
 * is 404ed here as well: an unknown API path has to read as missing JSON, not as
 * index.html with a 200 that the client then fails to parse.
 */
export function spa(dir: string) {
  const root = resolve(dir);
  const index = Bun.file(join(root, "index.html"));

  return new Elysia().get("/*", async ({ path, set }) => {
    if (path === "/api" || path.startsWith("/api/")) {
      set.status = 404;
      return { error: "not found" };
    }
    try {
      // resolve() collapses `..` before the prefix check: the path is a request,
      // not a promise to stay inside the directory. A path that will not decode,
      // or holds a NUL, throws here and is treated as no file at all.
      const target = resolve(root, "." + decodeURIComponent(path));
      if (target.startsWith(root + sep)) {
        const file = Bun.file(target);
        if (await file.exists()) return file;
      }
    } catch { /* not a file: fall through to the app */ }
    // Everything else is a client route (/expenses, /lumpy): the SPA resolves it.
    return index;
  });
}
