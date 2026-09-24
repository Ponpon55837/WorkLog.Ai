import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/schema/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/schema/src/index.ts"],
      exclude: ["tests/schema/**/*.test.ts"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
