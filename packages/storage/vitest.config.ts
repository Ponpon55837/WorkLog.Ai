import { defineConfig } from "vitest/config";

// Several storage tests open real SQLite files in WAL mode. On Windows CI runners a freshly created
// database file can be briefly locked (e.g. by antivirus scanning), and SQLite then legitimately
// waits up to its 5 s busy_timeout. The default 5 s test timeout would fail exactly at that point,
// so storage tests get more headroom.
export const storageTestTimeout = 20_000;

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: storageTestTimeout
  }
});
