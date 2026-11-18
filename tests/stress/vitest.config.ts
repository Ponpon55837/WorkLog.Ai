import { defineConfig } from "vitest/config";
import { storageAliases } from "../../packages/storage/vitest.config";
import { isolatedEnvironmentSetup } from "../helpers/isolated-environment-setup";

// Own config so the multi-process SQLite stress suite never runs inside `pnpm test`; `pnpm test:sqlite-stress` runs it.
// The suite sets its own, much larger time box per test (load duration + teardown), see sqlite-wal-stress.test.ts.
export default defineConfig({
  resolve: { alias: storageAliases },
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    include: ["tests/stress/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    env: { TZ: "UTC" },
  },
});
