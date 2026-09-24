/// <reference types="node" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const webPort = Number(process.env.WORK_INTELLIGENCE_WEB_PORT ?? 5966);
const apiPort = Number(process.env.WORK_INTELLIGENCE_API_PORT ?? process.env.WORK_INTELLIGENCE_PORT ?? 3210);

export default defineConfig({
  plugins: [vue()],
  server: {
    port: webPort,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
