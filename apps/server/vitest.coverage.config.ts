import { defineConfig } from "vitest/config";
import { serverAliases, serverTestTimeout } from "./vitest.config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";
import { sqliteNoFlushSetup } from "../../tests/helpers/sqlite-no-flush-setup";

export default defineConfig({
  resolve: { alias: serverAliases },
  test: {
    setupFiles: [sqliteNoFlushSetup, isolatedEnvironmentSetup],
    include: ["tests/server/**/*.test.ts"],
    testTimeout: serverTestTimeout,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["apps/server/src/**/*.ts"],
      exclude: ["tests/server/**/*.test.ts"],
      thresholds: {
        statements: 35,
        branches: 38,
        functions: 55,
        lines: 35,
      },
    },
  },
});
