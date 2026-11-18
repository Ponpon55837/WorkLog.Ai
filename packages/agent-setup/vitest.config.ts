import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

export const skipFsyncSetup = fileURLToPath(new URL("../../tests/helpers/skip-fsync.ts", import.meta.url));

export const agentSetupAliases = {
  "@work-intelligence/agent-setup": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias: agentSetupAliases },
  test: {
    setupFiles: [isolatedEnvironmentSetup, skipFsyncSetup],
    include: ["tests/agent-setup/**/*.test.ts"],
  },
});
