import { _electron, expect, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isSettledRepairFailure, type AppTab } from "@work-intelligence/desktop-core";
import { shellMessages, type ShellMessages } from "@work-intelligence/desktop-core/shell/i18n";
import { windowsPowerShell } from "@work-intelligence/shared/windows-system-tool";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import {
  INSTANCE_CHALLENGE_HEADER,
  INSTANCE_PROOF_HEADER,
  computeInstanceProof,
} from "@work-intelligence/shared/instance-proof";

import { undoMigrationsAfter } from "../../../../tests/helpers/schema-migration-fixture.js";
import {
  freePort,
  portIsFree,
  powershellArguments,
  processIsAlive,
  profileDirectories,
} from "../support/process-tools.js";

export { freePort, portIsFree, processIsAlive, profileDirectories };

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..", "..");

export const mainEntry = join(desktopRoot, "dist", "main", "index.mjs");
export const electronBinary: string = require("electron") as string;

export interface MainSnapshot {
  owner: string;
  backend: { pid: number; port: number; execPath: string; runId: string } | null;
  repairWindowOpen: boolean;
  secondInstanceCount: number;
  lastSecondInstanceDecision: string | null;
  openedExternal: string[];
  recentErrors: string[];
  notifications: string[];
  logFile: string;
  needsSetup: boolean;
  tab: string;
  firstRunDetectionMs: number | null;
}

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly port: number;
  readonly emptyBin: string;
  readonly runtimeRoot: string;
}

export function runtimeRootFromEnvironment(): string {
  const value = process.env.WORK_INTELLIGENCE_SMOKE_RUNTIME_ROOT;
  if (!value) throw new Error("WORK_INTELLIGENCE_SMOKE_RUNTIME_ROOT is not set; run `pnpm test:desktop-smoke`.");
  return value;
}

function writeSandboxSettings(dataDirectory: string, databasePath: string, port: number, home: string): void {
  writeFileSync(
    join(dataDirectory, "desktop-settings.json"),
    `${JSON.stringify(
      {
        configVersion: 1,
        installId: "synthetic-install-id",
        desired: {
          databasePath,
          port,
          launchAtLogin: false,
          backupDirectory: join(home, ".work-intelligence", "backups"),
        },
      },
      null,
      2,
    )}\n`,
  );
}

export async function createSandbox(options: { withDatabase: boolean; withSettings?: boolean }): Promise<Sandbox> {
  // `.native` expands Windows 8.3 short names (`RUNNER~1`) and macOS `/var`, so derived paths match what the App reports.
  const root = realpathSync.native(mkdtempSync(join(os.tmpdir(), "wi-desktop-smoke-")));
  const home = join(root, "home");
  const dataDirectory = join(root, "data");
  const emptyBin = join(root, "empty-bin");
  // Windows resolves known folders (Roaming and Local AppData) only when they exist.
  for (const directory of [...Object.values(profileDirectories(home)), dataDirectory, emptyBin]) {
    mkdirSync(directory, { recursive: true });
  }
  const databasePath = join(home, ".work-intelligence", "data", "work-intelligence.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  if (options.withDatabase) new WorkIntelligenceStore(databasePath).close();
  const port = await freePort();
  const runtimeRoot = runtimeRootFromEnvironment();
  if (options.withSettings !== false) writeSandboxSettings(dataDirectory, databasePath, port, home);
  return { root, home, dataDirectory, databasePath, port, emptyBin, runtimeRoot };
}

export function makeSchemaOlder(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const latest = (
      database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }
    ).version;
    undoMigrationsAfter(database, latest - 1);
  } finally {
    database.close();
  }
}

export function removeSandbox(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export function appEnvironment(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.startsWith("WORK_INTELLIGENCE_") || name === "ELECTRON_RUN_AS_NODE" || name === "NODE_OPTIONS") continue;
    base[name] = value;
  }
  const systemDirectory = process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : sandbox.emptyBin;
  return {
    ...base,
    ...profileDirectories(sandbox.home),
    PATH: process.platform === "win32" ? systemDirectory : sandbox.emptyBin,
    WORK_INTELLIGENCE_DESKTOP_DATA_DIR: sandbox.dataDirectory,
    WORK_INTELLIGENCE_DESKTOP_RUNTIME_ROOT: sandbox.runtimeRoot,
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_QUIT: "1",
    WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_EXTERNAL: "1",
    ...extra,
  };
}

