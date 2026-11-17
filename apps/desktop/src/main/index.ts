import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { lstat, readdir } from "node:fs/promises";
import { app, dialog } from "electron";
import {
  BackendSupervisor,
  createNodeBackendDependencies,
  decideLaunch,
  detectLaunchMode,
  FileOperationJournalStore,
  findForbiddenDebugSwitch,
  interpretSecondInstanceData,
  isOpenDashboardLaunch,
  isQuitLaunch,
  LAUNCH_EXIT_OK,
  LastBackupTracker,
  ManagedBackendService,
  OPEN_DASHBOARD_SECOND_INSTANCE_DATA,
  OperationCoordinator,
  OperationJournal,
  QUIT_SECOND_INSTANCE_DATA,
  readLastBackupFromDirectory,
  resolveShellLocale,
  resolveUserDataDirectory,
  shellMessages,
  type RestartOutcome,
  type ShellLocale,
} from "@work-intelligence/desktop-core";
import { createBackendController } from "./backend.js";
import {
  ASSET_FILES,
  overrideFromEnvironment,
  resolveDesktopPaths,
  testSwitch,
  type DesktopConfigInputs,
  type DesktopPaths,
} from "./config.js";
import { createDashboard } from "./dashboard.js";
import { createIntegrationPublisher } from "./integration-record.js";
import { registerRepairIpc } from "./ipc.js";
import { createLogger } from "./log.js";
import { createErrorNotifier } from "./notify.js";
import { createQuit } from "./quit.js";
import { createRepairInfo } from "./repair-info.js";
import { createRepairWindow } from "./repair-window.js";
import { createRuntimeProvisioner } from "./runtime-provision.js";
import { createSecondInstance } from "./second-instance.js";
import { applySecurityPolicy, createSessionPolicy, registerRepairScheme } from "./security.js";
import { applyLoginItem, loadSettings } from "./settings.js";
import { ShellState } from "./state.js";
import { installTestHook } from "./test-hook.js";
import { createShellTray } from "./tray.js";

const environmentInputs = { isPackaged: app.isPackaged, environment: process.env };

/** The UI language before `ready`, when `app.getLocale()` is not available yet; English if the OS will not say. */
function earlyLocale(): ShellLocale {
  try {
    return resolveShellLocale(app.getPreferredSystemLanguages()[0]);
  } catch {
    return "en";
  }
}

/**
 * Closes the App with a native error box: there is no data folder, so no log, tray or repair window can exist. It all
 * happens now and never waits for `ready`: Electron needs the data folder on its own way to `ready`, so a box shown
 * after it may never be reached. The error box is allowed before `ready`, and `app.exit` before the message loop ends
 * the process at once. One case never gets here: a Windows profile whose Roaming AppData folder is gone ends inside
 * Electron's native start-up before this script runs (see the smoke test and the known limitations).
 */
function failStartup(detail: string): void {
  // A synchronous write, so the line is out before the process ends; on Linux the box itself also goes to stderr.
  writeSync(2, `[shell] cannot start: the application data folder is unavailable (${detail})\n`);
  const messages = shellMessages(earlyLocale());
  if (testSwitch(environmentInputs, "recordErrorBox")) {
    writeSync(2, `[shell] error box: ${messages.startupFailedTitle}\n`);
  } else {
    dialog.showErrorBox(messages.startupFailedTitle, messages.startupFailedMessage);
  }
  app.exit(1);
}

/** What a second launch hands to the running instance: its one request, or nothing for a plain launch. */
function secondInstanceData(quitRequested: boolean, openDashboardRequested: boolean): object | undefined {
  if (quitRequested) return { ...QUIT_SECOND_INSTANCE_DATA };
  return openDashboardRequested ? { ...OPEN_DASHBOARD_SECOND_INSTANCE_DATA } : undefined;
}

