import { defineConfig } from "@playwright/test";

// The packaged-App smoke test. Run it with `pnpm test:desktop-packaged`, which installs or unpacks the packaged App and
// passes its executable in WORK_INTELLIGENCE_PACKAGED_EXE (read by the tests only, never by the App). Like the unpackaged
// smoke test it sits outside `pnpm test` and the root e2e folder, so nothing else ever starts the packaged App.
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
