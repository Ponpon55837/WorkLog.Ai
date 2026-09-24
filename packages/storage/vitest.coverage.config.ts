import { defineConfig } from "vitest/config";
import { storageAliases, storageTestTimeout } from "./vitest.config";

export default defineConfig({
  resolve: { alias: storageAliases },
  test: {
    include: ["tests/storage/**/*.test.ts"],
    testTimeout: storageTestTimeout,
    env: { TZ: "UTC" },
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/storage/src/handoff-parser.ts"],
      exclude: ["tests/storage/**/*.test.ts"],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 90,
        lines: 85,
      },
    },
  },
});
