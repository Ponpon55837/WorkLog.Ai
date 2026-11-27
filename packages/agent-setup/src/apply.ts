/**
 * Items are fingerprint-checked at plan time, before their turn and right before the rename. That last window cannot
 * be closed: neither POSIX nor Windows offers a compare-and-swap rename (ADR-14).
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
import { MANIFEST_FILENAME } from "./constants.js";
import { undoOwnedEntries } from "./entry-undo.js";
import { parseManifest } from "./manifest.js";
import { knownTargetPaths, targetPath, type AgentSetupLocation } from "./paths.js";
import type { AgentSetupFileMutation, AgentSetupPlan } from "./types.js";

export type AgentSetupItemStatus = "written" | "skipped" | "externally-modified" | "failed";

export type AgentSetupVerifyStatus = "verified" | "mismatch" | "unreadable" | "not-run";

export type AgentSetupCompensationStatus =
  "none" | "restored" | "unchanged" | "manual-repair" | "not-attempted" | "failed";

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
  | "journal-paths-invalid"
  | "journal-unreadable";

export interface AgentSetupItemResult {
  index: number;
  path: string;
  label: string;
  status: AgentSetupItemStatus;
  code?: AgentSetupErrorCode;
  verify: AgentSetupVerifyStatus;
  compensation: AgentSetupCompensationStatus;
}

export interface AgentSetupTransactionResult {
  operationId: string;
  outcome: "committed" | "rolled-back" | "needs-manual-repair" | "refused";
  code?: AgentSetupErrorCode;
  items: AgentSetupItemResult[];
  journalPath?: string;
  corruptJournalPath?: string;
}

export interface AgentSetupTransactionOptions {
  journalPath: string;
  beforeWrite?: (mutation: AgentSetupFileMutation, index: number) => void;
  afterWrite?: (mutation: AgentSetupFileMutation, index: number) => void;
  writeJournal?: typeof writeAgentSetupJournal;
}

export interface AgentSetupRecoveryResult {
  status: "none" | "moved-aside" | "unreadable" | "already-final" | "recovered" | "needs-manual-repair";
  code?: AgentSetupErrorCode;
  operationId?: string;
  items: AgentSetupItemResult[];
  corruptJournalPath?: string;
}

export type AgentSetupRecoveryLocation = AgentSetupLocation;

export interface AgentSetupUndoResult {
  status: "nothing-to-undo" | "undone" | "needs-manual-repair" | "refused";
  code?: AgentSetupErrorCode;
  operationId?: string;
  items: AgentSetupItemResult[];
  manualRepairPath?: string;
}

export interface AgentSetupUndoOptions {
  afterRestore?: (item: AgentSetupJournalItem, index: number) => void;
}

export interface AgentSetupApplyResult {
  applied: boolean;
  actions: string[];
  conflicts: string[];
  error?: string;
}

export interface AgentSetupApplyOptions {
  beforeWrite?: (mutation: AgentSetupFileMutation, index: number) => void;
}

interface TransactionRunOptions {
  journalPath?: string;
  verify: boolean;
  beforeWrite?: AgentSetupApplyOptions["beforeWrite"];
  afterWrite?: AgentSetupTransactionOptions["afterWrite"];
  writeJournal?: AgentSetupTransactionOptions["writeJournal"];
}

interface TransactionRun {
  result: AgentSetupTransactionResult;
  failure?: string;
  rollbackErrors: string[];
}

interface CompensationEntry {
  item: AgentSetupJournalItem;
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

// Stops at the first item someone else changed: restoring older items around their edit could leave the configs inconsistent.
function compensate(
  entries: CompensationEntry[],
  afterRestore?: AgentSetupUndoOptions["afterRestore"],
): CompensationReport {
  const statuses = entries.map((): AgentSetupCompensationStatus => "none");
  const errors: string[] = [];
  let stopped = false;
  const isManifest = (entry: CompensationEntry | undefined): boolean =>
    entry !== undefined && basename(entry.item.path) === MANIFEST_FILENAME;
  // The setup manifest goes last: it may only claim ownership of what is still on disk, so it follows the configs.
  const order = entries.map((_entry, index) => index).reverse();
  order.sort((left, right) => Number(isManifest(entries[left])) - Number(isManifest(entries[right])));
  for (const index of order) {
    const entry = entries[index];
    if (!entry || entry.item.state === "planned") continue;
    if (isManifest(entry)) {
      const configsDone = entries.every(
        (other, otherIndex) =>
          isManifest(other) ||
          other.item.state === "planned" ||
          statuses[otherIndex] === "restored" ||
          statuses[otherIndex] === "unchanged",
      );
      try {
        statuses[index] = restoreManifest(entry, entries, statuses, configsDone);
      } catch (error) {
        statuses[index] = error instanceof FingerprintMismatchError ? "manual-repair" : "failed";
        if (!(error instanceof FingerprintMismatchError)) errors.push(messageOf(error));
      }
      if (statuses[index] === "restored") afterRestore?.(entry.item, index);
      continue;
    }
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
        const manifestEntry = entries.find((other) => isManifest(other));
        const outcome = undoOwnedEntries(
          item,
          manifestEntry ? { path: manifestEntry.item.path, loadBefore: manifestEntry.loadBefore } : undefined,
        );
        if (outcome === "restored") {
          statuses[index] = "restored";
        } else {
          statuses[index] = "manual-repair";
          stopped = true;
        }
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
        // Changed between the check above and the restore: not ours any more.
        statuses[index] = "manual-repair";
        stopped = true;
      } else {
        statuses[index] = "failed";
        errors.push(messageOf(error));
      }
    }
    if (statuses[index] === "restored") afterRestore?.(entry.item, index);
  }
  return {
    statuses,
    errors,
    complete: statuses.every(
      (status) => status !== "manual-repair" && status !== "failed" && status !== "not-attempted",
    ),
  };
}

function restoreManifest(
  entry: CompensationEntry,
  entries: readonly CompensationEntry[],
  statuses: readonly AgentSetupCompensationStatus[],
  configsDone: boolean,
): AgentSetupCompensationStatus {
  const { item } = entry;
  const currentBytes = readCurrent(item.path);
  const current = fingerprintOf(currentBytes);
  if (current === item.beforeFingerprint) return "unchanged";
  const currentManifest = parseManifest(currentBytes);
  if (current !== item.afterFingerprint && (currentBytes === null || currentManifest.conflict)) return "manual-repair";
  const before = entry.loadBefore();
  if (configsDone) {
    if (before === null) removeAtomically(item.path, current);
    else writeAtomically(item.path, before, item.mode, current);
    return "restored";
  }
  const beforeManifest = parseManifest(before);
  if (currentManifest.conflict || beforeManifest.conflict) return "manual-repair";
  const location: AgentSetupLocation = {
    homeDirectory: dirname(item.path),
    codexHomeDirectory: currentManifest.manifest.codexHomeDirectory ?? beforeManifest.manifest.codexHomeDirectory,
    claudeConfigDirectory:
      currentManifest.manifest.claudeConfigDirectory ?? beforeManifest.manifest.claudeConfigDirectory,
  };
  const restoredPaths = new Set(
    entries.flatMap((other, index) =>
      other !== entry && (other.item.state === "planned" || ["restored", "unchanged"].includes(statuses[index] ?? ""))
        ? [comparablePath(other.item.path)]
        : [],
    ),
  );
  const ids = [
    ...new Set([...currentManifest.manifest.components, ...beforeManifest.manifest.components].map((c) => c.id)),
  ];
  const components = ids.flatMap((id) => {
    const source = restoredPaths.has(comparablePath(targetPath(id, location)))
      ? beforeManifest.manifest
      : currentManifest.manifest;
    const found = source.components.find((component) => component.id === id);
    return found ? [found] : [];
  });
  if (!components.length) {
    removeAtomically(item.path, current);
    return "not-attempted";
  }
  const next = Buffer.from(JSON.stringify({ ...currentManifest.manifest, components }, null, 2) + "\n", "utf8");
  if (fingerprintOf(next) !== current) writeAtomically(item.path, next, item.mode, current);
  return "not-attempted";
}

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

/**
 * A backup that existed before the operation is not ours, and a path that is not a setup backup name is never
 * followed: the journal is user-writable.
 */
