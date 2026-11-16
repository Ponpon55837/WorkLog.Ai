import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  BackendRecovery,
  databaseKey,
  ErrorPresenter,
  interpretManagedStart,
  RestartPolicy,
  decideRuntimeRecovery,
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

export type StartKind = "takeover" | "restart" | "change-db";

export interface BackendController {
  /** One managed start under the operation coordinator. `busy` means another operation holds the lock: nothing changed. */
  start(kind: StartKind, override?: StartOverride, operationId?: string): Promise<RestartOutcome>;
  readonly recovery: BackendRecovery;
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

  async function persistActive(info: BackendInfo): Promise<void> {
    if (!state.settings) return;
    const active: NonNullable<DesktopSettingsV1["active"]> = {
      databaseIdentity: info.databaseIdentity,
      port: info.port,
      runtimeVersion: info.appVersion,
      serviceOwner: "desktop",
    };
    // A steady-state start finds the same record: the fsync'd rewrite is skipped. Deep equality keeps up with the schema.
    if (isDeepStrictEqual(state.settings.active, active)) return;
    try {
      const next: DesktopSettingsV1 = { ...state.settings, active };
      await writeDesktopSettingsAtomic(paths.settingsFile, next);
      state.settings = next;
    } catch (error) {
      log(`[shell] could not record the active service: ${error instanceof Error ? error.message : "unknown error"}`);
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
  ): Promise<RestartOutcome> {
    const { settings } = state;
    if (!settings) return { ok: false, code: "REPAIR_REQUIRED" };
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
        port: settings.desired.port,
        databasePath: override?.databasePath ?? settings.desired.databasePath,
        backupDirectory: settings.desired.backupDirectory,
        ...(override ? { expectedIdentity: override.expectedIdentity } : {}),
        ...(override?.allowSchemaMigration ? { allowSchemaMigration: true } : {}),
      },
      stopRunning: supervisor.running !== undefined,
    });
    const outcome = interpretManagedStart(result);
    if (outcome.kind === "busy") {
      // Another operation holds the lock: nothing changed here, and nothing failed.
      state.backend = previousState;
      return { ok: false, busy: true };
    }
    runtimeSuspect = outcome.kind === "failed" && outcome.code === "RUNTIME_MISSING";
    if (outcome.kind === "started" && result.backend) {
      state.backend = "running";
      log(`[shell] backend started pid=${result.backend.pid} port=${result.backend.port}`);
      if (override) {
        state.settings = { ...settings, desired: { ...settings.desired, databasePath: override.databasePath } };
      }
      lastBackup.bindDatabase(databaseKey(result.backend.databaseIdentity));
      await persistActive(result.backend);
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
