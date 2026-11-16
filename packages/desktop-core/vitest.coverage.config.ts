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
      "@work-intelligence/shared/backup-name": sharedSource("backup-name"),
      "@work-intelligence/shared/instance-proof": sharedSource("instance-proof"),
      "@work-intelligence/shared/loopback-port": sharedSource("loopback-port"),
      "@work-intelligence/shared/windows-system-tool": sharedSource("windows-system-tool"),
      "@work-intelligence/schema": fileURLToPath(new URL("../schema/src/index.ts", import.meta.url)),
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
      // launcher-entry.ts only wires process globals into runLauncher and is bundled as launcher.mjs;
      // the behavior it calls is covered through runLauncher with an injected host.
      exclude: ["tests/desktop-core/**/*.test.ts", "packages/desktop-core/src/runtime/launcher-entry.ts"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 100,
        lines: 90,
      },
    },
  },
});
