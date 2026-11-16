import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

export default defineConfig({
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    include: ["tests/schema/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/schema/src/index.ts", "packages/schema/src/desktop-child-protocol.ts"],
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
