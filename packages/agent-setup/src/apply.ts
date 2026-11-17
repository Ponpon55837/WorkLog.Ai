/**
 * Plan, apply, verify, compensate (DT-21). Every item is fingerprint-checked when the plan is made, again right before
 * its turn, and a third time right before the rename (temporary file written, target re-read, rename). The last window
 * is microseconds wide but cannot be closed entirely: neither POSIX nor Windows offers a compare-and-swap rename, so an
 * Agent that rewrites its own config in that instant still wins the race and loses nothing but our write being based
 * on stale bytes. ADR-14: this is not an OS-level transaction and needs host cooperation (a lock) to be one.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  ABSENT_FINGERPRINT,
  FingerprintMismatchError,
  ensureDirectory,
  fingerprintOf,
  readCurrent,
  removeAtomically,
  writeAtomically,
  writeExclusiveAtomically,
} from "./files.js";
import {
  moveAgentSetupJournalAside,
  readAgentSetupJournal,
  writeAgentSetupJournal,
  type AgentSetupJournal,
  type AgentSetupJournalItem,
} from "./journal.js";
import { knownTargetPaths, type AgentSetupLocation } from "./paths.js";
import type { AgentSetupFileMutation, AgentSetupPlan } from "./types.js";

/** What happened to one planned item. `skipped` items were never attempted because an earlier item stopped the apply. */
export type AgentSetupItemStatus = "written" | "skipped" | "externally-modified" | "failed";

/** The re-read after the apply: does the file hold exactly what this operation wrote. */
export type AgentSetupVerifyStatus = "verified" | "mismatch" | "unreadable" | "not-run";

/**
 * What compensation did to one item: `restored` the original, `unchanged` (nothing of ours to undo), left it for
 * `manual-repair` because someone else changed it, `not-attempted` because compensation stopped at an earlier external
 * change, or `failed` while restoring. `none` when no compensation ran or the item was never touched.
 */
export type AgentSetupCompensationStatus =
  "none" | "restored" | "unchanged" | "manual-repair" | "not-attempted" | "failed";

/** Machine-readable reasons; results never carry file contents or raw error text. */
export type AgentSetupErrorCode =
  | "plan-has-conflicts"
  | "backup-exists"
  | "unfinished-journal"
  | "journal-write-failed"
  | "externally-modified"
  | "read-failed"
  | "write-failed"
  | "verify-mismatch"
  | "journal-corrupt-moved"
  | "journal-paths-invalid";

export interface AgentSetupItemResult {
  index: number;
  path: string;
  label: string;
  status: AgentSetupItemStatus;
  code?: AgentSetupErrorCode;
  verify: AgentSetupVerifyStatus;
  compensation: AgentSetupCompensationStatus;
}

/**
 * `committed`: everything written and verified. `rolled-back`: the apply stopped and everything this operation had
 * written was undone (possibly nothing). `needs-manual-repair`: compensation had to leave an externally changed item.
 * `refused`: rejected before anything was written.
 */
export interface AgentSetupTransactionResult {
  operationId: string;
  outcome: "committed" | "rolled-back" | "needs-manual-repair" | "refused";
  code?: AgentSetupErrorCode;
  items: AgentSetupItemResult[];
  journalPath?: string;
  /** Set when an unreadable journal from an earlier run was moved aside (not deleted) so this apply could proceed. */
  corruptJournalPath?: string;
}

export interface AgentSetupTransactionOptions {
  /** Where the operation journal is written before the first write; see {@link agentSetupJournalPath}. */
  journalPath: string;
  /** Test seam for simulating a filesystem failure, or an external edit, right before an item is written. */
  beforeWrite?: (mutation: AgentSetupFileMutation, index: number) => void;
  /** Test seam that runs right after an item was written. */
  afterWrite?: (mutation: AgentSetupFileMutation, index: number) => void;
  /** Test seam for the journal writer; defaults to {@link writeAgentSetupJournal}. */
  writeJournal?: typeof writeAgentSetupJournal;
}

export interface AgentSetupRecoveryResult {
  /**
   * `none`: no journal; `moved-aside`: not a journal of this version, kept as `corruptJournalPath`; `unreadable`: the
   * same, but it could not be moved; `already-final`: committed or compensated. A pending journal whose paths are not
   * ours (`journal-paths-invalid`) is marked `needs-manual-repair` and no file is touched.
   */
  status: "none" | "moved-aside" | "unreadable" | "already-final" | "recovered" | "needs-manual-repair";
  code?: AgentSetupErrorCode;
  operationId?: string;
  items: AgentSetupItemResult[];
  corruptJournalPath?: string;
}

