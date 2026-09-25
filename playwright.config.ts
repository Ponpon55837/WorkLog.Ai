import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const webPort = Number(
  process.env.WORK_INTELLIGENCE_E2E_WEB_PORT ?? process.env.WORK_INTELLIGENCE_E2E_API_PORT ?? 5967,
);
// Workers load this config again with their own pid; they inherit the runner's path through the env so
// tests that act as an Agent (writing through the storage package) use the server's database.
const databasePath =
  process.env.WORK_INTELLIGENCE_E2E_DB ?? path.join(os.tmpdir(), `work-intelligence-e2e-${process.pid}.sqlite`);
process.env.WORK_INTELLIGENCE_E2E_DB = databasePath;
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const browserExecutablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...(browserExecutablePath ? { launchOptions: { executablePath: browserExecutablePath } } : {}),
  },
  webServer: [
    {
      command: `${pnpm} start`,
      url: `http://127.0.0.1:${webPort}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        WORK_INTELLIGENCE_PORT: String(webPort),
        WORK_INTELLIGENCE_DB: databasePath,
        WORK_INTELLIGENCE_BACKUP: "off",
        WORK_INTELLIGENCE_BACKUP_DIR: path.join(os.tmpdir(), `work-intelligence-e2e-${process.pid}-backups`),
        WORK_INTELLIGENCE_ALLOWED_ORIGINS: "",
      },
    },
  ],
});
