import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  busyDetailOf,
  formatBackupSize,
  inspectedItems,
  missingRoots,
  planRelocation,
  remapList,
  restoreFailureOf,
  restoreMessages,
  RestoreBackupStore,
  viewOf,
  type BackendSupervisor,
  type DatabaseRestoreOutcome,
  type JournalJson,
  type OperationCoordinator,
  type OperationStepContext,
  type RestoreBackupView,
  type RestoreBusyDetail,
  type RestoreEntry,
  type RestoreFailureReason,
  type RestoreListResult,
  type RestorePickResult,
  type RestartOutcome,
  type RestoreRunResult,
} from "@work-intelligence/desktop-core";
import type { BackendController } from "./backend.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

// Nothing is stopped before the user confirmed: checks and the native confirmation run first, then the operation.
export interface RestoreController {
  list(senderId: number): Promise<RestoreListResult>;
  pick(senderId: number): Promise<RestorePickResult>;
  run(senderId: number, backupId: string): Promise<RestoreRunResult>;
}

export interface RestoreConfirmDetails {
  readonly database: string | null;
  readonly time: string;
  readonly size: string;
  readonly remapped: number;
}

export type RelocateChoice = "choose" | "skip" | "cancel";

export interface RelocateDetails {
  readonly total: number;
  readonly missing: number;
  readonly mapped: number;
  readonly noMatch: boolean;
}

/** @internal test-only */
export interface RestoreOptions {
  readonly state: ShellState;
  readonly coordinator: Pick<OperationCoordinator, "current">;
  readonly supervisor: Pick<
    BackendSupervisor,
    "running" | "queryActivity" | "inspectBackups" | "restoreDatabase" | "backupRoots"
  >;
  readonly backend: Pick<BackendController, "restoreWhileStopped" | "start" | "presenter" | "recovery">;
  readonly agentsRunning: () => Promise<boolean>;
  readonly chooseFile: () => Promise<string | null>;
  readonly relocate?: (details: RelocateDetails) => Promise<RelocateChoice>;
  readonly chooseFolder?: () => Promise<string | null>;
  readonly directoryExists?: (folder: string) => Promise<boolean>;
  readonly confirm: (details: RestoreConfirmDetails) => Promise<boolean>;
  readonly fingerprint?: (databasePath: string) => string | null;
  readonly backupsChanged: () => void;
  readonly store?: RestoreBackupStore<RestoreEntry>;
  readonly clock?: () => number;
  readonly log: Logger;
}

export const RESTORE_LIST_LIMIT = 12;

class RestoreStepFailure extends Error {
  constructor(readonly reason: RestoreFailureReason) {
    super(`restore refused: ${reason}`);
  }
}