// Linux only: Chromium's OS sandbox needs user namespaces (blocked by Ubuntu 24.04 AppArmor) or a setuid chrome-sandbox, so the test turns it off there.
export function launchArguments(): string[] {
  return [mainEntry, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
}

const closedApplications = new WeakSet<ElectronApplication>();

export async function launchApp(
  sandbox: Sandbox,
  extra: Record<string, string> = {},
  extraArguments: readonly string[] = [],
): Promise<ElectronApplication> {
  const launched = await _electron.launch({
    executablePath: electronBinary,
    args: [...launchArguments(), ...extraArguments],
    env: appEnvironment(sandbox, extra),
    timeout: 60_000,
  });
  launched.on("close", () => closedApplications.add(launched));
  return launched;
}

export interface ElectronExit {
  readonly pid: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

const EXIT_STDERR_LIMIT = 16 * 1024;

export function runToExit(
  sandbox: Sandbox,
  extra: Record<string, string> = {},
  timeoutMs = 20_000,
  extraArguments: readonly string[] = [],
): Promise<ElectronExit> {
  const child: ChildProcess = spawn(electronBinary, [...launchArguments(), ...extraArguments], {
    env: appEnvironment(sandbox, extra),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-EXIT_STDERR_LIMIT);
  });
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error(`Electron did not exit within ${timeoutMs} ms; stderr:\n${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    // `close`, not `exit`: stderr is fully read by then.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ pid: child.pid ?? 0, code, signal, stderr });
    });
  });
}

// Windows keeps the parent id after the parent ends, so Electron's helpers are still found by it.
export function windowsLeftovers(pid: number, marker: string): string[] {
  if (!Number.isInteger(pid) || pid <= 0 || marker.length === 0) throw new Error("a pid and a marker are required");
  const script = [
    `Get-CimInstance Win32_Process | Where-Object {`,
    `  $_.ProcessId -ne $PID -and ($_.ParentProcessId -eq ${pid} -or`,
    `  ($_.CommandLine -and $_.CommandLine.Contains($env:WI_SMOKE_MARKER)))`,
    `} | ForEach-Object { '{0} {1}' -f $_.Name, $_.ProcessId }`,
  ].join("\n");
  // The marker goes in through the environment, so it needs no command-line quoting.
  const output = execFileSync(windowsPowerShell(), powershellArguments(script), {
    encoding: "utf8",
    env: { ...process.env, WI_SMOKE_MARKER: marker },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function readSnapshot(app: ElectronApplication): Promise<MainSnapshot> {
  return app.evaluate(
    () =>
      (
        globalThis as unknown as { __workIntelligenceDesktopTest: { snapshot(): unknown } }
      ).__workIntelligenceDesktopTest.snapshot() as never,
  );
}

export function settledRepairFailure(snapshot: MainSnapshot): string | undefined {
  const latest = snapshot.recentErrors.at(-1);
  return snapshot.owner === "NEEDS_REPAIR" && latest !== undefined && isSettledRepairFailure(latest)
    ? `the App settled in NEEDS_REPAIR with errors=${snapshot.recentErrors.join(",")}`
    : undefined;
}

export async function waitForSnapshot(
  app: ElectronApplication,
  done: (snapshot: MainSnapshot) => boolean,
  timeoutMs = 45_000,
  failFast: (snapshot: MainSnapshot) => string | undefined = () => undefined,
): Promise<MainSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: MainSnapshot | undefined;
  while (Date.now() < deadline) {
    last = await readSnapshot(app);
    if (done(last)) return last;
    const failure = failFast(last);
    if (failure !== undefined) throw new Error(failure);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `condition not met in ${timeoutMs} ms; last owner=${last?.owner} errors=${last?.recentErrors.join(",")}`,
  );
}

export function waitForManagedSnapshot(app: ElectronApplication, timeoutMs = 45_000): Promise<MainSnapshot> {
  return waitForSnapshot(
    app,
    (state) => state.owner === "MANAGED" && state.backend !== null,
    timeoutMs,
    settledRepairFailure,
  );
}

export async function healthProofIsValid(port: number, runId: string): Promise<boolean> {
  const challenge = `smoke-challenge-${Date.now()}-abcdefghij`;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { [INSTANCE_CHALLENGE_HEADER]: challenge },
  });
  return (
    response.status === 200 && response.headers.get(INSTANCE_PROOF_HEADER) === computeInstanceProof(runId, challenge)
  );
}

export function attachLog(testInfo: TestInfo, sandbox: Sandbox): void {
  try {
    const text = readFileSync(join(sandbox.dataDirectory, "logs", "desktop-main.log"), "utf8");
    writeFileSync(testInfo.outputPath("desktop-main.log"), text);
  } catch {
    // No log was written: nothing to attach.
  }
}

export function readMainLog(sandbox: Sandbox): string {
  try {
    return readFileSync(join(sandbox.dataDirectory, "logs", "desktop-main.log"), "utf8");
  } catch {
    return "";
  }
}

export async function closeQuietly(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  if (closedApplications.has(app)) return;
  const closed = app.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  await app.evaluate(({ app: electron }) => electron.quit()).catch(() => undefined);
  await closed;
  await app.close().catch(() => undefined);
}

interface TestHook {
  openWindow(tab?: string): void;
  trayMenu(): { id: string; label: string; enabled: boolean }[];
  trayClick(id: string): void;
}

export async function openWindow(app: ElectronApplication, tab?: AppTab): Promise<void> {
  await app.evaluate(
    (_electron, requested) =>
      (globalThis as unknown as { __workIntelligenceDesktopTest: TestHook }).__workIntelligenceDesktopTest.openWindow(
        requested,
      ),
    tab,
  );
}

export function trayMenu(app: ElectronApplication): Promise<{ id: string; label: string; enabled: boolean }[]> {
  return app.evaluate(() =>
    (globalThis as unknown as { __workIntelligenceDesktopTest: TestHook }).__workIntelligenceDesktopTest.trayMenu(),
  );
}

export async function trayClick(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(
    (_electron, itemId) =>
      (globalThis as unknown as { __workIntelligenceDesktopTest: TestHook }).__workIntelligenceDesktopTest.trayClick(
        itemId,
      ),
    id,
  );
}

export function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

export async function closeAppWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.close();
  });
  await expect.poll(async () => (await readSnapshot(app)).repairWindowOpen).toBe(false);
  await expect.poll(() => app.windows().length).toBe(0);
}

export async function shellText(window: Page): Promise<ShellMessages> {
  const lang = await window.evaluate(() => document.documentElement.lang);
  return shellMessages(lang === "zh-Hant" ? "zh-TW" : "en");
}

export function tabButton(window: Page, tab: AppTab) {
  return window.locator(`[role="tab"][data-tab="${tab}"]`);
}

export function tabIds(window: Page): Promise<string[]> {
  return window
    .locator('[role="tablist"] [role="tab"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.tab ?? ""));
}

export async function selectedTab(window: Page): Promise<string | undefined> {
  const ids = await window
    .locator('[role="tablist"] [role="tab"][aria-selected="true"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.tab ?? ""));
  return ids.length === 1 ? ids[0] : undefined;
}

export async function expectTabShown(window: Page, tab: AppTab): Promise<void> {
  await expect(tabButton(window, tab)).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await expect(window.locator('[role="tabpanel"]:not([hidden])')).toHaveCount(1);
  await expect(window.locator(`#panel-${tab}`)).toBeVisible();
}

export async function openTab(window: Page, tab: AppTab): Promise<void> {
  await tabButton(window, tab).click();
  await expectTabShown(window, tab);
}

export async function markPage(window: Page): Promise<string> {
  const marker = `marker-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  await window.evaluate((value) => {
    (globalThis as { __wiMarker?: string }).__wiMarker = value;
  }, marker);
  return marker;
}

export function pageMarker(window: Page): Promise<string | undefined> {
  return window.evaluate(() => (globalThis as { __wiMarker?: string }).__wiMarker);
}
