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
        "apps/web/src/stores/**/*.ts",
        "apps/web/src/api/**/*.ts",
        "apps/web/src/utils/**/*.ts",
        "apps/web/src/composables/useActiveRequestWatch.ts",
      ],
      exclude: ["tests/web/**/*.test.ts"],
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 82,
        lines: 85,
        "apps/web/src/api/**/*.ts": {
          statements: 95,
          branches: 80,
          functions: 95,
          lines: 95,
        },
        "apps/web/src/stores/**/*.ts": {
          statements: 75,
          branches: 55,
          functions: 70,
          lines: 80,
        },
        "apps/web/src/utils/**/*.ts": {
          statements: 90,
          branches: 90,
          functions: 95,
          lines: 90,
        },
      },
    },
  },
});
