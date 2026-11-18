import { existsSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { lstat, readdir, readFile } from "node:fs/promises";
import { probeLoopbackPort } from "@work-intelligence/shared/loopback-port";
import { app, dialog } from "electron";
import {
  BackendSupervisor,
  createNodeBackendDependencies,
  decideLaunch,
  detectLaunchMode,
  FileOperationJournalStore,
  findForbiddenDebugSwitch,
  interpretSecondInstanceData,
  isOpenAgentSetupLaunch,
  isOpenDashboardLaunch,
  isQuitLaunch,
  LAUNCH_EXIT_OK,
  LastBackupTracker,
  ManagedBackendService,
  OPEN_AGENT_SETUP_SECOND_INSTANCE_DATA,
  OPEN_DASHBOARD_SECOND_INSTANCE_DATA,
  OperationCoordinator,
  OperationJournal,
  applyStartTimeStorageRisk,
  PortHandoffStore,
  portMessages,
  QUIT_SECOND_INSTANCE_DATA,
  readLastBackupFromDirectory,
  REPAIR_CHANNELS,
  resolveShellLocale,
  resolveUserDataDirectory,
  setupMessages,
  storagePolicy,
  formatMessage,
  shellMessages,
  type LegacyServiceDetection,
  type RestartOutcome,
  type StorageRiskResult,
  type ShellLocale,
} from "@work-intelligence/desktop-core";
import type { DesktopFacts } from "@work-intelligence/schema";
import { createAgentsPage } from "./agents.js";
import { offerCandidate } from "./candidate-offer.js";
import { createBackendController } from "./backend.js";
import { createChangePort } from "./change-port.js";
import {
  ASSET_FILES,
  backendTestEnvironment,
  overrideFromEnvironment,
  defaultPortOverride,
  legacyServiceFileOverride,
  storageRiskFileOverride,
  repairSuccessDelayMs,
  resolveDesktopPaths,
  skillSourceFile,
  testSwitch,
  updateApiOriginOverride,
  updateTarget,
  type DesktopConfigInputs,
  type DesktopPaths,
} from "./config.js";
import { createDashboard } from "./dashboard.js";
import { createFirstRun } from "./first-run.js";
import { createIntegrationPublisher } from "./integration-record.js";
import { registerRepairIpc } from "./ipc.js";
import { createCopyRunner, createLocalCopy } from "./local-copy.js";
import { createLegacyGuard } from "./legacy.js";
import { createLegacyDisable, syntheticLegacyDisable } from "./legacy-disable.js";
import { createLogger } from "./log.js";
import { createErrorNotifier, createRecoveredNotifier } from "./notify.js";
import { createQuit } from "./quit.js";
import { createRepairInfo } from "./repair-info.js";
import { createStorageRiskService } from "./storage-risk.js";
import { createRepairSuccess } from "./repair-success.js";
import { createRepairWindow } from "./repair-window.js";
import { createRuntimeProvisioner } from "./runtime-provision.js";
import { createSecondInstance } from "./second-instance.js";
import { applySecurityPolicy, createSessionPolicy, registerRepairScheme } from "./security.js";
import { applyLoginItem, loadSettings, type SettingsLoad } from "./settings.js";
import { ShellState } from "./state.js";
import { installTestHook } from "./test-hook.js";
import { createShellTray } from "./tray.js";
import { createUpdateController } from "./update-check.js";
import { createUpdateSessionFetch } from "./update-session.js";

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
function secondInstanceData(
  quitRequested: boolean,
  openDashboardRequested: boolean,
  openAgentSetupRequested: boolean,
): object | undefined {
  if (quitRequested) return { ...QUIT_SECOND_INSTANCE_DATA };
  if (openDashboardRequested) return { ...OPEN_DASHBOARD_SECOND_INSTANCE_DATA };
  return openAgentSetupRequested ? { ...OPEN_AGENT_SETUP_SECOND_INSTANCE_DATA } : undefined;
}

/** Everything else: the shell, its backend and the quit flow, once the data folder is known. */
function runShell(configInputs: DesktopConfigInputs): void {
  // Decided first, before any path, runtime install or backend: a `--quit` launch passes its request in the lock's data
  // (Chromium rewrites argv, so the second launch's own arguments are never read by the running instance).
  const quitRequested = isQuitLaunch(process.argv);
  // `--quit` wins over `--open-dashboard`: a launch that asks for both only stops the App.
  const openDashboardRequested = !quitRequested && isOpenDashboardLaunch(process.argv);
  // `--open-dashboard` wins over `--open-agent-setup`; the Agent page is reached from the Dashboard as well.
  const openAgentSetupRequested = !quitRequested && !openDashboardRequested && isOpenAgentSetupLaunch(process.argv);
  const decision = decideLaunch({
    quitRequested,
    gotLock: app.requestSingleInstanceLock(
      secondInstanceData(quitRequested, openDashboardRequested, openAgentSetupRequested),
    ),
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
    title: (view) =>
      view === "repair" ? state.messages().repairWindowTitle : setupMessages(state.locale).setupWindowTitle,
    setView: (view) => {
      state.view = view;
    },
    // A plain launch, a second launch or the presenter: the first-run page while the App is not set up yet.
    defaultView: () => (state.needsSetup ? "setup" : "repair"),
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
  const legacyFile = legacyServiceFileOverride(configInputs);
  const legacy = createLegacyGuard({
    platform: process.platform,
    environment: process.env,
    log,
    // Read on every detection, so a test can make the service "go away" by deleting the file.
    ...(legacyFile === undefined
      ? {}
      : {
          detect: async (): Promise<LegacyServiceDetection> => {
            try {
              const detection = JSON.parse(await readFile(legacyFile, "utf8")) as LegacyServiceDetection;
              // A synthetic definition with a digest is gone once its file is (as a real one is): the disable test.
              const removed =
                detection.kind === "found" &&
                detection.definitionDigest !== undefined &&
                !existsSync(detection.definitionPath);
              return removed ? { kind: "none" } : detection;
            } catch {
              return { kind: "none" };
            }
          },
        }),
  });
  const storage = createStorageRiskService({ overrideFile: storageRiskFileOverride(configInputs) });
  const prepareRuntime = async (verifyInstalled: boolean) => {
    const status = await runtime.prepare(verifyInstalled);
    // Only a runtime the App itself provisions is one the fixed launcher can run (nothing is provisioned unpackaged).
    if (status !== undefined) await integration.publish();
    return status;
  };
  // The facts a backend carries: the old-service warning and the storage verdict this run already reached.
  const currentFacts = (databasePath: string): DesktopFacts | undefined => {
    const storageRisk = storage.fact(databasePath);
    const legacyFacts = legacy.facts(databasePath);
    return storageRisk ? { ...legacyFacts, storageRisk } : legacyFacts;
  };
  const backend = createBackendController({
    state,
    paths,
    supervisor,
    managed,
    coordinator,
    lastBackup,
    log,
    openRepairWindow: () => window.open("repair"),
    prepareRuntime,
    legacyBlocks: (databasePath) => legacy.blocks(databasePath),
    storageRefused: (databasePath) => storagePolicy(storage.last(databasePath)?.risk).refused,
    desktopFacts: (databasePath) => currentFacts(databasePath),
    backendEnvironment: backendTestEnvironment(environmentInputs),
    reinstallOnRefusal: app.isPackaged,
    notifyError: createErrorNotifier(state),
    whenReady: () => app.whenReady(),
  });
  // A test build records the "ready again" notifications it tried to show; a production build keeps no list.
  const notifications: string[] | undefined = __WI_TEST_BUILD__ ? [] : undefined;
  const success = createRepairSuccess({
    state,
    window,
    dashboard,
    backend,
    supervisor,
    notifyRecovered: createRecoveredNotifier(state, notifications),
    delayMs: repairSuccessDelayMs(configInputs),
  });
  const changePort = createChangePort({
    state,
    coordinator,
    supervisor,
    backend,
    probePort: probeLoopbackPort,
    confirmDialog: async (from, to) => {
      if (testSwitch(configInputs, "autoConfirmPort")) return true;
      const text = portMessages(state.locale);
      const { response } = await dialog.showMessageBox({
        type: "question",
        message: formatMessage(text.confirmMessage, { from: String(from), to: String(to) }),
        detail: text.confirmDetail,
        buttons: [text.confirmButton, text.cancelButton],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return response === 0;
    },
    handoff: new PortHandoffStore(() => Date.now()),
    openDashboard: (handoff) => dashboard.open(handoff),
    showSection: () => window.open("repair"),
    log,
  });
  const apiOrigin = updateApiOriginOverride(configInputs);
  const updates = createUpdateController({
    currentVersion: app.getVersion(),
    fetch: createUpdateSessionFetch(),
    ...updateTarget(configInputs, { platform: process.platform, arch: process.arch }),
    ...(apiOrigin === undefined ? {} : { apiOrigin }),
    openExternal: (url) => dashboard.openLink(url),
    showSection: () => window.open("repair"),
    // The page reads the section again when a check starts or ends (its own 4 s poll is only the fallback).
    changed: () => {
      try {
        window.contents()?.send(REPAIR_CHANNELS.updateChanged);
      } catch {
        // A window that is closing has no page left to tell.
      }
    },
    log,
  });
  const info = createRepairInfo({
    state,
    paths,
    supervisor,
    lastBackup,
    legacy,
    storage,
    port: changePort.section,
    update: updates.section,
  });
  const copyRunner = createCopyRunner({
    state,
    window,
    backend,
    supervisor,
    storage,
    prepareRuntime: () => prepareRuntime(false),
    autoConfirm: testSwitch(configInputs, "autoConfirmCopy"),
    log,
  });
  const firstRun = createFirstRun({
    copyRunner,
    state,
    paths,
    supervisor,
    backend,
    legacy,
    window,
    log,
    prepareRuntime: () => prepareRuntime(false),
    storage,
    onStarted: () => dashboard.open(),
    environment: process.env,
    ...(defaultPortOverride(configInputs) === undefined ? {} : { defaultPort: defaultPortOverride(configInputs) }),
  });
  const agents = createAgentsPage({
    state,
    paths,
    skillSourcePath: skillSourceFile(app.isPackaged, process.resourcesPath),
    log,
    // The same read-only preview the repair window's "選擇資料庫…" makes; switching still needs the user's confirm.
    offerDatabase: async (path) => {
      await offerCandidate({ state, supervisor, storage }, path);
      window.open("repair");
    },
  });
  const legacyDisable = createLegacyDisable({
    state,
    legacy,
    coordinator,
    supervisor,
    backend,
    openRepairWindow: () => window.open("repair"),
    log,
    environment: process.env,
    confirmDialog: async (hardStop) => {
      const text = setupMessages(state.locale);
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: text.legacyDisableDialog,
        detail: hardStop ? text.legacyDisableHardStop : text.legacyDisableIntro,
        buttons: [text.legacyDisableConfirm, text.legacyDisableCancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return response === 0;
    },
    ...(legacyFile === undefined ? {} : syntheticLegacyDisable(legacyFile)),
  });
  const openSetup = (): void => {
    window.open("setup");
    void firstRun.begin();
  };
  const openAgents = (): void => window.open("agents");
  const openPortSettings = (): void => changePort.openSection();
  const openUpdateCheck = (): void => updates.requestFromTray();
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
    openRepairWindow: () => window.open("repair"),
    openSetup,
    openAgents,
    openPortSettings,
    openUpdateCheck,
    requestQuit: () => void requestQuit(true),
    legacy: {
      heldAtLogin: () => legacy.heldAtLogin(),
      startAnyway: () => void startDespiteLegacyService(),
    },
    log,
  });

  /** The tray's "仍要啟動" after a login start held back: the same confirmation as the window, then start this database. */
  async function startDespiteLegacyService(): Promise<void> {
    const database = state.databasePath();
    if (!database) return;
    const text = setupMessages(state.locale);
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: text.legacyStartAnywayConfirm,
      buttons: [text.legacyStartAnyway, shellMessages(state.locale).quitCancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    // This database may start beside the old service until the App quits, as with "仍要啟動" in the window.
    legacy.allow(database);
    const outcome = await backend.start("restart");
    if (outcome.ok) backend.presenter().clear();
    else if (!outcome.busy) backend.recovery.handleFailure(outcome.code);
  }
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
  function startBackend(): { settingsLoaded: Promise<SettingsLoad>; started: Promise<RestartOutcome | undefined> } {
    backend.attach();
    agents.recover();
    // The Web status page's "在桌面 App 設定 Agent" asks through the running backend; it only opens the window.
    // The Web page asked for the port settings; its preferences wait in memory (never logged) for the change.
    supervisor.onOpenPortSettings((request) => {
      log("[shell] port settings requested by the Dashboard");
      void app.whenReady().then(() => changePort.offer(request));
    });
    supervisor.onOpenAgentSetup(() => {
      log("[shell] Agent page requested by the Dashboard");
      void app.whenReady().then(openAgents);
    });
    const settingsLoaded = loadSettings(state, paths, log);
    // A new install starts nothing: the first-run page asks first (DT-01).
    const started = settingsLoaded.then(async (loaded) => {
      if (loaded !== "ok") return undefined;
      // DT-08: the committed database is classified beside the bring-up. The start's outcome is presented as soon as the
      // backend is up; the verdict is applied when it arrives (a network share stops the backend again, anything else only
      // updates the facts). A start that fails leaves the verdict known, so a retry is refused before it starts anything.
      const databasePath = state.databasePath();
      const classified = databasePath === null ? undefined : storage.classify(databasePath);
      const outcome = await backend.start(state.owner === "UNCONFIGURED" ? "takeover" : "restart");
      if (outcome.ok && databasePath !== null && classified) void settleStorageRisk(databasePath, classified);
      return outcome;
    });
    return { settingsLoaded, started };
  }

  /** The verdict for the database the backend came up on: a network share refuses it after the fact, as a failed start. */
  async function settleStorageRisk(databasePath: string, classified: Promise<StorageRiskResult>): Promise<void> {
    try {
      const risk = await classified;
      // The user changed the database meanwhile: this verdict belongs to the old one.
      if (state.databasePath() !== databasePath || supervisor.running === undefined) return;
      const outcome = await applyStartTimeStorageRisk(
        { ok: true },
        {
          risk,
          currentFacts: () => {
            const port = state.settings?.active?.port ?? state.settings?.desired.port;
            return { ...currentFacts(databasePath), ...(port === undefined ? {} : { activePort: port }) };
          },
          stopBackend: async () => {
            await supervisor.stop();
            state.backend = "stopped";
          },
          updateFacts: (facts) => supervisor.updateFacts(facts),
        },
      );
      if (outcome?.ok === false && !outcome.busy) {
        await app.whenReady();
        backend.recovery.handleFailure(outcome.code);
      }
    } catch (error) {
      log(`[shell] storage verdict not applied: ${error instanceof Error ? error.message : "unknown error"}`);
    }
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
    registerRepairIpc({
      state,
      paths,
      window,
      info,
      backend,
      supervisor,
      success,
      firstRun,
      agents,
      legacy,
      legacyDisable,
      changePort,
      storage,
      updates,
      copyToLocal: createLocalCopy({ state, paths, info, backend, supervisor, success, runner: copyRunner, log }),
      log,
    });
    if (process.platform === "darwin" && state.launchMode === "background") app.dock?.hide();
    tray.create();
    const loaded = await early.settingsLoaded;
    if (loaded === "repair") {
      backend.recovery.handleFailure("REPAIR_REQUIRED");
      return;
    }
    if (loaded === "new-install") {
      // A login start of an App that was never set up shows nothing; the tray offers "完成首次設定…".
      if (state.launchMode === "interactive" || openAgentSetupRequested) openSetup();
      else log("[shell] first-run setup waits for the user (tray)");
      return;
    }
    applyLoginItem(state);
    const outcome = await early.started;
    if (!outcome) return;
    if (outcome.ok) {
      backend.presenter().clear();
      if (openAgentSetupRequested) openAgents();
      else if (state.launchMode === "interactive" || dashboardRequested) dashboard.open();
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

  if (__WI_TEST_BUILD__)
    installTestHook({
      state,
      paths,
      supervisor,
      window,
      secondInstance,
      dashboard,
      notifications: notifications ?? [],
      firstRunDetectionMs: () => firstRun.detectionMs,
      openPortSettings,
      openUpdateCheck,
    });
  applySecurityPolicy();

  app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
    const command = interpretSecondInstanceData(additionalData);
    if (command.command === "open-dashboard") {
      log("[shell] dashboard requested by --open-dashboard");
      secondInstance.handle("open-dashboard");
      return;
    }
    if (command.command === "open-agent-setup") {
      log("[shell] Agent page requested by --open-agent-setup");
      if (state.needsSetup) openSetup();
      else openAgents();
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
