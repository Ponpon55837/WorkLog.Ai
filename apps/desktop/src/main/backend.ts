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
  isRuntimeReinstallable,
  writeDesktopSettingsAtomic,
  type BackendInfo,
  type BundledRuntimeStatus,
  type BackendStartRequest,
  type BackendSupervisor,
  type DesktopSettingsV1,
  type LastBackupTracker,
  type LaunchMode,
  type ManagedBackendService,
  type OperationCoordinator,
  type RestartOutcome,
} from "@work-intelligence/desktop-core";
import type { DesktopFacts } from "@work-intelligence/schema";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import { RuntimeProvisionError } from "./runtime-provision.js";
import type { ShellState } from "./state.js";

/** What a start may change from the saved settings: the database the user confirmed in the repair window. */
export interface StartOverride {
  readonly databasePath: string;
  /** The identity the preview read; the start must find this very database. */
  readonly expectedIdentity: NonNullable<BackendStartRequest["expectedIdentity"]>;
  readonly allowSchemaMigration: boolean;
}

export type StartKind = "takeover" | "restart" | "change-db" | "change-port";

/** A start on another port than the settings name (DT-14): the settings change only once the backend is verified. */
export interface PortStart {
  readonly port: number;
  /** Journaled with the operation, so a crash leaves a trace of what was being changed. */
  readonly from: number;
}

export interface BackendController {
  /** One managed start under the operation coordinator. `busy` means another operation holds the lock: nothing changed. */
  start(kind: StartKind, override?: StartOverride, operationId?: string): Promise<RestartOutcome>;
  readonly recovery: BackendRecovery;
  /**
   * Stops the running backend and starts it on `change.port`; only a verified start commits `desired.port`, `active`
   * and `lastKnownGood` together in one settings write. A failure leaves the settings untouched and the backend
   * stopped (the caller restarts on the old port).
   */
  startOnPort(change: PortStart, operationId?: string): Promise<RestartOutcome>;
  /** The presenter for the current launch mode. */
  presenter(): ErrorPresenter;
  /** Chooses how errors are shown (a window, or the tray and one notification per code). */
  useLaunchMode(mode: LaunchMode): void;
  /** Starts listening to the supervisor: backups reported, backups changed, unexpected exits. */
  attach(): void;
}

export interface BackendControllerOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly supervisor: BackendSupervisor;
  readonly managed: ManagedBackendService;
  readonly coordinator: OperationCoordinator;
  readonly lastBackup: LastBackupTracker;
  readonly log: Logger;
  readonly openRepairWindow: () => void;
  /** Makes the runtime ready before a start (installs the bundled one in a packaged App); throws when it cannot. */
  readonly prepareRuntime: (verifyInstalled: boolean) => Promise<BundledRuntimeStatus | undefined>;
  /**
   * The App provisions its own runtime (packaged): a start the backend refused for a content reason verifies and
   * reinstalls it once and tries again.
   */
  readonly reinstallOnRefusal: boolean;
  readonly notifyError: (code: string) => void;
  /**
   * Resolves once Electron is ready. The backend starts before that, so an exit seen early waits for it before the
   * recovery may show a window or a notification.
   */
  readonly whenReady: () => Promise<void>;
  /**
   * True when the old login service may serve this database and the user has not said "仍要啟動": the start fails with
   * LEGACY_SERVICE_ACTIVE before anything is stopped or started.
   */
  readonly legacyBlocks?: (databasePath: string) => Promise<boolean>;
  /**
   * True when the verdict this run already reached for the database is "refused" (a network share): the start fails with
   * DB_STORAGE_NETWORK before anything is stopped or started, so a retry, a port change or an automatic restart never
   * brings it up there. It reads the known verdict and never classifies (a start does not wait for the detection).
   */
  readonly storageRefused?: (databasePath: string) => boolean;
  /** Facts the Web status page shows for this database (the old login service); read after `legacyBlocks`. */
  readonly desktopFacts?: (databasePath: string) => DesktopFacts | undefined;
  /** Extra `WORK_INTELLIGENCE_*` variables for every backend child; only a test build passes any (see config.ts). */
  readonly backendEnvironment?: Readonly<Record<string, string>>;
}

export function createBackendController(options: BackendControllerOptions): BackendController {
  const { state, paths, supervisor, managed, coordinator, lastBackup, log } = options;
  let presenter = new ErrorPresenter("interactive", presenterActions());
  /** The last start failed in a way that may mean a damaged runtime: the next one verifies it instead of trusting it. */
  let runtimeSuspect = false;
  /** The automatic reinstall is tried once per App start: a runtime that keeps being refused goes to repair. */
  let reinstallAttempted = false;

  function presenterActions() {
    return {
      openRepairWindow: options.openRepairWindow,
      setTrayAttention: () => state.touch(),
      notify: options.notifyError,
    };
  }

  /**
   * Records the verified backend as `active` and `lastKnownGood`; with `commitPort` the settings' `desired.port` moves in
   * the same atomic write. Returns false when the file could not be written (a start that only records is not failed by it;
   * a port change is).
   */
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
    const desired = commitPort === undefined ? state.settings.desired : { ...state.settings.desired, port: commitPort };
    // A steady-state start finds the same record: the fsync'd rewrite is skipped. Deep equality keeps up with the schema.
    if (
      isDeepStrictEqual(state.settings.active, active) &&
      isDeepStrictEqual(state.settings.lastKnownGood, lastKnownGood) &&
      isDeepStrictEqual(state.settings.desired, desired)
    ) {
      return true;
    }
    try {
      const next: DesktopSettingsV1 = { ...state.settings, desired, active, lastKnownGood };
      await writeDesktopSettingsAtomic(paths.settingsFile, next);
      state.settings = next;
      return true;
    } catch (error) {
      log(`[shell] could not record the active service: ${error instanceof Error ? error.message : "unknown error"}`);
      return false;
    }
  }

  async function start(
    kind: StartKind,
    override?: StartOverride,
    operationId: string = randomUUID(),
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
    const port = portChange?.port ?? settings.desired.port;
    // The status page shows the port the App committed for this backend.
    const desktop: DesktopFacts = { ...options.desktopFacts?.(databasePath), activePort: port };
    const previousState = state.backend;
    state.backend = "starting";
    try {
      await options.prepareRuntime(runtimeSuspect);
    } catch (error) {
      runtimeSuspect = true;
      state.backend = "stopped";
      state.setOwner("NEEDS_REPAIR");
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
      ...(portChange ? { details: { from: portChange.from, to: portChange.port } } : {}),
      stopRunning: supervisor.running !== undefined,
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
