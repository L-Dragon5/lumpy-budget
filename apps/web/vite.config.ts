import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(dirname, "./src") } },
  // Workspace packages are TypeScript source, not prebuilt: let Vite compile them.
  optimizeDeps: { exclude: ["@lumpy/contracts", "@lumpy/budget-core", "@lumpy/csv-import"] },
  server: {
    port: 5173,
    // Same-origin in dev, so the app never needs to know the API's port.
    proxy: { "/api": { target: "http://localhost:3001", changeOrigin: true } },
  },
});
