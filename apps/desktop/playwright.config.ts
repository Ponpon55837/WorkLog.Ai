import { defineConfig } from "@playwright/test";

// The desktop smoke test. It is deliberately outside the root `tests/e2e` folder and the vitest globs, so neither
// `pnpm test:e2e` nor `pnpm test` ever starts Electron. Run it with `pnpm test:desktop-smoke`.
export default defineConfig({
  testDir: "./tests/desktop-smoke",
  testMatch: "*.spec.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  outputDir: "test-results",
});
