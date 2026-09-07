import { app } from "./app";

const port = Number(process.env.API_PORT ?? 3001);

if (import.meta.main) {
  app.listen(port);
  console.log(`lumpy-budget api on http://localhost:${port}`);
}

export { app };
