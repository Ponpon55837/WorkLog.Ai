import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/shared/**/*.test.ts"],
    env: { TZ: "UTC" },
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/shared/src/**/*.ts"],
      exclude: ["tests/shared/**/*.test.ts"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 100,
        lines: 90,
      },
    },
  },
});