/** Where recovery expects setup's files to be; the journal is user-writable, so its paths are checked against this. */
export type AgentSetupRecoveryLocation = AgentSetupLocation;

export interface AgentSetupApplyResult {
  applied: boolean;
  actions: string[];
  conflicts: string[];
  error?: string;
}

export interface AgentSetupApplyOptions {
  /** Test seam for simulating a filesystem failure before a staged write. */
  beforeWrite?: (mutation: AgentSetupFileMutation, index: number) => void;
}

interface TransactionRunOptions {
  journalPath?: string;
  /** Re-read every written file after the last item; the CLI path skips it, as it always has. */
  verify: boolean;
  beforeWrite?: AgentSetupApplyOptions["beforeWrite"];
  afterWrite?: AgentSetupTransactionOptions["afterWrite"];
  writeJournal?: AgentSetupTransactionOptions["writeJournal"];
}

/** A finished run plus the raw messages only the legacy wrapper prints; the public result never carries them. */
interface TransactionRun {
  result: AgentSetupTransactionResult;
  failure?: string;
  rollbackErrors: string[];
}

interface CompensationEntry {
  item: AgentSetupJournalItem;
  /** The original bytes: from memory while applying, from the backup copy when recovering after a crash. */
  loadBefore: () => Buffer | null;
}

interface CompensationReport {
  statuses: AgentSetupCompensationStatus[];
  errors: string[];
  complete: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fingerprintAt(path: string): string {
  return fingerprintOf(readCurrent(path));
}

function loadFromBackup(item: AgentSetupJournalItem): Buffer | null {
  if (item.beforeFingerprint === ABSENT_FINGERPRINT) return null;
  if (!item.backupPath) throw new Error("backup-missing");
  const bytes = readFileSync(item.backupPath);
  if (fingerprintOf(bytes) !== item.beforeFingerprint) throw new Error("backup-changed");
  return bytes;
}

/**
 * Undoes what this operation wrote, newest first. An item is restored only if it is ours (`writing` or `written`) and
 * still holds exactly what we wrote; anything else changed since, so it is left alone and compensation stops there:
 * restoring older items around someone else's edit could leave the configs inconsistent.
 */
function compensate(entries: CompensationEntry[]): CompensationReport {
  const statuses = entries.map((): AgentSetupCompensationStatus => "none");
  const errors: string[] = [];
  let stopped = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.item.state === "planned") continue;
    if (stopped) {
      statuses[index] = "not-attempted";
      continue;
    }
    const { item } = entry;
    try {
      const current = fingerprintAt(item.path);
      if (current === item.beforeFingerprint) {
        statuses[index] = "unchanged";
      } else if (current !== item.afterFingerprint) {
        statuses[index] = "manual-repair";
        stopped = true;
      } else {
        const before = entry.loadBefore();
        if (before === null) {
          removeAtomically(item.path, item.afterFingerprint);
        } else {
          writeAtomically(item.path, before, item.mode, item.afterFingerprint);
        }
        statuses[index] = "restored";
      }
    } catch (error) {
      if (error instanceof FingerprintMismatchError) {
        // Changed between the check above and the restore: not ours any more, same as an earlier external change.
        statuses[index] = "manual-repair";
        stopped = true;
      } else {
        statuses[index] = "failed";
        errors.push(messageOf(error));
      }
    }
  }
  return {
    statuses,
    errors,
    complete: statuses.every(
      (status) => status !== "manual-repair" && status !== "failed" && status !== "not-attempted",
    ),
  };
}

/**
 * After a complete compensation the backups this operation created and the directories it created have no purpose
 * left. A backup that was already there when ours failed to be created belongs to someone else and stays.
 */
function cleanUp(
  items: readonly AgentSetupJournalItem[],
  createdDirectories: Iterable<string>,
  errors: string[],
): void {
  for (const item of items) {
    if (!item.backupPath || !item.backupCreated) continue;
    try {
      rmSync(item.backupPath, { force: true });
    } catch (error) {
      errors.push(messageOf(error));
    }
  }
  for (const directory of [...createdDirectories].sort((left, right) => right.length - left.length)) {
    try {
      rmdirSync(directory);
    } catch {
      // Keep directories that are no longer empty; empty ones are best-effort cleanup.
    }
  }
}

