import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const serverAliases = {
  "@work-intelligence/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
  "@work-intelligence/schema": fileURLToPath(new URL("../../packages/schema/src/index.ts", import.meta.url)),
  "@work-intelligence/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
  "@work-intelligence/storage": fileURLToPath(new URL("../../packages/storage/src/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias: serverAliases },
  test: {
    include: ["tests/server/**/*.test.ts"],
  },
});
