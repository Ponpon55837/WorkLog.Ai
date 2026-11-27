import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  BackendRecovery,
  databaseKey,
  STORAGE_NETWORK_CODE,
  ErrorPresenter,
  interpretManagedStart,
  RestartPolicy,
  decideRuntimeRecovery,
  planPortFallback,
  sameAsLastKnownGood,
  isRuntimeReinstallable,
  type BackendInfo,
  type BundledRuntimeStatus,
  type BackendStartRequest,
  type BackendSupervisor,
  type DesktopSettingsV1,
  type LastBackupTracker,
  type LaunchMode,
  type ManagedBackendService,
  type JournalJson,
  type OperationCoordinator,
  type OperationStepContext,
  type RestartOutcome,
} from "@work-intelligence/desktop-core";
import type { DesktopFacts } from "@work-intelligence/schema";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import { RuntimeProvisionError } from "./runtime-provision.js";
import type { ShellState } from "./state.js";

export interface StartOverride {
  readonly databasePath: string;
  readonly expectedIdentity: NonNullable<BackendStartRequest["expectedIdentity"]>;
  readonly allowSchemaMigration: boolean;
}

export type StartKind = "takeover" | "restart" | "change-db" | "change-port" | "restore" | "maintenance";

export interface PortStart {
  readonly port: number;
  readonly from: number;
}

export interface BackendController {
  start(kind: StartKind, override?: StartOverride, operationId?: string): Promise<RestartOutcome>;
  readonly recovery: BackendRecovery;
  restoreWhileStopped(
    replace: (context: OperationStepContext) => Promise<JournalJson | void>,
    operationId?: string,
  ): Promise<RestartOutcome>;
  maintainWhileStopped(
    work: (context: OperationStepContext) => Promise<JournalJson | void>,
    operationId?: string,
  ): Promise<RestartOutcome>;
  startOnPort(change: PortStart, operationId?: string): Promise<RestartOutcome>;
  presenter(): ErrorPresenter;
  useLaunchMode(mode: LaunchMode): void;
  attach(): void;
}

/** @internal test-only */
export interface BackendControllerOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly supervisor: BackendSupervisor;
  readonly managed: ManagedBackendService;
  readonly coordinator: OperationCoordinator;
  readonly lastBackup: LastBackupTracker;
  readonly log: Logger;
  readonly openRepairWindow: () => void;
  readonly prepareRuntime: (verifyInstalled: boolean) => Promise<BundledRuntimeStatus | undefined>;
  readonly reinstallOnRefusal: boolean;
  readonly notifyError: (code: string) => void;
  /** The backend starts before Electron is ready, so an early exit waits for it before recovery may show a window or notification. */
  readonly whenReady: () => Promise<void>;
  readonly legacyBlocks?: (databasePath: string) => Promise<boolean>;
  readonly sameDatabaseServerOn?: (port: number, databasePath: string) => Promise<boolean>;
  readonly storageRefused?: (databasePath: string) => boolean;
  readonly desktopFacts?: (databasePath: string) => DesktopFacts | undefined;
  readonly backendEnvironment?: Readonly<Record<string, string>>;
}

