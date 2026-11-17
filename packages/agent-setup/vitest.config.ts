import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

export const agentSetupAliases = {
  "@work-intelligence/agent-setup": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias: agentSetupAliases },
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    include: ["tests/agent-setup/**/*.test.ts"],
  },
});
