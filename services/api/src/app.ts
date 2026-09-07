import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { computed } from "./computed";
import { resources } from "./resources";

/**
 * MySQL's constraint errors are user errors, not server errors: a duplicate
 * expense means "you already entered this", and it should read that way.
 * Validation failures fall through to Elysia's own 422.
 */
export const app = new Elysia()
  .use(cors())
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
