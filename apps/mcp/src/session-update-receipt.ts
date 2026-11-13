import type { WorkIntelligenceStore } from "@work-intelligence/storage";

type MetadataResult = ReturnType<WorkIntelligenceStore["updateSessionMetadata"]>;
type SummaryResult = ReturnType<WorkIntelligenceStore["updateSessionSummary"]>;
type TitleResult = ReturnType<WorkIntelligenceStore["updateSessionTitle"]>;
type WorkSummaryResult = ReturnType<WorkIntelligenceStore["updateSessionWorkSummary"]>;
type WorkSessionRecord = Extract<MetadataResult, { outcome: "updated" }>["session"];
type WorkSummarySections = NonNullable<WorkSessionRecord["workSummary"]>;
type WorkSummarySectionName = keyof WorkSummarySections;

/** A submitted workSummary section: strings, or decision objects whose text is what storage keeps. */
type SubmittedSection = ReadonlyArray<string | { text: string }>;

/** The request fields a receipt compares with what was stored. */
interface MetadataReceiptRequest {
  changedFiles?: readonly string[];
}

interface SummaryReceiptRequest {
  summary: string;
}

interface TitleReceiptRequest {
  title: string;
}

interface WorkSummaryReceiptRequest {
  workSummary: Partial<Record<WorkSummarySectionName, SubmittedSection>>;
}

/** What the Agent learns about the Session it just updated: identity, times, status, and counts. */
export interface SessionUpdateReceiptSession {
  id: string;
  executionStatus: WorkSessionRecord["executionStatus"];
  startedAt?: string;
  completedAt: string;
  updatedAt: string;
  verificationStatus?: NonNullable<WorkSessionRecord["verification"]>["status"];
  changedFilesCount: number;
  voided?: WorkSessionRecord["voided"];
}

function receiptSession(session: WorkSessionRecord): SessionUpdateReceiptSession {
  return {
    id: session.id,
    executionStatus: session.executionStatus,
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    completedAt: session.completedAt,
    updatedAt: session.updatedAt,
    ...(session.verification ? { verificationStatus: session.verification.status } : {}),
    changedFilesCount: session.changedFiles.length,
    ...(session.voided ? { voided: session.voided } : {}),
  };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function redactionsIfAny<T extends { redactions?: { total: number } }>(result: T): Pick<T, "redactions"> | object {
  return result.redactions && result.redactions.total > 0 ? { redactions: result.redactions } : {};
}

/**
 * Receipts for the in-place Session updates follow the finalize receipt: the Session id, times, verification status
 * and changed-file count, plus only what the server changed or derived (a stored value that differs from the request,
 * redaction counts, warnings). They do not echo the Session body, the submitted text, or the previous text the Agent
 * read before correcting it. Other outcomes (skipped, not found, idempotency conflict) pass through unchanged, and so
 * does the storage result for every other caller.
 */
export function toSessionMetadataReceipt(input: MetadataReceiptRequest, result: MetadataResult): unknown {
  if (result.outcome !== "updated") return result;
  const { session, redactions: _redactions, outcome, ...warnings } = result;
  return {
    outcome,
    session: receiptSession(session),
    // A merge, normalization, or excluded path makes the stored list differ from the one sent.
    ...(input.changedFiles === undefined || sameList(input.changedFiles, session.changedFiles)
      ? {}
      : { changedFiles: session.changedFiles }),
    ...redactionsIfAny(result),
    ...warnings,
  };
}

export function toSessionSummaryReceipt(input: SummaryReceiptRequest, result: SummaryResult): unknown {
  if (result.outcome !== "summary_updated") return result;
  const storedAsSent =
    result.mode === "append" ? result.appliedSummary.endsWith(input.summary) : result.appliedSummary === input.summary;
  return {
    outcome: result.outcome,
    duplicate: result.duplicate,
    mode: result.mode,
    session: receiptSession(result.session),
    // The stored summary only when it is not what the Agent sent (masked, or a replayed earlier payload).
    ...(storedAsSent ? {} : { summary: result.appliedSummary }),
    ...redactionsIfAny(result),
  };
}

export function toSessionTitleReceipt(input: TitleReceiptRequest, result: TitleResult): unknown {
  if (result.outcome !== "title_updated") return result;
  return {
    outcome: result.outcome,
    duplicate: result.duplicate,
    previousTitle: result.previousTitle,
    session: receiptSession(result.session),
    ...(result.session.title === input.title ? {} : { title: result.session.title }),
    ...redactionsIfAny(result),
  };
}

export function toSessionWorkSummaryReceipt(input: WorkSummaryReceiptRequest, result: WorkSummaryResult): unknown {
  if (result.outcome !== "work_summary_updated") return result;
  const differing = Object.entries(input.workSummary).filter(([name, submitted]) => {
    const stored = result.appliedWorkSummary[name as WorkSummarySectionName];
    const sent = (submitted ?? []).map((item) => (typeof item === "string" ? item : item.text));
    return !sameList(sent, stored);
  });
  return {
    outcome: result.outcome,
    duplicate: result.duplicate,
    mode: result.mode,
    session: receiptSession(result.session),
    // Stored sections that differ from the submitted ones (masked text, or a replayed earlier payload).
    ...(differing.length > 0
      ? {
          workSummary: Object.fromEntries(
            differing.map(([name]) => [name, result.appliedWorkSummary[name as WorkSummarySectionName]]),
          ),
        }
      : {}),
    ...redactionsIfAny(result),
  };
}
