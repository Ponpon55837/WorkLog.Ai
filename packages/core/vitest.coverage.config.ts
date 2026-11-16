import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

export default defineConfig({
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    include: ["tests/core/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/core/src/**/*.ts"],
      exclude: ["tests/core/**/*.test.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
