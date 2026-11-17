import { fileURLToPath } from "node:url";
import os from "node:os";
import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

const IS_WINDOWS = process.platform === "win32";

/**
 * The desktop-core test config (`test` and the CI ACL step use it). The coverage config spreads `desktopCoreTestOptions`
 * next to its own setup file, since every vitest config registers the isolation setup itself.
 *
 * Windows CI (job 133822514446, vitest 4.1.11) measured a 46.19 s wall clock for 125.39 s of summed test time: the
 * workers compete for the disk and for the PowerShell and MCP child processes other workers start, so one fixture test
 * took 0.35 s in one run and 6.7 s in another (launcher 6664 ms, bundled install 6124 ms, settings fsync 4130 ms), past
 * vitest's default 5 s. The work is the same; only the wait is longer, so Windows gets a stated 30 s `testTimeout` and
 * half the logical CPUs as workers; POSIX keeps vitest's defaults. The once-per-file `icacls` and PowerShell ACL read
 * that made each file's first fixture test the slowest (5119 ms, 5740 ms) run once in `runtime-global-setup.ts`.
 */
export const desktopCoreTestOptions = {
  globalSetup: [fileURLToPath(new URL("../../tests/desktop-core/runtime-global-setup.ts", import.meta.url))],
  include: ["tests/desktop-core/**/*.test.ts"],
  testTimeout: IS_WINDOWS ? 30_000 : undefined,
  maxWorkers: IS_WINDOWS ? Math.max(1, Math.floor(os.availableParallelism() / 2)) : undefined,
};

export default defineConfig({
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    ...desktopCoreTestOptions,
  },
});