export function createBackendController(options: BackendControllerOptions): BackendController {
  const { state, paths, supervisor, managed, coordinator, lastBackup, log } = options;
  let presenter = new ErrorPresenter("interactive", presenterActions());
  let runtimeSuspect = false;
  let reinstallAttempted = false;
  let portFallbackFailed: number | null = null;

  function presenterActions() {
    return {
      openRepairWindow: options.openRepairWindow,
      setTrayAttention: () => state.touch(),
      notify: options.notifyError,
    };
  }

  async function persistActive(info: BackendInfo, commitPort?: number): Promise<boolean> {
    if (!state.settings) return true;
    const active: NonNullable<DesktopSettingsV1["active"]> = {
      databaseIdentity: info.databaseIdentity,
      port: info.port,
      runtimeVersion: info.appVersion,
      serviceOwner: "desktop",
    };
    const lastKnownGood: NonNullable<DesktopSettingsV1["lastKnownGood"]> = {
      databaseIdentity: info.databaseIdentity,
      port: info.port,
      runtimeVersion: info.appVersion,
    };
    try {
      await state.updateSettings(paths.settingsFile, (current) => {
        const desired = commitPort === undefined ? current.desired : { ...current.desired, port: commitPort };
        // A steady-state start finds the same record: the fsync'd rewrite is skipped.
        if (
          isDeepStrictEqual(current.active, active) &&
          isDeepStrictEqual(current.lastKnownGood, lastKnownGood) &&
          isDeepStrictEqual(current.desired, desired)
        ) {
          return null;
        }
        return { ...current, desired, active, lastKnownGood };
      });
      return true;
    } catch (error) {
      log(`[shell] could not record the active service: ${error instanceof Error ? error.message : "unknown error"}`);
      return false;
    }
  }

  /**
   * A start that failed because its port is unusable gets one more try on the port the last verified start used (a start
   * the user asked to move to another port never does). The settings' own port stays as the user chose it; a fallback that
   * fails too returns the original failure, so the repair flow shows the real reason. See startup-fallback.ts.
   */
  async function start(
    kind: StartKind,
    override?: StartOverride,
    operationId: string = randomUUID(),
  ): Promise<RestartOutcome> {
    const outcome = await startWithRuntimeRecovery(kind, override, operationId);
    if (outcome.ok || outcome.busy || kind === "change-port" || !state.settings) return outcome;
    const wantedPort = state.settings.desired.port;
    // Read before the fallback start: a verified start overwrites it with its own record.
    const lastGood = state.settings.lastKnownGood;
    const plan = planPortFallback({
      failureCode: outcome.code,
      attemptedPort: wantedPort,
      lastKnownGood: lastGood,
      alreadyTried: portFallbackFailed === wantedPort,
    });
    if (!plan) return outcome;
    const databasePath = override?.databasePath ?? state.settings.desired.databasePath;
    if (
      outcome.code === "PORT_OCCUPIED_BY_OTHER" &&
      (await options.sameDatabaseServerOn?.(wantedPort, databasePath).catch(() => false))
    ) {
      // Another Work Intelligence server (CLI or standalone) already serves this database on that port: a fallback would
      // start a second server on one database. The original failure goes to repair, which names the busy port.
      log(`[shell] port ${wantedPort} is held by another Work Intelligence server on this database; no fallback`);
      portFallbackFailed = wantedPort;
      return outcome;
    }
    log(`[shell] port ${wantedPort} unusable (${outcome.code}); trying the last working port ${plan.port}`);
    const fallback = await startOnce(kind, override, randomUUID(), undefined, undefined, plan.port);
    if (fallback.ok) {
      const started = supervisor.running;
      state.startupFallback = {
        kind: "port-restored",
        wantedPort,
        usedPort: plan.port,
        code: outcome.code,
        runtimeVersion: plan.runtimeVersion,
        sameDatabase: started ? sameAsLastKnownGood(lastGood, started.databaseIdentity) : false,
      };
      state.touch();
      return fallback;
    }
    // Remembered, so the automatic restarts do not try the same port again this App run.
    portFallbackFailed = wantedPort;
    state.startupFallback = { kind: "port-failed", wantedPort, triedPort: plan.port, code: outcome.code };
    state.touch();
    return outcome;
  }

  async function startWithRuntimeRecovery(
    kind: StartKind,
    override: StartOverride | undefined,
    operationId: string,
  ): Promise<RestartOutcome> {
    const outcome = await startOnce(kind, override, operationId);
    if (
      outcome.ok ||
      outcome.busy ||
      decideRuntimeRecovery({
        canReinstall: options.reinstallOnRefusal,
        failureCode: outcome.code,
        alreadyAttempted: reinstallAttempted,
      }) === "none"
    ) {
      return outcome;
    }
    reinstallAttempted = true;
    let status: BundledRuntimeStatus | undefined;
    try {
      status = await options.prepareRuntime(true);
    } catch (error) {
      runtimeSuspect = true;
      return { ok: false, code: error instanceof RuntimeProvisionError ? error.code : "RUNTIME_INSTALL_FAILED" };
    }
    // Verified fine and nothing replaced: the runtime was not the cause, so another start would fail the same way.
    if (status !== "reinstalled" && status !== "installed") return outcome;
    log("[shell] runtime reinstalled after the backend refused it");
    return startOnce(kind, override, randomUUID());
  }

  async function startOnce(
    kind: StartKind,
    override: StartOverride | undefined,
    operationId: string,
    portChange?: PortStart,
    whileStopped?: (context: OperationStepContext) => Promise<JournalJson | void>,
    /** The port of the last verified start, tried because the settings' port is unusable; the settings are not changed. */
    fallbackPort?: number,
  ): Promise<RestartOutcome> {
    const { settings } = state;
    if (!settings) return { ok: false, code: "REPAIR_REQUIRED" };
    const databasePath = override?.databasePath ?? settings.desired.databasePath;
    if (options.legacyBlocks && (await options.legacyBlocks(databasePath))) {
      log("[shell] start held back: the old login service may use this database");
      if (supervisor.running === undefined) state.backend = "stopped";
      state.setOwner(supervisor.running === undefined ? "NEEDS_REPAIR" : state.owner);
      return { ok: false, code: "LEGACY_SERVICE_ACTIVE" };
    }
    // DB_ is a deterministic code: the restart policy schedules no automatic retry for it, so this cannot loop.
    if (options.storageRefused?.(databasePath)) {
      log("[shell] start refused: the database is on a network share");
      if (supervisor.running === undefined) state.backend = "stopped";
      state.setOwner(supervisor.running === undefined ? "NEEDS_REPAIR" : state.owner);
      return { ok: false, code: STORAGE_NETWORK_CODE };
    }
    const port = portChange?.port ?? fallbackPort ?? settings.desired.port;
    // The status page shows the port the App committed for this backend.
    const desktop: DesktopFacts = { ...options.desktopFacts?.(databasePath), activePort: port };
    const previousState = state.backend;
    state.backend = "starting";
    try {
      await options.prepareRuntime(runtimeSuspect);
    } catch (error) {
      runtimeSuspect = true;
      // Nothing was stopped yet: a service that is still running keeps serving, and the window must not say it needs repair.
      if (supervisor.running === undefined) {
        state.backend = "stopped";
        state.setOwner("NEEDS_REPAIR");
      } else {
        state.backend = previousState;
      }
      return { ok: false, code: error instanceof RuntimeProvisionError ? error.code : "RUNTIME_INSTALL_FAILED" };
    }
    const result = await managed.start({
      operationId,
      kind,
      previousOwner: state.owner,
      backend: {
        port,
        databasePath,
        backupDirectory: settings.desired.backupDirectory,
        ...(override ? { expectedIdentity: override.expectedIdentity } : {}),
        ...(override?.allowSchemaMigration ? { allowSchemaMigration: true } : {}),
        desktop,
        ...(options.backendEnvironment ? { environment: options.backendEnvironment } : {}),
      },
      // The identity the user confirmed: what startup recovery compares the settings' database with after a crash.
      ...(override ? { selectedDb: override.expectedIdentity } : {}),
      ...(portChange ? { details: { from: portChange.from, to: portChange.port } } : {}),
      stopRunning: supervisor.running !== undefined,
      ...(whileStopped ? { whileStopped } : {}),
    });
    const outcome = interpretManagedStart(result);
    if (outcome.kind === "busy") {
      // Another operation holds the lock: nothing changed here, and nothing failed.
      state.backend = previousState;
      return { ok: false, busy: true };
    }
    runtimeSuspect = outcome.kind === "failed" && isRuntimeReinstallable(outcome.code);
    if (outcome.kind === "started" && result.backend) {
      state.backend = "running";
      // A start on the port the settings name ends any earlier fallback note.
      if (fallbackPort === undefined) {
        state.startupFallback = null;
        portFallbackFailed = null;
      }
      log(`[shell] backend started pid=${result.backend.pid} port=${result.backend.port}`);
      if (override) {
        state.settings = { ...settings, desired: { ...settings.desired, databasePath: override.databasePath } };
      }
      lastBackup.bindDatabase(databaseKey(result.backend.databaseIdentity));
      const recorded = await persistActive(result.backend, portChange?.port);
      if (!recorded && portChange) {
        // The new port could not be committed: it must not keep serving while the settings name the old one.
        await supervisor.stop();
        state.backend = "stopped";
        state.setOwner("NEEDS_REPAIR");
        return { ok: false, code: "REPAIR_REQUIRED" };
      }
      state.setOwner("MANAGED");
      return { ok: true };
    }
    state.backend = "stopped";
    state.setOwner("NEEDS_REPAIR");
    return { ok: false, code: outcome.kind === "failed" ? outcome.code : "REPAIR_REQUIRED" };
  }

  const recovery = new BackendRecovery({
    policy: new RestartPolicy({ clock: () => Date.now() }),
    get presenter() {
      return presenter;
    },
    errors: state.recentErrors,
    restart: (operationId) => start("restart", undefined, operationId),
    isServing: () => supervisor.running !== undefined,
    // A timer must not touch a backend that is healthy, or one an operation is already (re)starting.
    shouldAutoRetry: () => coordinator.current() === null && supervisor.running === undefined,
    now: () => new Date(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    onOwnerChange: (owner) => state.setOwner(owner),
    log,
  });

  return {
    start,
    restoreWhileStopped: (replace, operationId = randomUUID()) =>
      startOnce("restore", undefined, operationId, undefined, replace),
    maintainWhileStopped: (work, operationId = randomUUID()) =>
      startOnce("maintenance", undefined, operationId, undefined, work),
    startOnPort: (change, operationId = randomUUID()) => startOnce("change-port", undefined, operationId, change),
    recovery,
    presenter: () => presenter,
    useLaunchMode: (mode) => {
      presenter = new ErrorPresenter(mode, presenterActions());
    },
    attach: () => {
      supervisor.onBackupCompleted((at, identity) => lastBackup.recordFromBackend(at, databaseKey(identity)));
      // Some API call may have written or removed a backup file: the folder is read again at the next look.
      supervisor.onBackupsChanged(() => lastBackup.invalidate());
      supervisor.onUnexpectedExit((event) => {
        log(`[shell] backend exited unexpectedly: ${event.code}`);
        state.backend = "crashed";
        void options
          .whenReady()
          .then(() => recovery.handleFailure(event.code))
          .catch((error: unknown) => {
            log(`[shell] recovery failed: ${error instanceof Error ? error.message : "unknown error"}`);
          });
      });
    },
  };
}