/** Everything else: the shell, its backend and the quit flow, once the data folder is known. */
function runShell(configInputs: DesktopConfigInputs): void {
  // Decided first, before any path, runtime install or backend: a `--quit` launch passes its request in the lock's data
  // (Chromium rewrites argv, so the second launch's own arguments are never read by the running instance).
  const quitRequested = isQuitLaunch(process.argv);
  // `--quit` wins over `--open-dashboard`: a launch that asks for both only stops the App.
  const openDashboardRequested = !quitRequested && isOpenDashboardLaunch(process.argv);
  const decision = decideLaunch({
    quitRequested,
    gotLock: app.requestSingleInstanceLock(secondInstanceData(quitRequested, openDashboardRequested)),
  });
  if (decision === "hand-over-and-exit") {
    // Another instance owns this user's data: start nothing, in particular no backend.
    app.quit();
    return;
  }
  if (decision === "exit-without-starting") {
    // `--quit` found nothing running: there is nothing to stop.
    app.exit(LAUNCH_EXIT_OK);
    return;
  }
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

  // Every change of the service owner is one log line (`[shell] owner MANAGED`, ...): see the contract in log.ts.
  let loggedOwner = state.owner;
  state.onChange(() => {
    if (state.owner === loggedOwner) return;
    loggedOwner = state.owner;
    log(`[shell] owner ${state.owner}`);
  });
  const runtime = createRuntimeProvisioner({
    packaged: app.isPackaged,
    paths,
    resourcesPath: process.resourcesPath,
    log,
  });
  const window = createRepairWindow({
    title: () => state.messages().repairWindowTitle,
    preloadFile: ASSET_FILES.preloadFile,
    prepareSession: createSessionPolicy(ASSET_FILES.rendererDirectory),
    onShown: () => log("[shell] repair window shown"),
  });
  const dashboard = createDashboard({
    running: () => supervisor.running,
    log,
    record: testSwitch(configInputs, "recordExternal"),
  });
  const integration = createIntegrationPublisher({
    paths,
    appExecutable: process.execPath,
    appVersion: app.getVersion(),
    platform: process.platform,
    env: configInputs.environment,
    homedir: configInputs.homeDirectory,
    log,
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
    prepareRuntime: async (verifyInstalled) => {
      const status = await runtime.prepare(verifyInstalled);
      // Only a runtime the App itself provisions is one the fixed launcher can run (nothing is provisioned unpackaged).
      if (status !== undefined) await integration.publish();
      return status;
    },
    reinstallOnRefusal: app.isPackaged,
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
    autoConfirm: testSwitch(configInputs, "autoConfirmQuit"),
    exit: () => app.exit(0),
  });
  const tray = createShellTray({
    state,
    iconFile: ASSET_FILES.trayIconFile,
    templateIconFile: ASSET_FILES.trayTemplateFile,
    backendRunning: () => supervisor.running !== undefined,
    openDashboard: dashboard.open,
    openRepairWindow: window.open,
    requestQuit: () => void requestQuit(true),
    log,
  });
  // The Dashboard was asked for with `--open-dashboard` (this launch, or a second one while this was still starting or
  // the service was changing owner): it opens once, when the backend is ready, even in a background launch.
  let dashboardRequested = openDashboardRequested;
  let starting = true;
  const secondInstance = createSecondInstance({
    state,
    window,
    supervisor,
    openDashboard: dashboard.open,
    starting: () => starting,
    deferDashboard: () => {
      dashboardRequested = true;
    },
  });
  // A request deferred after the first start (the owner was PREPARING, QUIESCING or STARTING) opens when the owner is
  // MANAGED with a running backend.
  state.onChange(() => {
    if (starting || !dashboardRequested || state.owner !== "MANAGED" || state.backend !== "running") return;
    dashboardRequested = false;
    dashboard.open();
  });

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
    try {
      await present(early);
    } finally {
      starting = false;
    }
  }

  async function present(early: ReturnType<typeof startBackend>): Promise<void> {
    state.launchMode = detectLaunchMode({
      platform: process.platform,
      argv: process.argv,
      wasOpenedAtLogin: process.platform === "darwin" ? app.getLoginItemSettings().wasOpenedAtLogin : undefined,
    });
    state.locale = resolveShellLocale(app.getLocale());
    backend.useLaunchMode(state.launchMode);
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
      if (state.launchMode === "interactive" || dashboardRequested) dashboard.open();
      dashboardRequested = false;
    } else if (outcome.busy) {
      log("[shell] the first start found another operation running");
    } else {
      backend.recovery.handleFailure(outcome.code);
    }
  }

  // The backend starts before `ready`, but the quit flow may show a dialog: it always runs after `ready` (and so after
  // the launch mode and the presenter are set), and a failure in it is logged rather than left unhandled.
  function quitWhenReady(interactive: boolean): void {
    void app
      .whenReady()
      .then(() => requestQuit(interactive))
      .catch((error: unknown) => {
        log(`[shell] quit failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
  }

  if (__WI_TEST_BUILD__) installTestHook({ state, paths, supervisor, window, secondInstance, dashboard });
  applySecurityPolicy();

  app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
    const command = interpretSecondInstanceData(additionalData);
    if (command.command === "open-dashboard") {
      log("[shell] dashboard requested by --open-dashboard");
      secondInstance.handle("open-dashboard");
      return;
    }
    if (command.command === "quit") {
      // Only the payload is read, never the second launch's arguments: it can ask for exactly this and nothing else.
      log("[shell] quit requested by --quit");
      quitWhenReady(false);
      return;
    }
    if (command.rejected) log("[shell] second launch carried data that was not understood; treated as a normal launch");
    secondInstance.handle("open");
  });
  // The App lives in the tray; closing the repair window never quits it.
  app.on("window-all-closed", () => undefined);
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

/** A packaged App never runs with a way to attach a debugger or drive it remotely; decided before anything else. */
function refuseDebugging(name: string): void {
  writeSync(2, `[shell] refusing to run with --${name}: debugging switches are not allowed in the installed App\n`);
  app.exit(1);
}

// The single-instance lock is scoped to userData, so a redirected data directory must be applied before the lock. It is
// also applied before userData is first read: the default is then never resolved, so a test profile need not have it.
const forbiddenSwitch = app.isPackaged
  ? findForbiddenDebugSwitch((name) => app.commandLine.hasSwitch(name))
  : undefined;
if (forbiddenSwitch !== undefined) {
  refuseDebugging(forbiddenSwitch);
} else {
  registerRepairScheme();
  const userData = resolveUserDataDirectory(overrideFromEnvironment(environmentInputs, "dataDirectory"), {
    read: () => {
      if (testSwitch(environmentInputs, "failUserData")) throw new Error("Failed to get 'userData' path");
      return app.getPath("userData");
    },
    write: (path) => app.setPath("userData", path),
  });
  if (userData.ok) {
    runShell({
      ...environmentInputs,
      userDataDirectory: userData.userDataDirectory,
      platform: process.platform,
      homeDirectory: homedir(),
      customUserDataDirectory: app.commandLine.hasSwitch("user-data-dir"),
    });
  } else failStartup(userData.detail);
}
