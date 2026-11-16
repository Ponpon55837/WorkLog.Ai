import { defineConfig } from "vitest/config";
import { mcpAliases, mcpTestTimeout } from "./vitest.config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

export default defineConfig({
  resolve: { alias: mcpAliases },
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    include: ["tests/mcp/**/*.test.ts"],
    testTimeout: mcpTestTimeout,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["apps/mcp/src/**/*.ts"],
      exclude: ["tests/mcp/**/*.test.ts"],
      thresholds: {
        statements: 47,
        branches: 42,
        functions: 40,
        lines: 47,
      },
    },
  },
});
