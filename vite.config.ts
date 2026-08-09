// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Served as a GitHub Pages project site at
  // seanachan.github.io/trip-debt-calculator/ — the same URL this tool had when
  // it lived in the portfolio repo, so already-shared room links keep working.
  // Must stay in step with the BrowserRouter basename in src/main.tsx.
  base: "/trip-debt-calculator/",
});
