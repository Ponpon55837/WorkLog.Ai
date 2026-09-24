import { defineConfig } from "vitest/config";
import { serverAliases } from "./vitest.config";

export default defineConfig({
  resolve: { alias: serverAliases },
  test: {
    include: ["tests/server/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["apps/server/src/**/*.ts"],
      exclude: ["tests/server/**/*.test.ts"],
      thresholds: {
        statements: 35,
        branches: 38,
        functions: 55,
        lines: 35,
      },
    },
  },
});
