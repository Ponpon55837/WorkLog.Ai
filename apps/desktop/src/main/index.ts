import { lstat, readdir } from "node:fs/promises";
import { app } from "electron";
import {
  BackendSupervisor,
  createNodeBackendDependencies,
  detectLaunchMode,
  FileOperationJournalStore,
  LastBackupTracker,
  ManagedBackendService,
  OperationCoordinator,
  OperationJournal,
  readLastBackupFromDirectory,
  resolveShellLocale,
} from "@work-intelligence/desktop-core";
import { createBackendController } from "./backend.js";
import {
  ASSET_FILES,
  overrideFromEnvironment,
  resolveDesktopPaths,
  testSwitch,
  TEST_ENVIRONMENT,
  type DesktopPaths,
} from "./config.js";
import { createDashboard } from "./dashboard.js";
import { registerRepairIpc } from "./ipc.js";
import { createLogger } from "./log.js";
import { createErrorNotifier } from "./notify.js";
import { createQuit } from "./quit.js";
import { createRepairInfo } from "./repair-info.js";
import { createRepairWindow } from "./repair-window.js";
import { createSecondInstance } from "./second-instance.js";
import { applySecurityPolicy, applySessionPolicy, registerRepairScheme } from "./security.js";
import { applyLoginItem, loadSettings } from "./settings.js";
import { ShellState } from "./state.js";
import { installTestHook } from "./test-hook.js";
import { createShellTray } from "./tray.js";

registerRepairScheme();

const environmentInputs = { isPackaged: app.isPackaged, environment: process.env };
// The single-instance lock is scoped to userData, so a redirected data directory must be applied before the lock. It is
// also applied before userData is first read: the default is then never resolved, so a test profile need not have it.
const dataDirectoryOverride = overrideFromEnvironment(environmentInputs, TEST_ENVIRONMENT.dataDirectory);
if (dataDirectoryOverride) app.setPath("userData", dataDirectoryOverride);
const configInputs = { ...environmentInputs, userDataDirectory: app.getPath("userData") };
const paths: DesktopPaths = resolveDesktopPaths(configInputs);

const log = createLogger(paths);
const state = new ShellState();
const supervisor = new BackendSupervisor({
  dependencies: createNodeBackendDependencies({ runtimeRoot: paths.runtimeRoot }),
  log: (line) => log(`[backend] ${line}`),
  workingDirectory: paths.backendWorkingDirectory,
});
const coordinator = new OperationCoordinator(new OperationJournal(new FileOperationJournalStore(paths.journalFile)));
const managed = new ManagedBackendService(coordinator, supervisor);
const lastBackup = new LastBackupTracker(async () => {
  const database = state.databasePath();
  const directory = state.backupDirectory();
  if (!database || !directory) return { status: "unknown" };
  return readLastBackupFromDirectory(database, directory, {
    readdir: (target) => readdir(target),
    lstat: (target) => lstat(target),
  });
});

const window = createRepairWindow({
  title: () => state.messages().repairWindowTitle,
  preloadFile: ASSET_FILES.preloadFile,
});
const dashboard = createDashboard({
  running: () => supervisor.running,
  record: testSwitch(configInputs, TEST_ENVIRONMENT.recordExternal),
});
const backend = createBackendController({
  state,
  paths,
  supervisor,
  managed,
  coordinator,
  lastBackup,
  log,
  openRepairWindow: window.open,
  notifyError: createErrorNotifier(state),
});
const info = createRepairInfo({ state, paths, supervisor, lastBackup });
const requestQuit = createQuit({
  state,
  supervisor,
  managed,
  coordinator,
  backend,
  lastBackup,
  log,
  autoConfirm: testSwitch(configInputs, TEST_ENVIRONMENT.autoConfirmQuit),
  exit: () => app.exit(0),
});
const tray = createShellTray({
  state,
  iconFile: ASSET_FILES.trayIconFile,
  backendRunning: () => supervisor.running !== undefined,
  openDashboard: dashboard.open,
  openRepairWindow: window.open,
  requestQuit: () => void requestQuit(true),
  log,
});
const secondInstance = createSecondInstance({ state, window, supervisor, openDashboard: dashboard.open });

async function start(): Promise<void> {
  state.launchMode = detectLaunchMode({
    platform: process.platform,
    argv: process.argv,
    wasOpenedAtLogin: process.platform === "darwin" ? app.getLoginItemSettings().wasOpenedAtLogin : undefined,
  });
  state.locale = resolveShellLocale(app.getLocale());
  backend.useLaunchMode(state.launchMode);
  applySessionPolicy(ASSET_FILES.rendererDirectory);
  registerRepairIpc({ state, paths, window, info, backend, supervisor, log });
  if (process.platform === "darwin" && state.launchMode === "background") app.dock?.hide();
  tray.create();
  backend.attach();
  if (!(await loadSettings(state, paths, log))) {
    backend.recovery.handleFailure("REPAIR_REQUIRED");
    return;
  }
  applyLoginItem(state);
  const outcome = await backend.start(state.owner === "UNCONFIGURED" ? "takeover" : "restart");
  if (outcome.ok) {
    backend.presenter().clear();
    if (state.launchMode === "interactive") dashboard.open();
  } else if (outcome.busy) {
    log("[shell] the first start found another operation running");
  } else {
    backend.recovery.handleFailure(outcome.code);
  }
}

installTestHook({ state, paths, supervisor, window, secondInstance, dashboard });
applySecurityPolicy();

if (!app.requestSingleInstanceLock()) {
  // Another instance owns this user's data: start nothing, in particular no backend.
  app.quit();
} else {
  app.on("second-instance", secondInstance.handle);
  // The App lives in the tray; closing the repair window never quits it.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", (event) => {
    event.preventDefault();
    void requestQuit(true);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void requestQuit(false));
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      log(`[shell] start failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
}
