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

export default defineConfig({
  resolve: { alias: mcpAliases },
  test: {
    include: ["tests/mcp/**/*.test.ts"],
  },
});
