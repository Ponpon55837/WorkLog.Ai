import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const mcpAliases = [
  {
    find: "@work-intelligence/core",
    replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
  },
  {
    find: "@work-intelligence/project-policy",
    replacement: fileURLToPath(new URL("../../packages/project-policy/src/index.ts", import.meta.url)),
  },
  {
    find: "@work-intelligence/schema",
    replacement: fileURLToPath(new URL("../../packages/schema/src/index.ts", import.meta.url)),
  },
  {
    find: "@work-intelligence/shared/database-path",
    replacement: fileURLToPath(new URL("../../packages/shared/src/database-path.ts", import.meta.url)),
  },
  {
    find: "@work-intelligence/shared/app-version",
    replacement: fileURLToPath(new URL("../../packages/shared/src/app-version.ts", import.meta.url)),
  },
  {
    find: "@work-intelligence/shared/mcp-runtime",
    replacement: fileURLToPath(new URL("../../packages/shared/src/mcp-runtime.ts", import.meta.url)),
  },
  {
    find: "@work-intelligence/shared",
    replacement: fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
  },
  {
    find: "@work-intelligence/storage",
    replacement: fileURLToPath(new URL("../../packages/storage/src/index.ts", import.meta.url)),
  },
  {
    find: /^@modelcontextprotocol\/sdk\/(.+)$/,
    replacement: `${fileURLToPath(new URL("./node_modules/@modelcontextprotocol/sdk", import.meta.url))}/dist/esm/$1`,
  },
  {
    find: "zod",
    replacement: fileURLToPath(new URL("./node_modules/zod", import.meta.url)),
  },
];

// MCP tests open file-backed SQLite databases and spawn the compiled server. On Windows CI runners, and slower still
// under coverage instrumentation, a fresh file can be briefly locked and SQLite waits up to its 5 s busy_timeout, so
// the default 5 s test timeout fails at exactly that point. Give them the same headroom as the storage and server tests.
export const mcpTestTimeout = 20_000;

export default defineConfig({
  resolve: { alias: mcpAliases },
  test: {
    include: ["tests/mcp/**/*.test.ts"],
    testTimeout: mcpTestTimeout,
  },
});