function applyCompensation(items: AgentSetupItemResult[], report: CompensationReport): void {
  for (const [index, status] of report.statuses.entries()) {
    const item = items[index];
    if (item) item.compensation = status;
  }
}

function runTransaction(plan: AgentSetupPlan, options: TransactionRunOptions): TransactionRun {
  const operationId = randomUUID();
  const items: AgentSetupItemResult[] = plan.mutations.map((mutation, index) => ({
    index,
    path: mutation.path,
    label: mutation.label,
    status: "skipped",
    verify: "not-run",
    compensation: "none",
  }));
  let corruptJournalPath: string | undefined;
  const finish = (result: AgentSetupTransactionResult): AgentSetupTransactionResult =>
    corruptJournalPath === undefined
      ? result
      : { ...result, code: result.code ?? "journal-corrupt-moved", corruptJournalPath };
  const refuse = (code: AgentSetupErrorCode): TransactionRun => ({
    result: finish({ operationId, outcome: "refused", code, items, journalPath: options.journalPath }),
    rollbackErrors: [],
  });

  if (plan.conflicts.length) return refuse("plan-has-conflicts");
  if (plan.mutations.some((mutation) => mutation.backupPath && existsSync(mutation.backupPath))) {
    return refuse("backup-exists");
  }

  const createdDirectories = new Set<string>();
  const journal: AgentSetupJournal = {
    version: 1,
    operationId,
    state: "pending",
    startedAt: new Date().toISOString(),
    items: plan.mutations.map((mutation) => ({
      path: mutation.path,
      label: mutation.label,
      mode: mutation.mode,
      beforeFingerprint: mutation.beforeFingerprint,
      afterFingerprint: mutation.afterFingerprint,
      ...(mutation.backupPath ? { backupPath: mutation.backupPath } : {}),
      state: "planned",
    })),
    createdDirectories: [],
  };
  const persist = (): void => {
    if (!options.journalPath) return;
    journal.createdDirectories = [...createdDirectories];
    (options.writeJournal ?? writeAgentSetupJournal)(options.journalPath, journal);
  };
  if (options.journalPath) {
    const previous = readAgentSetupJournal(options.journalPath);
    if (previous.status === "found" && previous.journal.state === "pending") return refuse("unfinished-journal");
    if (previous.status === "unreadable") {
      // An unreadable journal must not block every later apply; keep it for inspection instead of deleting it.
      const moved = moveAgentSetupJournalAside(options.journalPath);
      if (moved === null) return refuse("unfinished-journal");
      corruptJournalPath = moved;
    }
    try {
      persist();
    } catch {
      return refuse("journal-write-failed");
    }
  }

  let stopCode: AgentSetupErrorCode | undefined;
  let failure: string | undefined;
  let code: AgentSetupErrorCode = "write-failed";
  const fail = (error: unknown): void => {
    stopCode = code;
    failure = messageOf(error);
  };

  try {
    for (const [index, mutation] of plan.mutations.entries()) {
      if (!mutation.before || !mutation.backupPath) continue;
      ensureDirectory(dirname(mutation.backupPath), createdDirectories);
      writeExclusiveAtomically(mutation.backupPath, mutation.before);
      const entry = journal.items[index];
      if (entry) entry.backupCreated = true;
    }
  } catch (error) {
    fail(error);
  }

  for (const [index, mutation] of plan.mutations.entries()) {
    if (stopCode) break;
    const result = items[index];
    const entry = journal.items[index];
    if (!result || !entry) break;
    try {
      options.beforeWrite?.(mutation, index);
      // Durable before the item is touched, so a crash can tell that this item may already hold our bytes.
      code = "journal-write-failed";
      entry.state = "writing";
      persist();
      code = "read-failed";
      // R16: the fingerprint is checked right before this item's write, not only when the plan was made.
      if (fingerprintAt(mutation.path) !== mutation.beforeFingerprint) {
        entry.state = "planned";
        result.status = "externally-modified";
        result.code = "externally-modified";
        stopCode = "externally-modified";
        break;
      }
      code = "write-failed";
      ensureDirectory(dirname(mutation.path), createdDirectories);
      // The fingerprint is checked once more after the temporary file is ready, right before the rename.
      if (mutation.after === null) {
        removeAtomically(mutation.path, mutation.beforeFingerprint);
      } else {
        writeAtomically(mutation.path, mutation.after, mutation.mode, mutation.beforeFingerprint);
      }
      result.status = "written";
      options.afterWrite?.(mutation, index);
    } catch (error) {
      if (error instanceof FingerprintMismatchError) {
        entry.state = "planned";
        result.status = "externally-modified";
        result.code = "externally-modified";
        stopCode = "externally-modified";
        break;
      }
      if (result.status !== "written") result.status = "failed";
      // Only a failure inside the write itself can have left our bytes behind.
      if (code !== "write-failed") entry.state = "planned";
      result.code = code;
      fail(error);
    }
  }

  if (!stopCode && options.verify) {
    for (const result of items) {
      const mutation = plan.mutations[result.index];
      if (!mutation) continue;
      try {
        result.verify = fingerprintAt(mutation.path) === mutation.afterFingerprint ? "verified" : "mismatch";
      } catch {
        result.verify = "unreadable";
      }
    }
    if (items.some((result) => result.verify !== "verified")) stopCode = "verify-mismatch";
  }

  if (!stopCode) {
    journal.state = "committed";
    for (const entry of journal.items) entry.state = "written";
    try {
      persist();
      return {
        result: finish({ operationId, outcome: "committed", items, journalPath: options.journalPath }),
        rollbackErrors: [],
      };
    } catch (error) {
      // Without the commit mark a later recovery would undo a finished operation, so undo it now instead.
      stopCode = "journal-write-failed";
      failure = messageOf(error);
      journal.state = "pending";
    }
  }

  const report = compensate(
    journal.items.map((item, index) => ({ item, loadBefore: () => plan.mutations[index]?.before ?? null })),
  );
  applyCompensation(items, report);
  const rollbackErrors = [...report.errors];
  if (report.complete) cleanUp(journal.items, createdDirectories, rollbackErrors);
  journal.state = report.complete ? "compensated" : "needs-manual-repair";
  try {
    persist();
  } catch {
    // The files are already in their final state; recovery of a pending journal re-checks them and is idempotent.
  }
  return {
    result: finish({
      operationId,
      outcome: report.complete ? "rolled-back" : "needs-manual-repair",
      code: stopCode,
      items,
      journalPath: options.journalPath,
    }),
    ...(failure === undefined ? {} : { failure }),
    rollbackErrors,
  };
}

