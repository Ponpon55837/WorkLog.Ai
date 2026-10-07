import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const serverAliases = {
  "@work-intelligence/shared/app-version": fileURLToPath(
    new URL("../../packages/shared/src/app-version.ts", import.meta.url),
  ),
  "@work-intelligence/shared/mcp-runtime": fileURLToPath(
    new URL("../../packages/shared/src/mcp-runtime.ts", import.meta.url),
  ),
  "@work-intelligence/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
  "@work-intelligence/schema": fileURLToPath(new URL("../../packages/schema/src/index.ts", import.meta.url)),
  "@work-intelligence/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
  "@work-intelligence/storage": fileURLToPath(new URL("../../packages/storage/src/index.ts", import.meta.url)),
};

// Server tests also open real SQLite files, back them up and run CLI commands against them. On Windows CI runners
// a fresh file can be briefly locked and SQLite then waits up to its 5 s busy_timeout, so the default 5 s test
// timeout fails at exactly that point. Give them the same headroom as the storage tests.
export const serverTestTimeout = 20_000;

export default defineConfig({
  resolve: { alias: serverAliases },
  test: {
    include: ["tests/server/**/*.test.ts"],
    testTimeout: serverTestTimeout,
  },
});
