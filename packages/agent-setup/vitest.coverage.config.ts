import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";
import { agentSetupAliases, skipFsyncSetup } from "./vitest.config";

export default defineConfig({
  resolve: { alias: agentSetupAliases },
  test: {
    setupFiles: [skipFsyncSetup, isolatedEnvironmentSetup],
    // The CLI regression suites exercise plan and apply end to end; their coverage counts for this package.
    include: [
      "tests/agent-setup/**/*.test.ts",
      "tests/server/agent-setup.test.ts",
      "tests/server/agent-setup-golden.test.ts",
    ],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/agent-setup/src/**/*.ts"],
      exclude: ["tests/agent-setup/**/*.test.ts"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
});
