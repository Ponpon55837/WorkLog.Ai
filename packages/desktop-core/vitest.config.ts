import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

const IS_WINDOWS = process.platform === "win32";
const requireFromDesktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));

export const desktopCoreTestOptions = {
  // Resolve Electron mocks from the same workspace as the main-process code under test.
  alias: { electron: requireFromDesktop.resolve("electron") },
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
