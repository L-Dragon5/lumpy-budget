import { existsSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { app } from "./app";
import { spa } from "./static";

const port = Number(process.env.API_PORT ?? 3001);
const dist = join(import.meta.dir, "..", "..", "..", "apps", "web", "dist");

if (import.meta.main) {
  // A build present means this is the whole app on one port (the container, or a
  // local `bun run build`). Without one, Vite is serving the app and proxying here.
  const built = existsSync(dist);
  (built ? new Elysia().use(app).use(spa(dist)) : app).listen(port);
  console.log(`lumpy-budget api on http://localhost:${port}${built ? " (+ apps/web/dist)" : ""}`);
}

export { app };
