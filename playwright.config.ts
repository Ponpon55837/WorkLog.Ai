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
const agentHomeDirectory = path.join(os.tmpdir(), `work-intelligence-e2e-agents-${process.pid}`);
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
    // Motion is decoration; tests (and axe contrast checks) should not race fade-ins.
    reducedMotion: "reduce",
    // The UI follows the browser language on first visit; the specs assert the 繁體中文 copy.
    locale: "zh-TW",
    // The theme follows the OS by default; specs run against the dark theme unless they choose light.
    colorScheme: "dark",
    baseURL: `http://127.0.0.1:${webPort}`,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(browserExecutablePath ? { launchOptions: { executablePath: browserExecutablePath } } : {}),
      },
    },
    {
      name: "firefox",
      grep: /@cross-browser|@accessibility/,
      use: { browserName: "firefox" },
    },
    {
      name: "webkit",
      grep: /@cross-browser/,
      use: { browserName: "webkit" },
    },
  ],
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
        HOME: agentHomeDirectory,
        USERPROFILE: agentHomeDirectory,
        CODEX_HOME: path.join(agentHomeDirectory, ".codex"),
        CLAUDE_CONFIG_DIR: path.join(agentHomeDirectory, ".claude"),
      },
    },
  ],
});
