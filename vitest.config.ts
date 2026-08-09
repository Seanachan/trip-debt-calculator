import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Engine is pure — no DOM needed.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
