import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { computed } from "./computed";
import { resources } from "./resources";

/**
 * The web app reaches the API same-origin through Vite's proxy, so CORS only has
 * to cover a browser pointed straight at a port: the dev server if it lands on
 * 5174 because 5173 was taken, or a built `dist` served locally. The plugin's
 * default reflects whatever Origin it is handed and adds Allow-Credentials,
 * which would let any site you visit read this unauthenticated API.
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * MySQL's constraint errors are user errors, not server errors: a duplicate
 * expense means "you already entered this", and it should read that way.
 * Validation failures fall through to Elysia's own 422.
 */
export const app = new Elysia()
  .use(cors({ origin: LOCAL_ORIGIN, credentials: false }))
  .onError(({ code, error, set }) => {
    const errno = (error as { errno?: number }).errno;
    if (errno === 1062) { set.status = 409; return { error: "that record already exists" }; }
    if (errno === 1451 || errno === 1452) { set.status = 409; return { error: "that record is referenced by something else" }; }
    if (code === "NOT_FOUND") { set.status = 404; return { error: "not found" }; }
    if (code === "VALIDATION") return;
    console.error(error);
    set.status = 500;
    return { error: (error as { message?: string }).message ?? "internal error" };
  })
  .use(computed)
  .use(resources);

export type App = typeof app;
