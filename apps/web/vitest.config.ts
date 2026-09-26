import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const webAliases = {
  "@pinia/colada": fileURLToPath(new URL("./node_modules/@pinia/colada/dist/index.mjs", import.meta.url)),
  pinia: fileURLToPath(new URL("./node_modules/pinia/dist/pinia.js", import.meta.url)),
  vue: fileURLToPath(new URL("./node_modules/vue", import.meta.url)),
};

export default defineConfig({
  resolve: { alias: webAliases },
  test: {
    environment: "node",
    include: ["tests/web/**/*.test.ts"],
  },
});