function discardCommittedBackups(journal: AgentSetupJournal): void {
  for (const item of journal.items) {
    if (!item.backupPath || !item.backupCreated || !isBackupSibling(item.backupPath, item.path)) continue;
    try {
      rmSync(item.backupPath, { force: true });
    } catch {
      // A leftover backup is harmless; it is never read again.
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
  let previousCommitted: AgentSetupJournal | undefined;
  if (options.journalPath) {
    const previous = readAgentSetupJournal(options.journalPath);
    if (previous.status === "found" && previous.journal.state === "pending") return refuse("unfinished-journal");
    if (previous.status === "found" && previous.journal.state === "committed") previousCommitted = previous.journal;
    if (previous.status === "unreadable") {
      // An unreadable journal must not block every later apply; keep it for inspection instead of deleting it.
      const moved = moveAgentSetupJournalAside(options.journalPath);
      if (moved === null) return refuse("unfinished-journal");
      corruptJournalPath = moved;
    }
    // A plan with nothing to write must not replace the journal the last real operation can still be undone with.
    if (!plan.mutations.length) {
      return {
        result: finish({ operationId, outcome: "committed", items, journalPath: options.journalPath }),
        rollbackErrors: [],
      };
    }
    try {
      persist();
    } catch {
      return refuse("journal-write-failed");
    }
    // The previous operation's backups stay until this one commits: a rolled-back apply puts its journal back.
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
      if (fingerprintAt(mutation.path) !== mutation.beforeFingerprint) {
        entry.state = "planned";
        result.status = "externally-modified";
        result.code = "externally-modified";
        stopCode = "externally-modified";
        break;
      }
      code = "write-failed";
      ensureDirectory(dirname(mutation.path), createdDirectories);
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
      // The committed operation replaced the journal, so the previous one can no longer be undone.
      if (previousCommitted) discardCommittedBackups(previousCommitted);
      return {
        result: finish({ operationId, outcome: "committed", items, journalPath: options.journalPath }),
        rollbackErrors: [],
      };
    } catch (error) {
      // Without the commit mark a later recovery would undo a finished operation, so undo it now.
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
    if (report.complete && previousCommitted && options.journalPath) {
      // Nothing of this operation is left, so the previous committed operation can still be undone.
      (options.writeJournal ?? writeAgentSetupJournal)(options.journalPath, previousCommitted);
    } else persist();
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

function isBackupSibling(backupPath: string, path: string): boolean {
  const prefix = `${basename(path)}.work-intelligence.backup-`;
  const name = basename(backupPath);
  return (
    comparablePath(dirname(backupPath)) === comparablePath(dirname(path)) &&
    name.startsWith(prefix) &&
    /^\d{8}T\d{9}Z-[0-9a-f]{8}(?:-\d+)?$/.test(name.slice(prefix.length))
  );
}

// The journal is user-writable and recovery rewrites and deletes what it names, so only setup's own paths are followed.
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

// The journal goes back to `pending` before anything is touched, so a crash mid-undo is finished by recovery.
export function undoAgentSetupOperation(
  journalPath: string,
  location: AgentSetupRecoveryLocation,
  options: AgentSetupUndoOptions = {},
): AgentSetupUndoResult {
  const read = readAgentSetupJournal(journalPath);
  if (read.status === "none") return { status: "nothing-to-undo", items: [] };
  if (read.status === "unreadable") return { status: "refused", code: "journal-unreadable", items: [] };
  const { journal } = read;
  const items: AgentSetupItemResult[] = journal.items.map((item, index) => ({
    index,
    path: item.path,
    label: item.label,
    status: item.state === "planned" ? "skipped" : "written",
    verify: "not-run",
    compensation: "none",
  }));
  const base = { operationId: journal.operationId, items };
  if (journal.state === "pending") return { status: "refused", code: "unfinished-journal", ...base };
  if (journal.state === "compensated") return { status: "nothing-to-undo", ...base };
  if (!journalPathsAreOurs(journal, location)) return { status: "refused", code: "journal-paths-invalid", ...base };

  journal.state = "pending";
  try {
    writeAgentSetupJournal(journalPath, journal);
  } catch {
    return { status: "refused", code: "journal-write-failed", ...base };
  }
  const report = compensate(
    journal.items.map((item) => ({ item, loadBefore: () => loadFromBackup(item) })),
    options.afterRestore,
  );
  applyCompensation(items, report);
  if (report.complete) cleanUp(journal.items, journal.createdDirectories, []);
  journal.state = report.complete ? "compensated" : "needs-manual-repair";
  try {
    writeAgentSetupJournal(journalPath, journal);
  } catch {
    // The files are in their final state; a pending journal is re-checked and finished idempotently by recovery.
  }
  const repair = items.find((item) => item.compensation === "manual-repair");
  return {
    status: report.complete ? "undone" : "needs-manual-repair",
    ...base,
    ...(repair ? { manualRepairPath: repair.path } : {}),
  };
}

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
