import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRepairState,
  emptyDiagnosticsCounts,
  type AgentsState,
  type AppTab,
  type RepairState,
  type RepairStateInputs,
  type SetupState,
  type ShellLocale,
} from "@work-intelligence/desktop-core";
import { asarFiles, asarPath } from "./asar.js";
import { packagedExecutable } from "./helpers.js";

/**
 * Screenshots of the PACKAGED App's page. The packaged App is a closed shell (no test hook, no remote debugging, inspect
 * fuses off), so Playwright cannot drive it. What this spec does instead: it reads the page files out of the packaged
 * `app.asar` (the production build: minified stylesheets and script) and shows them in a plain Electron window of the
 * Electron binary the repository installs, with a stand-in for the preload bridge that answers with fixed, synthetic
 * state built by the real `buildRepairState`. So the look of the shipped page is captured on each OS; the shell's own
 * behaviour is what the other packaged specs check.
 *
 *   apps/desktop/screenshots/<platform>/packaged-<state>-<tab>-<locale>-<scheme>.png
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(here, "..", "..", "screenshots", process.platform);
const PAGE_FILES = ["index.html", "tokens.css", "repair.css", "repair.js"] as const;
const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];

/** Every method of the bridge, so the stand-in has the same surface as the real preload (checked by the compiler). */
const BRIDGE_METHODS = [
  "getState",
  "retryStart",
  "chooseDatabase",
  "confirmDatabase",
  "copyToLocal",
  "openFolder",
  "previewDiagnostics",
  "saveDiagnostics",
  "startAnyway",
  "getTab",
  "rememberTab",
  "onSelectTab",
  "openSystemSettings",
  "legacyRecheck",
  "setupGetState",
  "setupUseDefaults",
  "setupUseSource",
  "setupChooseFile",
  "setupCopyToLocal",
  "setupLater",
  "showAgents",
  "agentsGetState",
  "agentsPreview",
  "agentsRemovePreview",
  "agentsApply",
  "agentsDiscard",
  "agentsUndo",
  "agentsSelfTest",
  "agentsUseCheckoutDatabase",
  "legacyDisablePreview",
  "legacyDisableConfirm",
  "legacyStartNow",
  "portChange",
  "checkForUpdates",
  "openUpdateLink",
  "onUpdateChanged",
] as const;
type Bridge = import("@work-intelligence/desktop-core").RepairApi;
const _complete: readonly (keyof Bridge)[] = BRIDGE_METHODS;
const _exhaustive: Record<keyof Bridge, true> = Object.fromEntries(
  BRIDGE_METHODS.map((name) => [name, true]),
) as Record<keyof Bridge, true>;
void _complete;
void _exhaustive;

const STUB_MAIN = `
const { app, BrowserWindow, ipcMain } = require("electron");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const fixture = JSON.parse(readFileSync(process.env.WI_SCREENSHOT_FIXTURE, "utf8"));
ipcMain.handle("stub:call", (_event, name) => (name in fixture ? fixture[name] : { ok: true }));
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 920, height: 760, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(__dirname, "preload.cjs") },
  });
  win.loadFile(join(__dirname, "index.html"));
});
app.on("window-all-closed", () => app.quit());
`;

const STUB_PRELOAD = (methods: readonly string[]): string => `
const { contextBridge, ipcRenderer } = require("electron");
const api = {};
for (const name of ${JSON.stringify(methods)}) {
  api[name] = name.startsWith("on") ? () => undefined : (...args) => ipcRenderer.invoke("stub:call", name, args);
}
contextBridge.exposeInMainWorld("workIntelligenceRepair", api);
`;

let workDirectory: string | undefined;
let running: ElectronApplication | undefined;

test.afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = undefined;
  if (workDirectory) rmSync(workDirectory, { recursive: true, force: true });
  workDirectory = undefined;
});

