import { defineConfig } from "vitest/config";
import { storageTestTimeout } from "./vitest.config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: storageTestTimeout,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/handoff-parser.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 90,
        lines: 85
      }
    }
  }
});
