import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { isolatedEnvironmentSetup } from "../../tests/helpers/isolated-environment-setup";

const sharedSource = (file: string): string => fileURLToPath(new URL(`../shared/src/${file}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@work-intelligence/shared/database-location": sharedSource("database-location"),
      "@work-intelligence/shared/database-path": sharedSource("database-path"),
      "@work-intelligence/shared/file-identity": sharedSource("file-identity"),
    },
  },
  test: {
    setupFiles: [isolatedEnvironmentSetup],
    include: ["tests/desktop-core/**/*.test.ts"],
    env: { TZ: "UTC" },
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/desktop-core/src/**/*.ts"],
      exclude: ["tests/desktop-core/**/*.test.ts"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 100,
        lines: 90,
      },
    },
  },
});
