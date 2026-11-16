import { lstat, readdir } from "node:fs/promises";
import { app, dialog } from "electron";
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
  resolveUserDataDirectory,
  shellMessages,
  type RestartOutcome,
} from "@work-intelligence/desktop-core";
import { createBackendController } from "./backend.js";
import {
  ASSET_FILES,
  overrideFromEnvironment,
  resolveDesktopPaths,
  testSwitch,
  TEST_ENVIRONMENT,
  type DesktopConfigInputs,
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

/** Closes the App with a native error box: there is no data folder, so no log, tray or repair window can exist. */
function failStartup(detail: string): void {
  // Before ready the UI language is not known yet, and on Linux the box goes to stderr; so say it in the log line too.
  process.stderr.write(`[shell] cannot start: the application data folder is unavailable (${detail})\n`);
  void app.whenReady().then(() => {
    const messages = shellMessages(resolveShellLocale(app.getLocale()));
    if (testSwitch(environmentInputs, TEST_ENVIRONMENT.recordErrorBox)) {
      process.stderr.write(`[shell] error box: ${messages.startupFailedTitle}\n`);
    } else {
      dialog.showErrorBox(messages.startupFailedTitle, messages.startupFailedMessage);
    }
    app.exit(1);
  });
}

/** Everything else: the shell, its backend and the quit flow, once the data folder is known. */
function runShell(configInputs: DesktopConfigInputs): void {
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
    whenReady: () => app.whenReady(),
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

  /**
   * The backend does not need Electron to be ready: its settings are a file and the child is a plain process. So it
   * starts as soon as this instance holds the lock, and the child boots while Electron gets ready and the tray, the
   * IPC and the session policy are set up. Only what shows something (a window, the Dashboard, a notification, the
   * login item) waits for `ready`.
   */
  function startBackend(): { settingsLoaded: Promise<boolean>; started: Promise<RestartOutcome | undefined> } {
    backend.attach();
    const settingsLoaded = loadSettings(state, paths, log);
    const started = settingsLoaded.then((loaded) =>
      loaded ? backend.start(state.owner === "UNCONFIGURED" ? "takeover" : "restart") : undefined,
    );
    return { settingsLoaded, started };
  }

  async function presentStart(early: ReturnType<typeof startBackend>): Promise<void> {
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
    if (!(await early.settingsLoaded)) {
      backend.recovery.handleFailure("REPAIR_REQUIRED");
      return;
    }
    applyLoginItem(state);
    const outcome = await early.started;
    if (!outcome) return;
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
    // The backend starts before `ready`, but the quit flow may show a dialog: it always runs after `ready` (and so after
    // the launch mode and the presenter are set), and a failure in it is logged rather than left unhandled.
    const quitWhenReady = (interactive: boolean): void => {
      void app
        .whenReady()
        .then(() => requestQuit(interactive))
        .catch((error: unknown) => {
          log(`[shell] quit failed: ${error instanceof Error ? error.message : "unknown error"}`);
        });
    };
    app.on("before-quit", (event) => {
      event.preventDefault();
      quitWhenReady(true);
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => quitWhenReady(false));
    const early = startBackend();
    // A failed read or start is reported through `presentStart`; this only keeps an early rejection from going unhandled.
    early.started.catch(() => undefined);
    void app
      .whenReady()
      .then(() => presentStart(early))
      .catch((error: unknown) => {
        log(`[shell] start failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
  }
}

// The single-instance lock is scoped to userData, so a redirected data directory must be applied before the lock. It is
// also applied before userData is first read: the default is then never resolved, so a test profile need not have it.
const userData = resolveUserDataDirectory(overrideFromEnvironment(environmentInputs, TEST_ENVIRONMENT.dataDirectory), {
  read: () => {
    if (testSwitch(environmentInputs, TEST_ENVIRONMENT.failUserData)) throw new Error("Failed to get 'userData' path");
    return app.getPath("userData");
  },
  write: (path) => app.setPath("userData", path),
});
if (userData.ok) runShell({ ...environmentInputs, userDataDirectory: userData.userDataDirectory });
else failStartup(userData.detail);
