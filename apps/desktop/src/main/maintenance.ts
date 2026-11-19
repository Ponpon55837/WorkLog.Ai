import { statSync } from "node:fs";
import {
  busyDetailOf,
  type BackendSupervisor,
  type DatabaseMaintainOutcome,
  type MaintenanceFailureReason,
  type MaintenanceMode,
  type MaintenanceRunResult,
  type OperationCoordinator,
  type OperationStepContext,
  type RepairMaintenanceSection,
  type RestartOutcome,
  type JournalJson,
} from "@work-intelligence/desktop-core";
import type { BackendController } from "./backend.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

/** How long one answer of the running backend about its free space is reused. */
const HINT_WINDOW_MS = 60_000;

export interface MaintenanceOptions {
  readonly state: ShellState;
  readonly coordinator: Pick<OperationCoordinator, "current">;
  readonly supervisor: Pick<
    BackendSupervisor,
    "running" | "queryActivity" | "queryMaintenanceHint" | "maintainDatabase"
  >;
  readonly backend: Pick<BackendController, "maintainWhileStopped" | "start" | "presenter" | "recovery">;
  /** Whether an Agent (MCP) connection looks alive. */
  readonly agentsRunning: () => Promise<boolean>;
  /** The native confirmation before a compaction; Cancel is the default button. */
  readonly confirm: () => Promise<boolean>;
  /** Some backup file was written (the backup made first): the "last backup" shown is read again. */
  readonly backupsChanged: () => void;
  /** The section changed (a hint arrived, a run ended): the page reads the state again. */
  readonly changed: () => void;
  readonly fingerprint?: (databasePath: string) => string | null;
  readonly clock?: () => number;
  readonly log: Logger;
}

export interface MaintenanceController {
  /** What the Status and Data tabs show; sync, so it never waits for the backend (a stale hint is refreshed in the background). */
  section(): RepairMaintenanceSection;
  run(mode: MaintenanceMode): Promise<MaintenanceRunResult>;
}

class MaintenanceStepFailure extends Error {
  constructor(readonly reason: MaintenanceFailureReason) {
    super(`maintenance refused: ${reason}`);
  }
}

