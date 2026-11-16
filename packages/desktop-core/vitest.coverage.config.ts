import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/desktop-core/**/*.test.ts"],
    env: { TZ: "UTC" },
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/desktop-core/src/**/*.ts"],
      exclude: ["tests/desktop-core/**/*.test.ts"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 100,
        lines: 90,
      },
    },
  },
});
