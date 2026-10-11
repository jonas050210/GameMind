import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/testing/integration/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
    },
    timeout: 30000,
  },
});
