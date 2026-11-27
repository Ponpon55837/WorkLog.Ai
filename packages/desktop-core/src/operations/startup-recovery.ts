import type { OperationRecord } from "./journal-record.js";
import { JournalStoreError } from "./journal-store.js";
import type { OperationJournal } from "./operation-journal.js";
import { describeRecovery } from "./recovery-notice.js";
import { recover, repairDecision, type ProbeReport, type RecoveryDecision } from "./recovery.js";

export type CopySettlement =
  | "removed"
  /** The settings name the copy: it is the database now and stays. */
  | "in-use"
  /** There was nothing to clean up. */
  | "absent"
  /** The path is not one the App may delete (outside its copy folder, not a plain file): nothing was touched. */
  | "refused";

export interface StartupRecoveryDeps {
  readonly journal: OperationJournal;
  readonly probe: (record: OperationRecord) => Promise<ProbeReport> | ProbeReport;
  readonly settleCopy: (copyPath: string, record: OperationRecord) => Promise<CopySettlement>;
  /** The settings exist but could not be read: state is unknown, so no record is closed and no orphan copy deleted. */
  readonly settingsUnreadable?: boolean;
  readonly log: (line: string) => void;
}

export interface StartupRecoveryResult {
  readonly closed: number;
  /** A record was closed as repair: the backend must not start by itself on data that could not be verified. */
  readonly holdStart: boolean;
  readonly journalProblem?: "newer-version" | "unreadable";
}

export const COPY_PATH_DETAIL = "copyPath";

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

async function recoverCopy(
  deps: StartupRecoveryDeps,
  record: OperationRecord,
  copyPath: string,
): Promise<{ decision: RecoveryDecision; removed: boolean }> {
  const settlement = await deps.settleCopy(copyPath, record).catch((): CopySettlement => "refused");
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

export async function runStartupRecovery(deps: StartupRecoveryDeps): Promise<StartupRecoveryResult> {
  let closed = 0;
  let holdStart = false;
  const seen = new Set<string>();
  for (;;) {
    let record: OperationRecord | null;
    try {
      record = await deps.journal.findInProgress();
    } catch (error) {
      deps.log(
        `[shell] recovery: the operations journal could not be read (${error instanceof Error ? error.name : "unknown error"})`,
      );
      // Fail closed: an interrupted operation may be in it, so the automatic start is held.
      return {
        closed,
        holdStart: true,
        journalProblem:
          error instanceof JournalStoreError && error.code === "newer-version" ? "newer-version" : "unreadable",
      };
    }
    if (record === null || seen.has(record.operationId)) break;
    if (deps.settingsUnreadable) {
      holdStart = true;
      deps.log(`[shell] recovery: ${record.kind} left open, the settings could not be read`);
      break;
    }
    seen.add(record.operationId);
    try {
      const outcome = await recoverOne(deps, record);
      closed += 1;
      if (outcome.decision.action === "repair") holdStart = true;
      deps.log(
        `[shell] recovery: ${record.kind} ${record.phase} -> ${outcome.decision.action} (${outcome.decision.reason})`,
      );
    } catch (error) {
      holdStart = true;
      deps.log(
        `[shell] recovery: could not close ${record.kind} (${error instanceof Error ? error.name : "unknown error"})`,
      );
    }
  }
  return { closed, holdStart };
}
