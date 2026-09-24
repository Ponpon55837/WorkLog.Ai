import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const webAliases = {
  vue: fileURLToPath(new URL("./node_modules/vue", import.meta.url)),
};

export default defineConfig({
  resolve: { alias: webAliases },
  test: {
    environment: "node",
    include: ["tests/web/**/*.test.ts"],
  },
});
