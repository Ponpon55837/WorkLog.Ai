import { defineConfig } from "vitest/config";
import { mcpAliases } from "./vitest.config";

export default defineConfig({
  resolve: { alias: mcpAliases },
  test: {
    include: ["tests/mcp/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["apps/mcp/src/**/*.ts"],
      exclude: ["tests/mcp/**/*.test.ts"],
      thresholds: {
        statements: 47,
        branches: 42,
        functions: 40,
        lines: 47,
      },
    },
  },
});