function repairState(locale: ShellLocale, overrides: Partial<RepairStateInputs> = {}): RepairState {
  const now = new Date().toISOString();
  return buildRepairState({
    platform: process.platform,
    homeDirectory: "/home/synthetic",
    locale,
    owner: "MANAGED",
    backend: "running",
    databasePath: "/home/synthetic/.work-intelligence/data/work-intelligence.sqlite",
    databaseStatus: "ok",
    candidates: [],
    recentErrors: [],
    lastBackup: { status: "known", at: now },
    retryOperationId: randomUUID(),
    port: { port: 3210, activePort: 3210, focus: false, handoffHeld: false },
    update: { currentVersion: "1.6.56", checking: false, result: null },
    busy: false,
    ...overrides,
  });
}

function agentsState(locale: ShellLocale): AgentsState {
  return {
    locale,
    launcherReady: true,
    cards: [
      {
        id: "codex",
        state: "observed-connected",
        nextStep: "none",
        mcp: "desktop-managed",
        hooks: "desktop-managed",
        hookState: "installed",
        hookSource: "app",
        detected: true,
        checkoutMissing: false,
        adoptable: false,
      },
      {
        id: "claude-code",
        state: "not-configured",
        nextStep: "set-up-agent",
        mcp: "none",
        hooks: "none",
        detected: true,
        checkoutMissing: false,
        adoptable: false,
      },
    ],
    selfTest: { outcome: "not-run" },
    preview: null,
    undoAvailable: false,
    result: null,
    busy: false,
  };
}

function setupState(locale: ShellLocale): SetupState {
  return {
    locale,
    phase: "ready",
    screen: "new",
    defaults: {
      databaseDisplay: "~/.work-intelligence/data/work-intelligence.sqlite",
      url: "http://127.0.0.1:3210/",
      backupDisplay: "~/.work-intelligence/backups",
      launchAtLogin: false,
      legacyConflict: false,
    },
    sources: [],
    legacy: null,
    canUseDefaults: true,
    busy: false,
  };
}

interface Scenario {
  readonly state: string;
  readonly locale: ShellLocale;
  readonly tabs: readonly AppTab[];
  readonly initialTab: AppTab;
  readonly repair: RepairState;
  /** Also capture the diagnostics preview dialog. */
  readonly preview?: boolean;
}

/** Writes the page, the stand-in main and preload and the fixture answers for one state; returns the folder's main file. */
function lay(scenario: Scenario): string {
  workDirectory = mkdtempSync(join(tmpdir(), "wi-packaged-shot-"));
  const wanted = new Set<string>(PAGE_FILES);
  let copied = 0;
  for (const [path, content] of asarFiles(asarPath(packagedExecutable()))) {
    const marker = "/dist/renderer/repair/";
    const at = path.indexOf(marker);
    if (at < 0) continue;
    const name = path.slice(at + marker.length);
    if (!wanted.has(name)) continue;
    writeFileSync(join(workDirectory, name), content);
    copied += 1;
  }
  expect(copied, "the packaged asar holds the four page files").toBe(PAGE_FILES.length);
  const fixture = {
    getState: scenario.repair,
    getTab: { tab: scenario.initialTab, tabs: scenario.tabs },
    rememberTab: { ok: true },
    agentsGetState: agentsState(scenario.locale),
    setupGetState: setupState(scenario.locale),
    previewDiagnostics: {
      ok: true,
      previewId: randomUUID(),
      text: `${JSON.stringify({ synthetic: true, recentOutput: ["[shell] synthetic line"], omittedOutputLines: 2 }, null, 2)}\n`,
      report: { categories: emptyDiagnosticsCounts(), maskedInScan: 0, omittedOutputLines: 2, truncatedBytes: 0 },
    },
  };
  writeFileSync(join(workDirectory, "fixture.json"), JSON.stringify(fixture));
  writeFileSync(join(workDirectory, "preload.cjs"), STUB_PRELOAD(BRIDGE_METHODS));
  writeFileSync(join(workDirectory, "main.cjs"), STUB_MAIN);
  return join(workDirectory, "main.cjs");
}

