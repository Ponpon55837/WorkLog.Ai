import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/utils/report.ts", "src/utils/format.ts", "src/composables/useActiveRequestWatch.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        statements: 60,
        branches: 52,
        functions: 62,
        lines: 58,
      },
    },
  },
});
