import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

export const webAliases = {
  "@pinia/colada": fileURLToPath(new URL("./node_modules/@pinia/colada/dist/index.mjs", import.meta.url)),
  pinia: fileURLToPath(new URL("./node_modules/pinia/dist/pinia.js", import.meta.url)),
  vue: fileURLToPath(new URL("./node_modules/vue", import.meta.url)),
  "vue-router": fileURLToPath(new URL("./node_modules/vue-router", import.meta.url)),
};

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: webAliases },
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    environment: "node",
    include: ["tests/web/**/*.test.ts"],
  },
});
