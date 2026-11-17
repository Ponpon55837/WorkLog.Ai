import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "./tests/helpers/isolated-environment-setup";

/**
 * Fallback config for the packages whose `test` script has no `--config` (core, project-policy, shared,
 * desktop-core, agent-setup, schema): vitest then picks this file up from `--root ../..`. Its only job is to register the
 * shared isolation setup so no suite can run without it.
 */
export default defineConfig({
  test: {
    setupFiles: [isolatedEnvironmentSetup],
  },
});