function fileFingerprint(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * The reason a maintenance child answer did not finish the work, or null when it did.
 * @internal test-only
 */
export function maintenanceFailureOf(outcome: DatabaseMaintainOutcome): MaintenanceFailureReason | null {
  if (outcome.outcome === "unknown") return "outcome-unknown";
  if (outcome.outcome === "failed") return "failed";
  switch (outcome.result.status) {
    case "ok":
      return null;
    case "in-use":
      return "in-use";
    case "missing":
      return "missing";
    case "invalid":
      return "invalid";
    case "integrity-failed":
      return "integrity-failed";
    case "backup-failed":
      return "backup-failed";
    default:
      return "failed";
  }
}

/**
 * 「整理資料庫」: backup, integrity check, compaction and index rebuild as one `maintenance` operation of the coordinator
 * (stop the backend, run the work in the preview child, start the backend again and verify it). The page sends only the mode;
 * main reads every path. A refusal before the user confirmed stops nothing. The read-only check runs beside the serving
 * backend, under the same single page-action lock.
 */
export function createMaintenance(options: MaintenanceOptions): MaintenanceController {
  const { state, coordinator, supervisor, backend, log } = options;
  const now = options.clock ?? Date.now;
  const fingerprintOf = options.fingerprint ?? fileFingerprint;
  let hint: {
    readonly at: number;
    readonly report: Awaited<ReturnType<BackendSupervisor["queryMaintenanceHint"]>>;
  } | null = null;
  let refreshing = false;
  let check: { readonly ok: boolean; readonly at: string } | null = null;

  function refresh(): void {
    if (refreshing || supervisor.running === undefined) return;
    refreshing = true;
    void supervisor
      .queryMaintenanceHint()
      .then((report) => {
        hint = { at: now(), report };
        options.changed();
      })
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  }

  function section(): RepairMaintenanceSection {
    if (supervisor.running !== undefined && (hint === null || now() - hint.at >= HINT_WINDOW_MS)) refresh();
    const known = hint?.report.status === "known" ? hint.report : null;
    return {
      reclaimableBytes: known?.reclaimableBytes ?? null,
      databaseBytes: known?.databaseBytes ?? null,
      suggest: known?.suggest === true,
      last: known?.last ?? null,
      check,
    };
  }

  function failure(
    mode: MaintenanceMode,
    reason: MaintenanceFailureReason,
    extra: Partial<Extract<MaintenanceRunResult, { ok: false }>> = {},
  ): MaintenanceRunResult {
    return { ok: false, mode, reason, dataIntact: true, backendRunning: supervisor.running !== undefined, ...extra };
  }

  async function busyNow() {
    const activity = supervisor.running === undefined ? null : await supervisor.queryActivity();
    return busyDetailOf({ current: coordinator.current(), pageAction: state.busy, activity });
  }

  /** The step failed or never ran: the original database is as it was, so the backend goes back to it. */
  async function bringBack(): Promise<boolean> {
    if (supervisor.running !== undefined) return true;
    const restored: RestartOutcome = await backend
      .start("restart")
      .catch(() => ({ ok: false as const, code: "REPAIR_REQUIRED" }));
    if (restored.ok) {
      backend.presenter().clear();
      return true;
    }
    if (!restored.busy) backend.recovery.handleFailure(restored.code);
    return false;
  }

  async function runCheck(databasePath: string): Promise<MaintenanceRunResult> {
    const backupDirectory = state.backupDirectory() ?? undefined;
    const outcome = await supervisor.maintainDatabase({
      mode: "check",
      databasePath,
      ...(backupDirectory ? { backupDirectory } : {}),
    });
    const reason = maintenanceFailureOf(outcome);
    if (reason === null) {
      check = { ok: true, at: new Date(now()).toISOString() };
      return { ok: true, mode: "check" };
    }
    if (reason === "integrity-failed") check = { ok: false, at: new Date(now()).toISOString() };
    return failure("check", reason);
  }

  async function execute(databasePath: string): Promise<MaintenanceRunResult> {
    backend.recovery.cancel();
    const seen: { child?: DatabaseMaintainOutcome; before?: string | null; entered?: boolean } = {};
    const backupDirectory = state.backupDirectory() ?? undefined;
    const step = async (context: OperationStepContext): Promise<JournalJson> => {
      seen.entered = true;
      await context.markMigrationStarted();
      seen.before = fingerprintOf(databasePath);
      const child = await supervisor.maintainDatabase({
        mode: "maintain",
        databasePath,
        ...(backupDirectory ? { backupDirectory } : {}),
      });
      seen.child = child;
      const reason = maintenanceFailureOf(child);
      if (reason) throw new MaintenanceStepFailure(reason);
      return { maintained: true };
    };
    const outcome = await backend.maintainWhileStopped(step);
    // The backup made first is a new file in the backup folder, even when the work failed afterwards.
    options.backupsChanged();
    hint = null;
    const child = seen.child;
    const backupFileName = child?.outcome === "checked" ? child.result.backupFileName : undefined;
    if (outcome.ok) {
      backend.presenter().clear();
      if (child?.outcome !== "checked" || child.result.status !== "ok") {
        return failure("maintain", "failed", { dataIntact: false });
      }
      log("[shell] database maintenance finished");
      return {
        ok: true,
        mode: "maintain",
        ...(backupFileName ? { backupFileName } : {}),
        ...(child.result.reclaimedBytes ? { reclaimedBytes: child.result.reclaimedBytes } : {}),
      };
    }
    if (outcome.busy) {
      const holder = coordinator.current();
      return failure("maintain", "busy", {
        busy: holder ? { source: "operation", operation: holder.kind } : { source: "unknown" },
      });
    }
    if (child?.outcome === "checked" && child.result.status === "ok") {
      // The work finished but the service did not start again.
      log(`[shell] database did not start after maintenance (${outcome.code})`);
      backend.presenter().present(outcome.code);
      return failure("maintain", "start-failed", {
        dataIntact: false,
        backendRunning: false,
        ...(backupFileName ? { backupFileName } : {}),
      });
    }
    let reason: MaintenanceFailureReason = child ? (maintenanceFailureOf(child) ?? "failed") : "failed";
    if (reason === "outcome-unknown") {
      // No verdict: only a file that is provably the same one it was may be called unchanged.
      const after = fingerprintOf(databasePath);
      if (seen.before != null && after === seen.before) reason = "failed";
      else {
        log("[shell] maintenance gave no verdict and the database could not be shown unchanged");
        const running = await bringBack();
        return failure("maintain", "outcome-unknown", { dataIntact: false, backendRunning: running });
      }
    }
    log(`[shell] database maintenance did not finish (${reason})`);
    const running = await bringBack();
    if (!seen.entered) {
      // The work never began (a refused start, a runtime that could not be prepared, a service that would not stop): the
      // database was not touched, whatever the reason says.
      return failure("maintain", reason, { dataIntact: true, backendRunning: running });
    }
    // A refusal before the compaction (in use, missing, invalid, integrity, backup) leaves the file as it was; a failure during it does not claim that.
    const untouched = reason !== "failed" && reason !== "integrity-failed";
    return failure("maintain", reason, {
      dataIntact:
        untouched || (reason === "failed" && seen.before != null && fingerprintOf(databasePath) === seen.before),
      backendRunning: running,
      ...(backupFileName ? { backupFileName } : {}),
    });
  }

  async function run(mode: MaintenanceMode): Promise<MaintenanceRunResult> {
    const databasePath = state.databasePath();
    if (databasePath === null) return failure(mode, "no-database");
    const early = await busyNow();
    if (early) return failure(mode, "busy", { busy: early });
    if (await options.agentsRunning().catch(() => false)) return failure(mode, "agents-running");
    if (mode === "maintain") {
      if (!(await options.confirm())) return failure(mode, "cancelled");
      const late = await busyNow();
      if (late) return failure(mode, "busy", { busy: late });
    }
    // Tested and set in one synchronous step: another action may have taken the lock during the awaits above.
    if (state.busy) return failure(mode, "busy", { busy: { source: "page-action" } });
    state.busy = true;
    state.busyAction = "maintenance";
    state.touch();
    try {
      return mode === "check" ? await runCheck(databasePath) : await execute(databasePath);
    } finally {
      if (state.busyAction === "maintenance") {
        state.busy = false;
        state.busyAction = null;
        state.touch();
      }
      options.changed();
    }
  }

  return { section, run };
}
