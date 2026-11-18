import type { OperationRecord } from "./journal-record.js";
import type { OperationJournal } from "./operation-journal.js";
import { describeRecovery } from "./recovery-notice.js";
import { recover, repairDecision, type ProbeReport, type RecoveryDecision } from "./recovery.js";

/** What became of the copy an interrupted "copy to the local disk" left behind. */
export type CopySettlement =
  /** The file was the App's own unused copy: it is gone. */
  | "removed"
  /** The settings name the copy: it is the database now and stays. */
  | "in-use"
  /** There was nothing to clean up. */
  | "absent"
  /** The path is not one the App may delete (outside its copy folder, not a plain file): nothing was touched. */
  | "refused";

export interface StartupRecoveryDeps {
  readonly journal: OperationJournal;
  /**
   * Reads the real state (OS service, child, settings, database) for one record. Called only for a record that is still
   * in progress; a throw is "state unknown" and ends in repair.
   */
  readonly probe: (record: OperationRecord) => Promise<ProbeReport> | ProbeReport;
  /** Deletes the orphan copy named by `copyPath` unless the settings use it; it checks the path itself. */
  readonly settleCopy: (copyPath: string) => Promise<CopySettlement>;
  readonly log: (line: string) => void;
}

export interface StartupRecoveryResult {
  /** Operations closed by this run. */
  readonly closed: number;
  /** At least one was closed as repair: the backend must not start by itself (it would touch data we could not verify). */
  readonly holdStart: boolean;
}

/** The journal key that marks the record of a copy to the local disk (its value is the copy's path). */
export const COPY_PATH_DETAIL = "copyPath";

/**
 * Nothing runs at start-up, so a decision that waits for a child (`resume`) cannot be carried out, and the App never
 * hands the old login service back by itself: both are repair. Everything else is applied as decided.
 */
function closable(record: OperationRecord, decision: RecoveryDecision): RecoveryDecision {
  const restore = decision.restore;
  const hasRestoreWork = restore !== null && (restore.register || restore.enable || restore.start);
  if (decision.action === "resume") {
    return repairDecision(record, decision.migrationStarted, "no child runs at start-up, so the run cannot be resumed");
  }
  if (decision.action === "restore-previous" && hasRestoreWork) {
    return repairDecision(record, false, "the previous service would have to be restarted, which the App never does");
  }
  return decision;
}

function copyPathOf(record: OperationRecord): string | null {
  const value = record.details?.[COPY_PATH_DETAIL];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The record of an interrupted copy: its only effect on disk is the copy file, so settling that closes it. */
async function recoverCopy(
  deps: StartupRecoveryDeps,
  record: OperationRecord,
  copyPath: string,
): Promise<{ decision: RecoveryDecision; removed: boolean }> {
  const settlement = await deps.settleCopy(copyPath).catch((): CopySettlement => "refused");
  deps.log(`[shell] recovery: interrupted copy to the local disk, ${settlement}`);
  const decision: RecoveryDecision = {
    nextState: record.phase,
    action: "none",
    recoveryPolicy: record.recoveryPolicy,
    migrationStarted: false,
    restore: null,
    reason: `the copy was left behind by an interruption (${settlement})`,
  };
  return { decision, removed: settlement === "removed" };
}

async function recoverOne(
  deps: StartupRecoveryDeps,
  record: OperationRecord,
): Promise<{ decision: RecoveryDecision; closed: boolean }> {
  const copyPath = copyPathOf(record);
  if (copyPath !== null) {
    const { decision, removed } = await recoverCopy(deps, record, copyPath);
    await deps.journal.applyRecovery(
      record.operationId,
      decision,
      removed ? { kind: "copy-removed", operation: record.kind, port: null, attemptedPort: null } : undefined,
    );
    return { decision, closed: true };
  }
  const probed: { report: ProbeReport | null } = { report: null };
  const decided = await recover(record, async () => {
    probed.report = await deps.probe(record);
    return probed.report;
  });
  const decision = closable(record, decided);
  const notice = describeRecovery(record, decision, probed.report);
  await deps.journal.applyRecovery(record.operationId, decision, notice ?? undefined);
  return { decision, closed: true };
}

/**
 * Closes every operation a crash left in progress, from the REAL state (never from the journal's phase text).
 *
 * Cost when nothing is in progress: one `findInProgress()`, which is the single read of the journal file the first start
 * would make anyway. The probe, the copy check and every write are skipped.
 */
export async function runStartupRecovery(deps: StartupRecoveryDeps): Promise<StartupRecoveryResult> {
  let closed = 0;
  let holdStart = false;
  const seen = new Set<string>();
  for (;;) {
    let record: OperationRecord | null;
    try {
      record = await deps.journal.findInProgress();
    } catch (error) {
      // An unreadable journal (not a corrupt one, which the store sets aside) stays unknown: the start's own journal
      // write reports it, and nothing is claimed here.
      deps.log(
        `[shell] recovery: the operations journal could not be read (${error instanceof Error ? error.name : "unknown error"})`,
      );
      break;
    }
    if (record === null || seen.has(record.operationId)) break;
    seen.add(record.operationId);
    try {
      const outcome = await recoverOne(deps, record);
      closed += 1;
      if (outcome.decision.action === "repair") holdStart = true;
      deps.log(
        `[shell] recovery: ${record.kind} ${record.phase} -> ${outcome.decision.action} (${outcome.decision.reason})`,
      );
    } catch (error) {
      // The record could not be closed: it stays in progress for the next start, and nothing starts on unverified state.
      holdStart = true;
      deps.log(
        `[shell] recovery: could not close ${record.kind} (${error instanceof Error ? error.name : "unknown error"})`,
      );
    }
  }
  return { closed, holdStart };
}
