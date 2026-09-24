import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export const storageAliases = {
  "@work-intelligence/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
  "@work-intelligence/project-policy": fileURLToPath(new URL("../project-policy/src/index.ts", import.meta.url)),
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
    include: ["tests/storage/**/*.test.ts"],
    testTimeout: storageTestTimeout,
    // Calendar dates follow the host time zone; pin it so date fixtures behave the same on every machine.
    env: { TZ: "UTC" },
  },
});
