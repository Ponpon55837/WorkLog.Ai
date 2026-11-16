import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

export default defineConfig({
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    include: ["tests/project-policy/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/project-policy/src/**/*.ts"],
      exclude: ["tests/project-policy/**/*.test.ts"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 100,
        lines: 95,
      },
    },
  },
});