async function show(scenario: Scenario): Promise<Page> {
  const main = lay(scenario);
  running = await _electron.launch({
    executablePath: require("electron") as string,
    args: [main, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, WI_SCREENSHOT_FIXTURE: join(dirname(main), "fixture.json") } as Record<string, string>,
    timeout: 60_000,
  });
  const window = await running.firstWindow({ timeout: 45_000 });
  await expect(window.getByRole("tablist")).toBeVisible({ timeout: 30_000 });
  try {
    const session = await window.context().newCDPSession(window);
    const size = await window.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
    await session.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2, mobile: false });
  } catch {
    // The shots are then 1x.
  }
  return window;
}

async function shoot(window: Page, scenario: Scenario, tab: string, scheme: Scheme): Promise<void> {
  await window.emulateMedia({ colorScheme: scheme });
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(scheme);
  await window.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });
  const file = join(OUTPUT, `packaged-${scenario.state}-${tab}-${scenario.locale}-${scheme}.png`);
  mkdirSync(OUTPUT, { recursive: true });
  await window.screenshot({ path: file, animations: "disabled", caret: "hide" });
  process.stdout.write(`[screenshot] ${file}\n`);
}

async function selectTab(window: Page, tab: AppTab): Promise<void> {
  await window.locator(`[role="tab"][data-tab="${tab}"]`).click();
  await expect(window.locator(`[role="tab"][data-tab="${tab}"]`)).toHaveAttribute("aria-selected", "true");
  await expect(window.locator(`#panel-${tab}`)).not.toBeEmpty({ timeout: 20_000 });
}

const READY: readonly AppTab[] = ["status", "agent", "settings", "data", "diagnostics"];

test("packaged page screenshots: every tab in light and dark, and the diagnostics preview", async () => {
  test.setTimeout(120_000);
  const scenario: Scenario = {
    state: "ready",
    locale: "en",
    tabs: READY,
    initialTab: "status",
    repair: repairState("en"),
  };
  const window = await show(scenario);
  for (const tab of READY) {
    await selectTab(window, tab);
    for (const scheme of SCHEMES) await shoot(window, scenario, tab, scheme);
  }
  await selectTab(window, "diagnostics");
  await window.locator('[data-id="export-diagnostics"]').click();
  await expect(window.getByRole("dialog")).toBeVisible({ timeout: 20_000 });
  for (const scheme of SCHEMES) await shoot(window, scenario, "diagnostics-preview", scheme);
});

test("packaged page screenshots: Traditional Chinese for Status and Settings", async () => {
  test.setTimeout(90_000);
  const scenario: Scenario = {
    state: "ready",
    locale: "zh-TW",
    tabs: READY,
    initialTab: "status",
    repair: repairState("zh-TW"),
  };
  const window = await show(scenario);
  for (const tab of ["status", "settings"] as const) {
    await selectTab(window, tab);
    for (const scheme of SCHEMES) await shoot(window, scenario, tab, scheme);
  }
});

test("packaged page screenshots: a missing database (Status and Data) and the first-run Setup tab", async () => {
  test.setTimeout(120_000);
  const repair = repairState("en", {
    owner: "NEEDS_REPAIR",
    backend: "stopped",
    databaseStatus: "missing",
    recentErrors: [{ code: "DB_MISSING", at: new Date().toISOString() }],
    lastBackup: { status: "none" },
    operation: null,
  });
  const broken: Scenario = { state: "needs-repair", locale: "en", tabs: READY, initialTab: "status", repair };
  const window = await show(broken);
  await expect(window.getByText("DB_MISSING")).toBeVisible({ timeout: 20_000 });
  for (const scheme of SCHEMES) await shoot(window, broken, "status", scheme);
  await selectTab(window, "data");
  for (const scheme of SCHEMES) await shoot(window, broken, "data", scheme);
  await running?.close().catch(() => undefined);
  running = undefined;

  const fresh: Scenario = {
    state: "needs-setup",
    locale: "en",
    tabs: ["setup", ...READY],
    initialTab: "setup",
    repair: repairState("en", { owner: "UNCONFIGURED", backend: "stopped", needsSetup: true, databasePath: null }),
  };
  const setup = await show(fresh);
  await expect(setup.locator('[data-id="use-defaults"]')).toBeVisible({ timeout: 20_000 });
  for (const scheme of SCHEMES) await shoot(setup, fresh, "setup", scheme);
});
