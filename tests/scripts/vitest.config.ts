import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../helpers/isolated-environment-setup";

// Own config: no vitest project includes tests/scripts. Run with `pnpm test:scripts` (CI runs it on every OS).
export default defineConfig({
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    include: ["tests/scripts/**/*.test.ts"],
    env: { TZ: "UTC" },
  },
});
