import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/packaged-smoke",
  testMatch: "*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report-packaged" }]]
    : "list",
  outputDir: "test-results-packaged",
});
