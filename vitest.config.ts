import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "./tests/helpers/isolated-environment-setup";

// Fallback for packages whose `test` script has no `--config`; it only registers the shared isolation setup so no suite runs without it.
export default defineConfig({
  test: {
    setupFiles: [isolatedEnvironmentSetup],
  },
});