function modifiedAt(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
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

function describeTime(locale: string, iso: string | null, unknown: string): string {
  if (iso === null) return unknown;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? unknown
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function createRestore(options: RestoreOptions): RestoreController {
  const { state, coordinator, supervisor, backend, log } = options;
  const fingerprintOf = options.fingerprint ?? fileFingerprint;
  const directoryExists =
    options.directoryExists ??
    ((folder: string) =>
      stat(folder).then(
        (found) => found.isDirectory(),
        () => false,
      ));
  const store = options.store ?? new RestoreBackupStore<RestoreEntry>({ clock: options.clock ?? Date.now });

  function backupDirectory(): string | undefined {
    return state.backupDirectory() ?? undefined;
  }

  async function activity(): Promise<Awaited<ReturnType<BackendSupervisor["queryActivity"]>> | null> {
    return supervisor.running === undefined ? null : supervisor.queryActivity();
  }

  /** What holds a restore back right now, or null when nothing does. */
  async function busyNow(): Promise<RestoreBusyDetail | null> {
    return busyDetailOf({ current: coordinator.current(), pageAction: state.busy, activity: await activity() });
  }

  function failure(
    reason: RestoreFailureReason,
    extra: Partial<Extract<RestoreRunResult, { ok: false }>> = {},
  ): RestoreRunResult {
    return { ok: false, reason, dataIntact: true, backendRunning: supervisor.running !== undefined, ...extra };
  }

  async function list(senderId: number): Promise<RestoreListResult> {
    const databasePath = state.databasePath();
    if (databasePath === null) {
      return { ok: true, backups: [], directoryReadable: true, agentsRunning: false, noDatabase: true };
    }
    const outcome = await supervisor.inspectBackups({
      databasePath,
      ...(backupDirectory() ? { backupDirectory: backupDirectory() } : {}),
      integrity: false,
      limit: RESTORE_LIST_LIMIT,
    });
    const items = inspectedItems(outcome);
    if (items === null) return { ok: false, reason: "failed" };
    const entries = items.map((item): RestoreEntry => ({ path: item.path, view: viewOf(item) }));
    // Only a backup that can be restored from gets an id; a refused one is shown with its reason and cannot be chosen.
    const restorable = entries.filter((entry) => entry.view.problem === null);
    const ids = store.putListed(senderId, restorable);
    let next = 0;
    const backups: RestoreBackupView[] = entries.map((entry) =>
      entry.view.problem === null ? { ...entry.view, backupId: ids[next++] } : entry.view,
    );
    const agentsRunning = await options.agentsRunning().catch(() => false);
    const directoryReadable = outcome.outcome === "checked" ? outcome.result.directoryReadable : false;
    return { ok: true, backups, directoryReadable, agentsRunning, noDatabase: false };
  }

  async function pick(senderId: number): Promise<RestorePickResult> {
    const file = await options.chooseFile();
    if (file === null) return { ok: false, reason: "cancelled" };
    const outcome = await supervisor.inspectBackups({
      databasePath: state.databasePath() ?? file,
      files: [file],
    });
    const item = inspectedItems(outcome)?.[0];
    if (!item) return { ok: false, reason: "failed" };
    // Refused here, before the user sees a confirmation: a file that is not ours, damaged, or from a newer App.
    if (item.status !== "ok") {
      return {
        ok: false,
        reason: item.status,
        ...(item.status === "newer-schema" && item.schemaVersion !== undefined
          ? { schemaVersion: item.schemaVersion }
          : {}),
      };
    }
    const view = viewOf(item, { picked: true, modifiedAt: modifiedAt(file) });
    const backupId = store.putPicked(senderId, { path: file, view });
    return { ok: true, backup: { ...view, backupId } };
  }

  /** The restore step: runs while the backend is stopped, inside the operation. */
  function replaceStep(
    entry: RestoreEntry,
    databasePath: string,
    seen: { child?: DatabaseRestoreOutcome; before?: string | null },
    remap: readonly { from: string; to: string }[],
  ): (context: OperationStepContext) => Promise<JournalJson> {
    return async (context) => {
      // The point of no return of the operation: a crash from here on is resolved from the real state, never resumed.
      await context.markMigrationStarted();
      // The backend is stopped here: this is the file as the restore finds it.
      seen.before = fingerprintOf(databasePath);
      const child = await supervisor.restoreDatabase({
        source: entry.path,
        databasePath,
        ...(backupDirectory() ? { backupDirectory: backupDirectory() } : {}),
        ...(remap.length > 0 ? { remap } : {}),
      });
      seen.child = child;
      const reason = restoreFailureOf(child);
      if (reason) throw new RestoreStepFailure(reason);
      return { restored: true };
    };
  }

  /** The step failed or never ran: the original database is as it was, so the backend goes back to it. */
  async function bringBackOriginal(): Promise<boolean> {
    // A refusal before anything was stopped (the old login service, a network share) leaves the backend serving.
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

  /**
   * The project folders of the backup that are not on this computer, matched to a place the user chooses in the native
   * dialog. `null`: the user cancelled. An empty map: nothing to move (every folder exists, the file could not be read, or the
   * user chose to keep the old paths). Every path stays in main.
   */
  async function relocation(entry: RestoreEntry, databasePath: string): Promise<Map<string, string> | null> {
    const mapped = new Map<string, string>();
    const { relocate, chooseFolder } = options;
    if (!relocate || !chooseFolder) return mapped;
    const found = await supervisor.backupRoots(entry.path, databasePath).catch(() => undefined);
    // A listing that failed is not a reason to refuse the restore: the old paths are kept, as before.
    if (found?.outcome !== "checked" || found.result.status !== "ok") return mapped;
    const roots = found.result.roots;
    const missing = await missingRoots(roots, (candidate) => directoryExists(candidate));
    let noMatch = false;
    for (;;) {
      const remaining = missing.filter((root) => !mapped.has(root.path));
      if (remaining.length === 0) return mapped;
      const choice = await relocate({ total: roots.length, missing: remaining.length, mapped: mapped.size, noMatch });
      if (choice === "cancel") return null;
      if (choice === "skip") return mapped;
      const folder = await chooseFolder();
      if (folder === null) continue;
      const found = await planRelocation({ missing: remaining, chosen: folder, directoryExists });
      noMatch = found.size === 0;
      for (const [from, to] of found) mapped.set(from, to);
    }
  }

  async function run(senderId: number, backupId: string): Promise<RestoreRunResult> {
    const claim = store.claim(senderId, backupId);
    if (!claim) return failure("expired");
    const { entry } = claim;
    const databasePath = state.databasePath();
    if (databasePath === null) {
      claim.release();
      return failure("no-database");
    }
    const early = await busyNow();
    if (early) {
      claim.release();
      return failure("busy", { busy: early });
    }
    // Agent processes may still hold the database: tell the user now, before any dialog, and stop nothing.
    if (await options.agentsRunning().catch(() => false)) {
      claim.release();
      return failure("agents-running");
    }
    const mapped = await relocation(entry, databasePath);
    if (mapped === null) {
      claim.release();
      return failure("cancelled");
    }
    const remap = remapList(mapped);
    const messages = restoreMessages(state.locale);
    const confirmed = await options.confirm({
      database: existsSync(databasePath) ? databasePath : null,
      time: describeTime(state.locale, entry.view.createdAt, messages.unknownTime),
      size: formatBackupSize(entry.view.bytes),
      remapped: remap.length,
    });
    if (!confirmed) {
      claim.release();
      return failure("cancelled");
    }
    // Something may have started while the dialog was open.
    const late = await busyNow();
    if (late) {
      claim.release();
      return failure("busy", { busy: late });
    }
    // The window's other actions wait while the restore runs (the same single lock as every page action). Tested and set in
    // one synchronous step: another action may have taken the lock during the awaits above, and it is never overwritten.
    if (state.busy) {
      claim.release();
      return failure("busy", { busy: { source: "page-action" } });
    }
    state.busy = true;
    state.busyAction = "restore";
    state.touch();
    try {
      return await execute(claim, entry, databasePath, remap);
    } finally {
      // Only what this run set is cleared.
      if (state.busyAction === "restore") {
        state.busy = false;
        state.busyAction = null;
        state.touch();
      }
    }
  }

  /** Stop, replace, start, verify; on a failure that left the data alone, bring the backend back on it. */
  async function execute(
    claim: { release(): void },
    entry: RestoreEntry,
    databasePath: string,
    remap: readonly { from: string; to: string }[],
  ): Promise<RestoreRunResult> {
    // A pending automatic retry must not start the old database while the restore runs.
    backend.recovery.cancel();
    const seen: { child?: DatabaseRestoreOutcome; before?: string | null } = {};
    const outcome = await backend.restoreWhileStopped(replaceStep(entry, databasePath, seen, remap));
    options.backupsChanged();
    if (outcome.ok) {
      backend.presenter().clear();
      const child = seen.child;
      if (child?.outcome !== "checked" || child.result.status !== "ok") {
        // The operation says done but the step did not report a restore: never claim data that was not verified.
        return failure("failed", { dataIntact: false });
      }
      log("[shell] database restored from a backup");
      return {
        ok: true,
        ...(child.result.safetyBackup ? { safetyBackup: child.result.safetyBackup } : {}),
        projects: child.result.projects ?? 0,
        sessions: child.result.sessions ?? 0,
        ...(child.result.remappedProjects ? { remapped: child.result.remappedProjects } : {}),
      };
    }
    if (outcome.busy) {
      claim.release();
      const holder = coordinator.current();
      return failure("busy", {
        busy: holder ? { source: "operation", operation: holder.kind } : { source: "unknown" },
      });
    }
    const child = seen.child;
    if (child?.outcome === "checked" && child.result.status === "ok") {
      // The database was replaced but the service did not start on it. The data from before is in the safety backup.
      log(`[shell] restored database did not start (${outcome.code})`);
      backend.presenter().present(outcome.code);
      return failure("start-failed", {
        dataIntact: false,
        backendRunning: false,
        errorCode: outcome.code,
        ...(child.result.safetyBackup ? { safetyBackup: child.result.safetyBackup } : {}),
      });
    }
    // Not replaced: classify why, bring the backend back on the original database.
    let reason = child ? (restoreFailureOf(child) ?? "failed") : "failed";
    if (reason === "outcome-unknown") {
      // The child was sent the request and gave no verdict (it crashed or ended). Only a file that is provably the same
      // one it was before may be called unchanged; otherwise nothing is claimed and the user is pointed to the safety backup.
      const now = fingerprintOf(databasePath);
      if (seen.before != null && now === seen.before) reason = "failed";
      else {
        log("[shell] restore gave no verdict and the database could not be shown unchanged");
        const running = await bringBackOriginal();
        return failure("outcome-unknown", { dataIntact: false, backendRunning: running });
      }
    }
    log(`[shell] restore did not replace the database (${reason})`);
    // A file that is itself unusable stays refused; one that was merely held (lock, Agent, space) may be tried again.
    if (reason === "locked" || reason === "agents-running" || reason === "no-space" || reason === "failed") {
      claim.release();
    }
    const running = await bringBackOriginal();
    return failure(reason, { backendRunning: running });
  }

  return { list, pick, run };
}
