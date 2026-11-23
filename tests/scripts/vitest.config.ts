import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../helpers/isolated-environment-setup";

// Own config: no vitest project includes tests/scripts. Run with
// `pnpm exec vitest run --root . --config tests/scripts/vitest.config.ts`.
export default defineConfig({
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    include: ["tests/scripts/**/*.test.ts"],
    env: { TZ: "UTC" },
  },
});