/**
 * Applies a plan as one recoverable transaction for the desktop App. Before each item is written its file is
 * re-fingerprinted against the plan (R16); a changed file is never overwritten, the apply stops, and what this
 * operation already wrote is compensated. A journal (R17) is written before the first write, so
 * {@link recoverAgentSetupJournal} can finish the compensation after a crash. After the last item every file is
 * re-read and checked against what was written.
 */
export function applyAgentSetupTransaction(
  plan: AgentSetupPlan,
  options: AgentSetupTransactionOptions,
): AgentSetupTransactionResult {
  return runTransaction(plan, { ...options, verify: true }).result;
}

/** Windows paths compare case-insensitively; everything else byte for byte. */
function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isInside(path: string, root: string, inclusive: boolean): boolean {
  return (inclusive && path === root) || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** `<path>.work-intelligence.backup-<yyyymmddThhmmssmmmZ>-<8 hex>[-<n>]`, as {@link backupPathFor} names them. */
function isBackupSibling(backupPath: string, path: string): boolean {
  const prefix = `${basename(path)}.work-intelligence.backup-`;
  const name = basename(backupPath);
  return (
    comparablePath(dirname(backupPath)) === comparablePath(dirname(path)) &&
    name.startsWith(prefix) &&
    /^\d{8}T\d{9}Z-[0-9a-f]{8}(?:-\d+)?$/.test(name.slice(prefix.length))
  );
}

/**
 * The journal is a user-writable file, and recovery rewrites and deletes whatever it names. It is only followed when
 * every item is one of setup's own target files, every backup is a sibling named the way setup names backups, and every
 * created directory is a parent of a target below the home or an Agent config directory.
 */
function journalPathsAreOurs(journal: AgentSetupJournal, location: AgentSetupRecoveryLocation): boolean {
  const homeDirectory = resolve(location.homeDirectory);
  const home = comparablePath(homeDirectory);
  const targets = [...knownTargetPaths(location)].map(comparablePath);
  const known = new Set(targets);
  const roots = [
    { path: home, inclusive: false },
    { path: comparablePath(location.codexHomeDirectory ?? join(homeDirectory, ".codex")), inclusive: true },
    { path: comparablePath(location.claudeConfigDirectory ?? join(homeDirectory, ".claude")), inclusive: true },
  ];
  const itemsAreOurs = journal.items.every(
    (item) =>
      known.has(comparablePath(item.path)) &&
      (item.backupPath === undefined || isBackupSibling(item.backupPath, item.path)),
  );
  return (
    itemsAreOurs &&
    journal.createdDirectories.every((directory) => {
      const comparable = comparablePath(directory);
      return (
        roots.some((root) => isInside(comparable, root.path, root.inclusive)) &&
        targets.some((target) => isInside(target, comparable, false))
      );
    })
  );
}

/**
 * Compensates an operation whose journal was left `pending` (the process died mid-apply). Only items this operation
 * wrote and that still hold exactly what it wrote are restored, from their backup copies; everything else is reported.
 * A journal that cannot be read is moved aside; one that names files setup does not own is marked for manual repair
 * without touching any of them.
 */
export function recoverAgentSetupJournal(
  journalPath: string,
  location: AgentSetupRecoveryLocation,
): AgentSetupRecoveryResult {
  const read = readAgentSetupJournal(journalPath);
  if (read.status === "none") return { status: "none", items: [] };
  if (read.status === "unreadable") {
    const moved = moveAgentSetupJournalAside(journalPath);
    return moved === null
      ? { status: "unreadable", items: [] }
      : { status: "moved-aside", code: "journal-corrupt-moved", corruptJournalPath: moved, items: [] };
  }
  const { journal } = read;
  const items: AgentSetupItemResult[] = journal.items.map((item, index) => ({
    index,
    path: item.path,
    label: item.label,
    status: item.state === "planned" ? "skipped" : "written",
    verify: "not-run",
    compensation: "none",
  }));
  if (journal.state !== "pending") return { status: "already-final", operationId: journal.operationId, items };
  if (!journalPathsAreOurs(journal, location)) {
    journal.state = "needs-manual-repair";
    writeAgentSetupJournal(journalPath, journal);
    return {
      status: "needs-manual-repair",
      code: "journal-paths-invalid",
      operationId: journal.operationId,
      items,
    };
  }

  const report = compensate(journal.items.map((item) => ({ item, loadBefore: () => loadFromBackup(item) })));
  applyCompensation(items, report);
  if (report.complete) cleanUp(journal.items, journal.createdDirectories, []);
  journal.state = report.complete ? "compensated" : "needs-manual-repair";
  writeAgentSetupJournal(journalPath, journal);
  return {
    status: report.complete ? "recovered" : "needs-manual-repair",
    operationId: journal.operationId,
    items,
  };
}

/**
 * The `pnpm setup:agents` apply: refuses before writing anything if a target changed since the preview or a backup
 * name is taken, then runs the same engine without a journal. Messages are the CLI's long-standing wording.
 */
export function applyAgentSetupPlan(plan: AgentSetupPlan, options: AgentSetupApplyOptions = {}): AgentSetupApplyResult {
  if (plan.conflicts.length) return { applied: false, actions: [], conflicts: plan.conflicts };
  try {
    for (const mutation of plan.mutations) {
      if (fingerprintAt(mutation.path) !== mutation.beforeFingerprint) {
        return {
          applied: false,
          actions: [],
          conflicts: [`${mutation.path} 在預覽後已變更；沒有寫入，請重新預覽。`],
        };
      }
      if (mutation.backupPath && existsSync(mutation.backupPath)) {
        return { applied: false, actions: [], conflicts: [`備份目標已存在：${mutation.backupPath}。`] };
      }
    }
  } catch (error) {
    return { applied: false, actions: [], conflicts: [], error: messageOf(error) };
  }

  const run = runTransaction(plan, { beforeWrite: options.beforeWrite, verify: false });
  if (run.result.outcome === "committed") return { applied: true, actions: plan.actions, conflicts: [] };
  const modified = run.result.items.find((item) => item.status === "externally-modified");
  if (modified) {
    return { applied: false, actions: [], conflicts: [`${modified.path} 在預覽後已變更；沒有寫入，請重新預覽。`] };
  }
  return {
    applied: false,
    actions: [],
    conflicts: [],
    error: [run.failure ?? "無法完成 Agent 設定。", ...run.rollbackErrors].join("；rollback 失敗："),
  };
}
