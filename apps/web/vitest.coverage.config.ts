import { defineConfig } from "vitest/config";
import { webAliases } from "./vitest.config";

export default defineConfig({
  resolve: { alias: webAliases },
  test: {
    environment: "node",
    include: ["tests/web/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "apps/web/src/utils/report.ts",
        "apps/web/src/utils/format.ts",
        "apps/web/src/composables/useActiveRequestWatch.ts",
      ],
      exclude: ["tests/web/**/*.test.ts"],
      thresholds: {
        statements: 60,
        branches: 52,
        functions: 62,
        lines: 58,
      },
    },
  },
});
