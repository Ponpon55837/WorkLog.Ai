import { defineConfig } from "vitest/config";
import { sqliteTimingSetup, storageAliases } from "../../packages/storage/vitest.config";
import { isolatedEnvironmentSetup } from "../helpers/isolated-environment-setup";

// Own config so the multi-process stress suite never runs inside `pnpm test`; the suite sets its own larger per-test time box.
export default defineConfig({
  resolve: { alias: storageAliases },
  test: {
    setupFiles: [sqliteTimingSetup, isolatedEnvironmentSetup],
    include: ["tests/stress/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    env: { TZ: "UTC" },
  },
});
