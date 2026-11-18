import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

// Test-only SQLite timing (no-op unless WI_SQLITE_TIMING=1), see tests/helpers/sqlite-timing.ts.
export const sqliteTimingSetup = fileURLToPath(new URL("../../tests/helpers/sqlite-timing-setup.ts", import.meta.url));

export const storageAliases = {
  "@work-intelligence/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
  "@work-intelligence/project-policy": fileURLToPath(new URL("../project-policy/src/index.ts", import.meta.url)),
  "@work-intelligence/schema": fileURLToPath(new URL("../schema/src/index.ts", import.meta.url)),
  "@work-intelligence/shared/mcp-runtime": fileURLToPath(new URL("../shared/src/mcp-runtime.ts", import.meta.url)),
  "@work-intelligence/shared/sqlite-version": fileURLToPath(
    new URL("../shared/src/sqlite-version.ts", import.meta.url),
  ),
  "@work-intelligence/shared/database-path": fileURLToPath(new URL("../shared/src/database-path.ts", import.meta.url)),
  "@work-intelligence/shared/database-location": fileURLToPath(
    new URL("../shared/src/database-location.ts", import.meta.url),
  ),
  "@work-intelligence/shared/file-identity": fileURLToPath(new URL("../shared/src/file-identity.ts", import.meta.url)),
  "@work-intelligence/shared/app-version": fileURLToPath(new URL("../shared/src/app-version.ts", import.meta.url)),
  "@work-intelligence/shared/windows-system-tool": fileURLToPath(
    new URL("../shared/src/windows-system-tool.ts", import.meta.url),
  ),
  "@work-intelligence/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
};

// Several storage tests open real SQLite files in WAL mode. On Windows CI runners a freshly created
// database file can be briefly locked (e.g. by antivirus scanning), and SQLite then legitimately
// waits up to its 5 s busy_timeout. The default 5 s test timeout would fail exactly at that point,
// so storage tests get more headroom.
export const storageTestTimeout = 20_000;

export default defineConfig({
  resolve: { alias: storageAliases },
  test: {
    setupFiles: [sqliteTimingSetup, isolatedEnvironmentSetup],
    include: ["tests/storage/**/*.test.ts"],
    testTimeout: storageTestTimeout,
    // Calendar dates follow the host time zone; pin it so date fixtures behave the same on every machine.
    env: { TZ: "UTC" },
  },
});
