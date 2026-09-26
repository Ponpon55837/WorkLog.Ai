import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHANGED_FILE_SOURCES, NoopInsightProvider } from "@work-intelligence/core";
import type {
  AttachEvidenceInput,
  AttachEvidenceResult,
  ChangedFileChange,
  ChangedFileProvenance,
  ChangedFilesFollowUp,
  ChangedFileSource,
  ContextQueryResult,
  DecideKnowledgeCandidateInput,
  DecideKnowledgeCandidateResult,
  KnowledgeCandidateContextResult,
  KnowledgeCandidateInput,
  KnowledgeCandidateListResult,
  KnowledgeCandidateStatus,
  RequestKnowledgeCandidatesResult,
  SubmitKnowledgeCandidatesResult,
  KnowledgeReview,
  KnowledgeStaleness,
  LinkSessionsInput,
  LinkSessionsResult,
  SessionLinkRecord,
  SessionLinkRelation,
  SetEvidenceVoidInput,
  SetEvidenceVoidResult,
  SetSessionVoidInput,
  SetSessionVoidResult,
  SessionVoidedFilter,
  VoidAuditRecord,
  VerificationUpdateRecord,
  VerificationUpdateSource,
  VoidTargetType,
  RecallQueryResult,
  CancelMetadataBackfillRequestResult,
  CancelReportSynthesisRequestResult,
  CreateMetadataBackfillRequestInput,
  CreateMetadataBackfillRequestResult,
  DashboardSummary,
  EvidenceRecord,
  GraphQuery,
  GraphQueryResult,
  HandoffImportApplyInput,
  HandoffImportBatchResult,
  HandoffImportOptions,
  HandoffImportPreview,
  HandoffImportPreviewItem,
  HandoffImportPreviewResult,
  HandoffImportFailure,
  InsightProvider,
  KnowledgeAuditAction,
  KnowledgeAuditRecord,
  KnowledgeKind,
  KnowledgeHistoryQuery,
  KnowledgeHistoryResult,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeRecord,
  KnowledgeSkippedResult,
  KnowledgeStatus,
  MetadataBackfillApplyInput,
  MetadataBackfillBatchResult,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequestContextQuery,
  MetadataBackfillRequestContextQueryResult,
  MetadataBackfillRequestListQueryResult,
  MetadataBackfillRequestQuery,
  PolicyDecision,
  ProjectIdSkippedResult,
  FinalizeSessionInput,
  FinalizeSessionResult,
  GitSummary,
  ProjectRecord,
  ProjectStatus,
  RecordKnowledgeInput,
  RecordKnowledgeResult,
  ReportExportFormat,
  ReportExportResult,
  ReportPeriod,
  ReportEvidenceKind,
  ReportQueryResult,
  ReportSynthesisContextQuery,
  ReportSynthesisContextQueryResult,
  ReportSynthesisRequestQuery,
  ReportSynthesisRequestListQueryResult,
  RetryReportSynthesisRequestResult,
  ReportSummaryQuery,
  ReportSummaryQueryResult,
  DeleteReportSummaryResult,
  SaveReportSummaryInput,
  SaveReportSummaryResult,
  CreateReportSynthesisRequestInput,
  CreateReportSynthesisRequestResult,
  DeleteProjectResult,
  ProjectDeletionAuditRecord,
  ReportSynthesisRequestLookupResult,
  RawSnapshotRecord,
  SearchResult,
  SessionListResult,
  SessionDetail,
  SkippedResult,
  UpdateSessionMetadataInput,
  UpdateSessionMetadataResult,
  UpdateSessionSummaryInput,
  UpdateSessionSummaryResult,
  UpdateSessionWorkSummaryInput,
  UpdateSessionWorkSummaryResult,
  UpdateSessionVerificationResult,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult,
  VerificationFollowUp,
  VerificationSummary,
  WorkSummarySections,
  WorkSummaryFollowUp,
  WorkEventRecord,
  WorkEventType,
  WorkSessionRecord,
  DatabaseBackupDeleteResult,
  DatabaseBackupCreated,
  DatabaseBackupList,
  DatabaseBackupUnavailable,
  ProjectDataExport,
  ProjectDataExportScope,
  ProjectDataImportInput,
  ProjectDataImportPreview,
  ProjectDataImportResult,
  ProjectStatusResult,
  SessionDetailQueryResult,
  SessionListQueryResult,
  SessionNotFoundResult,
} from "@work-intelligence/core";
import { nowIso, truncateText } from "@work-intelligence/shared";
import { createProjectPathResolver, ProjectPolicyGate, safeProjectPath } from "@work-intelligence/project-policy";
import {
  backupDatabase,
  DEFAULT_AUTOMATIC_BACKUP_KEEP,
  DEFAULT_BACKUP_KEEP,
  deleteDatabaseBackup,
  defaultBackupDirectory,
  exportDatabase,
  isBackupDue,
  listDatabaseBackups,
  type BackupRetentionOptions,
} from "./backup.js";
import { HandoffImportService, type HandoffDiscoveryResult, type HandoffImportCandidate } from "./handoff-importer.js";
import { safeExistingProjectPath } from "./path-safety.js";
import {
  checkTrackedProjectById,
  checkTrackedProjectByRoot,
  skippedByProjectId,
  skippedByRoot,
} from "./policy-helper.js";
import { createPageInfo } from "./pagination.js";
import { GraphBuilder } from "./graph-builder.js";
import { KnowledgeRepository } from "./knowledge-repository.js";
import { ProjectRepository } from "./project-repository.js";
import { MetadataBackfillService } from "./metadata-backfill-service.js";
import { MetadataBackfillRepository } from "./metadata-backfill-repository.js";
import { ReportReadService } from "./report-service.js";
import { ReportSynthesisService } from "./report-synthesis-service.js";
import { ReportSynthesisRequestRepository } from "./report-synthesis-request-repository.js";
import { SessionRepository, type SessionListOptions, type SessionRow } from "./session-repository.js";
import { isChangedFilesMetadataConfirmed } from "./changed-files-confirmation.js";
import { initializeWorkIntelligenceDatabase } from "./database-initialization.js";
import { runImmediateTransaction as runImmediateSqlTransaction } from "./sqlite-transaction.js";
import { matchesAppliesTo, normalizePath } from "./search-text.js";
import { KnowledgeCandidateService } from "./knowledge-candidates.js";
import { SearchRepository } from "./search-repository.js";
import { ContextRecallService, type ContextFocus } from "./context-recall-service.js";
import { ProjectDataTransferService } from "./project-data-transfer.js";
import { ProjectDeletionService } from "./project-deletion-service.js";

export type { ContextFocus } from "./context-recall-service.js";

/** Optional Agent scope: a workspace root, a registry id, or both when they name the same project. */
export type TrackedScopeInput = { projectRoot?: string; projectId?: string };

type EventRow = {
  id: string;
  session_id: string;
  type: WorkEventType;
  summary: string;
  details_json: string | null;
  occurred_at: string;
};

type SnapshotRow = {
  id: string;
  session_id: string;
  project_id: string;
  kind: "handoff";
  source_path: string | null;
  content: string;
  captured_at: string;
};

type EvidenceRow = {
  id: string;
  session_id: string;
  project_id: string;
  kind: string;
  reference: string;
  summary: string | null;
  captured_at: string;
  voided_at?: string | null;
  void_reason?: string | null;
};

type KnowledgeRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  session_id: string | null;
  idempotency_key: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags_json: string;
  references_json: string;
  status: KnowledgeStatus;
  created_at: string;
  updated_at: string;
  applies_to_json?: string | null;
  last_confirmed_at?: string | null;
  last_confirmed_session_id?: string | null;
  supersedes_id?: string | null;
  review_json?: string | null;
};

type KnowledgeAuditRow = {
  id: string;
  knowledge_id: string;
  project_id: string;
  action: KnowledgeAuditAction;
  before_json: string | null;
  after_json: string;
  changed_fields_json: string;
  occurred_at: string;
};

type HandoffImportPlan = {
  project: ProjectRecord;
  discovery: HandoffDiscoveryResult;
  candidates: HandoffImportCandidate[];
  items: HandoffImportPreviewItem[];
  preview: HandoffImportPreview;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeWorkSummarySections(value: WorkSummarySections | undefined): WorkSummarySections | undefined {
  if (!value) {
    return undefined;
  }

  return {
    outcomes: value.outcomes.map((item) => item.trim()).filter(Boolean),
    scope: value.scope.map((item) => item.trim()).filter(Boolean),
    decisions: value.decisions.map((item) => item.trim()).filter(Boolean),
    verification: value.verification.map((item) => item.trim()).filter(Boolean),
    nextSteps: value.nextSteps.map((item) => item.trim()).filter(Boolean),
  };
}

function normalizeWorkSummaryPatch(
  value: WorkSummarySections | Partial<WorkSummarySections>,
): Partial<WorkSummarySections> {
  const normalized: Partial<WorkSummarySections> = {};
  const sectionKeys: Array<keyof WorkSummarySections> = ["outcomes", "scope", "decisions", "verification", "nextSteps"];
  for (const key of sectionKeys) {
    const section = value[key];
    if (Array.isArray(section)) {
      normalized[key] = section.map((item) => item.trim()).filter(Boolean);
    }
  }
  return normalized;
}

function completeWorkSummary(value: Partial<WorkSummarySections>): WorkSummarySections | undefined {
  if (
    !Array.isArray(value.outcomes) ||
    !Array.isArray(value.scope) ||
    !Array.isArray(value.decisions) ||
    !Array.isArray(value.verification) ||
    !Array.isArray(value.nextSteps)
  ) {
    return undefined;
  }
  return {
    outcomes: value.outcomes,
    scope: value.scope,
    decisions: value.decisions,
    verification: value.verification,
    nextSteps: value.nextSteps,
  };
}

function mergeWorkSummary(
  current: WorkSummarySections | undefined,
  patch: Partial<WorkSummarySections>,
): WorkSummarySections {
  return {
    outcomes: patch.outcomes ?? current?.outcomes ?? [],
    scope: patch.scope ?? current?.scope ?? [],
    decisions: patch.decisions ?? current?.decisions ?? [],
    verification: patch.verification ?? current?.verification ?? [],
    nextSteps: patch.nextSteps ?? current?.nextSteps ?? [],
  };
}

function parseWorkSummarySections(value: string | null): WorkSummarySections | undefined {
  const parsed = parseJson<Partial<WorkSummarySections>>(value, {});
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const sections: WorkSummarySections = {
    outcomes: Array.isArray(parsed.outcomes)
      ? parsed.outcomes.filter((item): item is string => typeof item === "string")
      : [],
    scope: Array.isArray(parsed.scope) ? parsed.scope.filter((item): item is string => typeof item === "string") : [],
    decisions: Array.isArray(parsed.decisions)
      ? parsed.decisions.filter((item): item is string => typeof item === "string")
      : [],
    verification: Array.isArray(parsed.verification)
      ? parsed.verification.filter((item): item is string => typeof item === "string")
      : [],
    nextSteps: Array.isArray(parsed.nextSteps)
      ? parsed.nextSteps.filter((item): item is string => typeof item === "string")
      : [],
  };

  const hasStructuredSections = ["outcomes", "scope", "decisions", "verification", "nextSteps"].some((key) =>
    Array.isArray(parsed[key as keyof WorkSummarySections]),
  );
  return hasStructuredSections ? sections : undefined;
}

function changedFileIdentity(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function sortChangedFileSources(sources: ChangedFileSource[]): ChangedFileSource[] {
  const order = new Map<ChangedFileSource, number>(CHANGED_FILE_SOURCES.map((source, index) => [source, index]));
  return [...new Set(sources)].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
}

function normalizeChangedFilePath(
  projectRoot: string,
  value: string,
  pathResolver = createProjectPathResolver(projectRoot),
): string {
  const candidate = value.trim();
  if (!candidate) {
    throw new Error("Changed file paths must not be empty.");
  }

  const absolutePath = pathResolver.safePath(candidate);
  if (!absolutePath) {
    throw new Error(`Changed file path must remain inside the tracked project root: ${candidate}`);
  }

  const normalized = relative(projectRoot, absolutePath).replaceAll("\\", "/");
  if (!normalized || normalized === ".") {
    throw new Error(`Changed file path must identify a file inside the tracked project root: ${candidate}`);
  }
  return normalized;
}

function normalizeChangedFileChanges(
  projectRoot: string,
  changes: ChangedFileChange[] | undefined,
  pathResolver = createProjectPathResolver(projectRoot),
): ChangedFileChange[] {
  const normalized: ChangedFileChange[] = [];
  const identities = new Set<string>();

  for (const change of changes ?? []) {
    if (change.status === "renamed" && !change.previousPath?.trim()) {
      throw new Error("A renamed file change must include previousPath.");
    }
    const path = normalizeChangedFilePath(projectRoot, change.path, pathResolver);
    const previousPath = change.previousPath
      ? normalizeChangedFilePath(projectRoot, change.previousPath, pathResolver)
      : undefined;
    const identity = [
      change.status,
      changedFileIdentity(path),
      previousPath ? changedFileIdentity(previousPath) : "",
    ].join(":");
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    normalized.push({
      path,
      status: change.status,
      ...(previousPath ? { previousPath } : {}),
    });
  }

  return normalized;
}

function changedFilePathsFromChanges(changes: ChangedFileChange[]): string[] {
  return changes.flatMap((change) => [change.path, ...(change.previousPath ? [change.previousPath] : [])]);
}

function mergeChangedFileChanges(
  projectRoot: string,
  current: WorkSessionRecord,
  incoming: ChangedFileChange[] | undefined,
  pathResolver = createProjectPathResolver(projectRoot),
): ChangedFileChange[] {
  const normalizedIncoming = normalizeChangedFileChanges(projectRoot, incoming, pathResolver);
  const merged: ChangedFileChange[] = [];
  const identities = new Set<string>();

  for (const change of [...current.changedFileChanges, ...normalizedIncoming]) {
    const identity = [
      change.status,
      changedFileIdentity(change.path),
      change.previousPath ? changedFileIdentity(change.previousPath) : "",
    ].join(":");
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    merged.push(change);
  }

  return merged;
}

function normalizeChangedFiles(
  projectRoot: string,
  changedFiles: string[] | undefined,
  provenance: ChangedFileProvenance[] | undefined,
  pathResolver = createProjectPathResolver(projectRoot),
): { files: string[]; provenance: ChangedFileProvenance[] } {
  const files: string[] = [];
  const fileByIdentity = new Map<string, string>();
  const provenanceByIdentity = new Map<string, { sources: ChangedFileSource[]; references: string[] }>();

  const addFile = (value: string): string => {
    const path = normalizeChangedFilePath(projectRoot, value, pathResolver);
    const identity = changedFileIdentity(path);
    const existing = fileByIdentity.get(identity);
    if (existing) {
      return existing;
    }
    fileByIdentity.set(identity, path);
    files.push(path);
    return path;
  };

  for (const file of changedFiles ?? []) {
    addFile(file);
  }

  for (const item of provenance ?? []) {
    const path = addFile(item.path);
    const identity = changedFileIdentity(path);
    const existing = provenanceByIdentity.get(identity);
    const sources: ChangedFileSource[] = item.sources.length > 0 ? item.sources : ["agent"];
    if (existing) {
      existing.sources = sortChangedFileSources([...existing.sources, ...sources]);
      existing.references.push(...(item.references ?? []));
    } else {
      provenanceByIdentity.set(identity, {
        sources: sortChangedFileSources(sources),
        references: [...(item.references ?? [])],
      });
    }
  }

  return {
    files,
    provenance: files.map((path) => {
      const record = provenanceByIdentity.get(changedFileIdentity(path));
      if (!record) {
        return { path, sources: ["agent"] };
      }
      const references = [...new Set(record.references)];
      return {
        path,
        sources: record.sources,
        ...(references.length > 0 ? { references } : {}),
      };
    }),
  };
}

function excludeBaselineChangedFiles(
  changedFiles: { files: string[]; provenance: ChangedFileProvenance[] },
  baselineIdentities: Set<string>,
): { files: string[]; provenance: ChangedFileProvenance[] } {
  if (baselineIdentities.size === 0) {
    return changedFiles;
  }

  return {
    files: changedFiles.files.filter((file) => !baselineIdentities.has(changedFileIdentity(file))),
    provenance: changedFiles.provenance.filter((entry) => !baselineIdentities.has(changedFileIdentity(entry.path))),
  };
}

function excludeBaselineChangedFileChanges(
  changes: ChangedFileChange[],
  baselineIdentities: Set<string>,
): ChangedFileChange[] {
  if (baselineIdentities.size === 0) {
    return changes;
  }

  return changes.flatMap((change) => {
    if (baselineIdentities.has(changedFileIdentity(change.path))) {
      return [];
    }
    if (
      change.status === "renamed" &&
      change.previousPath &&
      baselineIdentities.has(changedFileIdentity(change.previousPath))
    ) {
      return [{ path: change.path, status: "added" }];
    }
    return [change];
  });
}

function mergeChangedFiles(
  projectRoot: string,
  current: WorkSessionRecord,
  changedFiles: string[],
  provenance: ChangedFileProvenance[] | undefined,
  pathResolver = createProjectPathResolver(projectRoot),
): { files: string[]; provenance: ChangedFileProvenance[] } {
  const incoming = normalizeChangedFiles(projectRoot, changedFiles, provenance, pathResolver);
  const files: string[] = [];
  const fileByIdentity = new Map<string, string>();
  const provenanceByIdentity = new Map<string, { sources: ChangedFileSource[]; references: string[] }>();

  const addStoredFile = (value: string): string => {
    const identity = changedFileIdentity(value);
    const existing = fileByIdentity.get(identity);
    if (existing) {
      return existing;
    }
    fileByIdentity.set(identity, value);
    files.push(value);
    return value;
  };

  const addProvenance = (item: ChangedFileProvenance, normalizePath: boolean): void => {
    const path = normalizePath
      ? normalizeChangedFilePath(projectRoot, item.path, pathResolver)
      : addStoredFile(item.path);
    const identity = changedFileIdentity(path);
    const existing = provenanceByIdentity.get(identity);
    if (existing) {
      existing.sources = sortChangedFileSources([...existing.sources, ...item.sources]);
      existing.references.push(...(item.references ?? []));
      return;
    }
    provenanceByIdentity.set(identity, {
      sources: sortChangedFileSources(item.sources),
      references: [...(item.references ?? [])],
    });
  };

  for (const file of current.changedFiles) {
    addStoredFile(file);
  }
  for (const item of current.changedFilesProvenance) {
    addProvenance(item, false);
  }
  for (const file of incoming.files) {
    addStoredFile(file);
  }
  for (const item of incoming.provenance) {
    addProvenance(item, false);
  }

  return {
    files,
    // Legacy files without provenance intentionally remain without a fabricated source.
    provenance: files.flatMap((path) => {
      const record = provenanceByIdentity.get(changedFileIdentity(path));
      if (!record) {
        return [];
      }
      const references = [...new Set(record.references)];
      return [
        {
          path,
          sources: record.sources,
          ...(references.length > 0 ? { references } : {}),
        },
      ];
    }),
  };
}

function toSession(row: SessionRow): WorkSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    externalSessionId: row.external_session_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    title: row.title,
    summary: row.summary,
    workSummary: parseWorkSummarySections(row.work_summary_json),
    status: row.status,
    executionStatus: row.execution_status ?? "completed",
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    commitSha: row.commit_sha ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    changedFiles: parseJson<string[]>(row.changed_files_json, []),
    changedFilesProvenance: parseJson<ChangedFileProvenance[]>(row.changed_files_provenance_json, []),
    changedFileChanges: parseJson<ChangedFileChange[]>(row.changed_file_changes_json, []),
    verification: parseJson<VerificationSummary | undefined>(row.verification_json, undefined),
    ...(row.voided_at ? { voided: { at: row.voided_at, reason: row.void_reason ?? "" } } : {}),
  };
}

function toEvent(row: EventRow): WorkEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    summary: row.summary,
    details: parseJson<Record<string, unknown> | undefined>(row.details_json, undefined),
    occurredAt: row.occurred_at,
  };
}

function toSnapshot(row: SnapshotRow): RawSnapshotRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    kind: row.kind,
    sourcePath: row.source_path ?? undefined,
    content: row.content,
    capturedAt: row.captured_at,
  };
}

function toEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    kind: row.kind,
    reference: row.reference,
    summary: row.summary ?? undefined,
    capturedAt: row.captured_at,
    ...(row.voided_at ? { voided: { at: row.voided_at, reason: row.void_reason ?? "" } } : {}),
  };
}

type VoidAuditRow = {
  id: string;
  target_type: VoidTargetType;
  target_id: string;
  action: "voided" | "restored";
  reason: string | null;
  occurred_at: string;
};

function toVoidAudit(row: VoidAuditRow): VoidAuditRecord {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    action: row.action,
    ...(row.reason ? { reason: row.reason } : {}),
    occurredAt: row.occurred_at,
  };
}

type VerificationUpdateRow = {
  id: string;
  source: VerificationUpdateSource;
  previous_json: string | null;
  resulting_json: string;
  created_at: string;
};

function toVerificationUpdate(row: VerificationUpdateRow): VerificationUpdateRecord {
  const previous = parseJson<VerificationSummary | undefined>(row.previous_json, undefined);
  return {
    id: row.id,
    source: row.source,
    ...(previous ? { previous } : {}),
    resulting: parseJson<VerificationSummary>(row.resulting_json, { status: "not_run" }),
    createdAt: row.created_at,
  };
}

function normalizeVerification(verification: VerificationSummary): VerificationSummary {
  const summary = verification.summary?.trim();
  return { status: verification.status, ...(summary ? { summary } : {}) };
}

function sameVerification(left: VerificationSummary | undefined, right: VerificationSummary): boolean {
  return left?.status === right.status && (left.summary?.trim() || undefined) === right.summary;
}

/**
 * The reported start wins when it is not after completion; otherwise the earliest event recorded
 * before completion. No start is invented when neither exists.
 */
function resolveStartedAt(
  reported: string | undefined,
  events: ReadonlyArray<{ occurredAt?: string }> | undefined,
  completedAt: string,
): string | undefined {
  if (reported && reported <= completedAt) {
    return reported;
  }
  const earliest = (events ?? [])
    .map((event) => event.occurredAt)
    .filter((value): value is string => Boolean(value) && value! < completedAt)
    .sort()[0];
  return earliest;
}

/** Voiding needs a reason so the audit explains it; a restore reason is optional. */
function requireVoidReason(voided: boolean, reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  if (voided && !trimmed) {
    throw new Error("A reason is required to void a record.");
  }
  return trimmed || undefined;
}

function toKnowledge(row: KnowledgeRow): KnowledgeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    sessionId: row.session_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseJson<string[]>(row.tags_json, []),
    references: parseJson<string[]>(row.references_json, []),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliesTo: parseJson<string[]>(row.applies_to_json ?? null, []),
    ...(row.last_confirmed_at ? { lastConfirmedAt: row.last_confirmed_at } : {}),
    ...(row.last_confirmed_session_id ? { lastConfirmedSessionId: row.last_confirmed_session_id } : {}),
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
    ...(row.review_json
      ? { review: parseJson<KnowledgeReview>(row.review_json, { reason: "contradicted", at: "" }) }
      : {}),
  };
}

/** Audit snapshots written before appliesTo existed lack it; default it so readers can rely on it. */
function withKnowledgeDefaults(record: KnowledgeRecord): KnowledgeRecord {
  return { ...record, appliesTo: record.appliesTo ?? [] };
}

function cleanList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().replace(/\\/g, "/")).filter(Boolean))];
}

function toKnowledgeAudit(row: KnowledgeAuditRow): KnowledgeAuditRecord {
  const after = parseJson<KnowledgeRecord | undefined>(row.after_json, undefined);
  if (!after) {
    throw new Error(`Knowledge audit record ${row.id} has an invalid after snapshot.`);
  }

  const before = parseJson<KnowledgeRecord | undefined>(row.before_json, undefined);
  return {
    id: row.id,
    knowledgeId: row.knowledge_id,
    projectId: row.project_id,
    action: row.action,
    ...(before ? { before: withKnowledgeDefaults(before) } : {}),
    after: withKnowledgeDefaults(after),
    changedFields: parseJson<string[]>(row.changed_fields_json, []),
    occurredAt: row.occurred_at,
  };
}

function getVerificationFollowUp(session: WorkSessionRecord): VerificationFollowUp | undefined {
  if (session.verification?.status === "passed" || session.verification?.status === "failed") {
    return undefined;
  }
  const message =
    session.verification?.status === "not_run"
      ? "Verification is marked not_run. Re-check the completed work and call work_update_session_metadata with passed or failed when a confirmed result is available; keep not_run only when no verification was actually executed."
      : "Verification was not supplied. If verification was completed, call work_update_session_metadata with this sessionId and the confirmed result; otherwise explicitly report status not_run.";
  return {
    required: true,
    sessionId: session.id,
    message,
  };
}

function getChangedFilesFollowUp(session: WorkSessionRecord): ChangedFilesFollowUp | undefined {
  if (session.changedFiles.length > 0) {
    return undefined;
  }
  return {
    required: true,
    sessionId: session.id,
    message:
      "No changedFiles metadata was supplied. Inspect the working tree and worktree diff before finishing; call work_update_session_metadata with the confirmed file list, using [] only when the work intentionally changed no files.",
  };
}

function getWorkSummaryFollowUp(session: WorkSessionRecord): WorkSummaryFollowUp | undefined {
  if (session.workSummary) {
    return undefined;
  }
  return {
    required: true,
    sessionId: session.id,
    message:
      "Work summary sections were not supplied. Provide outcomes (confirmed results), scope (important changed areas), decisions (explicit choices only), verification (actual results and unverified coverage), and nextSteps (objective current open state/limitations only; no future recommendations) as concise arrays. Use [] when a section has no supported facts.",
  };
}

function handoffImportIdempotencyKey(projectId: string, sourcePath: string): string {
  const digest = createHash("sha256").update(`${projectId}\n${sourcePath}`).digest("hex");
  return `handoff-import:v1:${digest}`;
}

function normalizeHandoffSelectionPath(projectRoot: string, value: string): string {
  const absolutePath = safeProjectPath(projectRoot, value);
  if (!absolutePath) {
    throw new Error(`Handoff path must remain inside the tracked project root: ${value}`);
  }
  const normalized = relative(projectRoot, absolutePath).replaceAll("\\", "/");
  if (!normalized || normalized === ".") {
    throw new Error(`Handoff path must identify a file inside the tracked project root: ${value}`);
  }
  return normalized;
}

function toHandoffPreviewItem(
  candidate: HandoffImportCandidate,
  existingSession?: WorkSessionRecord,
): HandoffImportPreviewItem {
  if (existingSession) {
    return {
      sourcePath: candidate.sourcePath,
      title: candidate.title,
      summaryPreview: candidate.summary ? truncateText(candidate.summary, 360) : undefined,
      recordedDate: candidate.recordedDate,
      decision: "already_imported",
      reason: "already_imported",
      detail: "This handoff already has an idempotent imported Session.",
      verificationStatus: candidate.verification?.status,
      changedFiles: candidate.changedFiles,
      changedFilesStatus: candidate.changedFilesStatus,
      existingSessionId: existingSession.id,
    };
  }

  return {
    sourcePath: candidate.sourcePath,
    title: candidate.title,
    summaryPreview: candidate.summary ? truncateText(candidate.summary, 360) : undefined,
    recordedDate: candidate.recordedDate,
    decision: candidate.decision,
    reason: candidate.reason,
    detail: candidate.detail,
    verificationStatus: candidate.verification?.status,
    changedFiles: candidate.changedFiles,
    changedFilesStatus: candidate.changedFilesStatus,
  };
}

function countHandoffPreviewItems(items: HandoffImportPreviewItem[]): HandoffImportPreview["totals"] {
  return {
    discovered: items.length,
    eligible: items.filter((item) => item.decision === "eligible").length,
    excluded: items.filter((item) => item.decision === "excluded").length,
    alreadyImported: items.filter((item) => item.decision === "already_imported").length,
    errors: items.filter((item) => item.decision === "error").length,
  };
}

export interface WorkIntelligenceStoreOptions {
  insightProvider?: InsightProvider;
  /** Where backups go and how many manual and automatic copies to retain independently. */
  backup?: BackupRetentionOptions;
}

export class WorkIntelligenceStore {
  private readonly db: DatabaseSync;
  private readonly backupOptions: BackupRetentionOptions;
  private readonly projects: ProjectRepository;
  private readonly sessions: SessionRepository;
  private readonly knowledge: KnowledgeRepository;
  private readonly graphBuilder: GraphBuilder;
  private readonly handoffImportService = new HandoffImportService();
  private readonly projectDataTransfer: ProjectDataTransferService;
  private readonly reportReader: ReportReadService;
  private readonly reportSynthesis: ReportSynthesisService;
  private readonly metadataBackfillService: MetadataBackfillService;
  private readonly contextRecallService: ContextRecallService;
  private readonly searchIndex: SearchRepository;
  private readonly projectDeletionService: ProjectDeletionService;
  private readonly knowledgeCandidates: KnowledgeCandidateService;
  private readonly policyGate: ProjectPolicyGate;
  public readonly insightProvider: InsightProvider;

  public constructor(
    public readonly databasePath: string,
    options: WorkIntelligenceStoreOptions = {},
  ) {
    this.insightProvider = options.insightProvider ?? new NoopInsightProvider();
    this.backupOptions = options.backup ?? {};
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.db = new DatabaseSync(databasePath);
    try {
      initializeWorkIntelligenceDatabase(this.db, databasePath, this.backupOptions);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.projectDataTransfer = new ProjectDataTransferService(this.db);
    this.projects = new ProjectRepository(this.db);
    this.sessions = new SessionRepository(this.db, toSession, createPageInfo);
    this.reportReader = new ReportReadService(this.db, this);
    this.knowledge = new KnowledgeRepository(this.db, toKnowledge, createPageInfo, {
      listTrackedProjects: () => this.listProjects().filter((project) => project.status === "tracked"),
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      checkProjectById: (projectId) => this.checkProjectById(projectId),
    });
    this.graphBuilder = new GraphBuilder(this.db, {
      listProjects: () => this.listProjects(),
      getProjectById: (projectId) => this.getProjectById(projectId),
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      checkProjectById: (projectId) => this.checkProjectById(projectId),
      toSession,
      toKnowledge,
    });
    this.reportSynthesis = new ReportSynthesisService(
      this.db,
      {
        getProjectById: (projectId) => this.getProjectById(projectId),
        checkProjectById: (projectId) => this.checkProjectById(projectId),
        getReport: (options) => this.getReport(options),
      },
      new ReportSynthesisRequestRepository(this.db),
    );
    this.metadataBackfillService = new MetadataBackfillService(
      this.db,
      {
        checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
        checkProjectById: (projectId) => this.checkProjectById(projectId),
        getProjectById: (projectId) => this.getProjectById(projectId),
        updateSessionMetadata: (input) => this.updateSessionMetadata(input),
        toSession: (row) => toSession(row),
      },
      new MetadataBackfillRepository(this.db),
    );
    this.searchIndex = new SearchRepository(this.db);
    this.projectDeletionService = new ProjectDeletionService(
      this.db,
      this.databasePath,
      this.backupOptions,
      this.searchIndex,
    );
    this.knowledgeCandidates = new KnowledgeCandidateService(this.db, {
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      checkProjectById: (projectId) => this.checkProjectById(projectId),
      recordKnowledge: (input) => this.recordKnowledge(input),
    });
    this.policyGate = new ProjectPolicyGate(this);
    this.contextRecallService = new ContextRecallService(this.db, this.searchIndex, {
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      listProjects: () => this.listProjects(),
      listSessions: (sessionOptions) => this.listSessions(sessionOptions),
      getSessionById: (sessionId) => this.getSessionById(sessionId),
      getProjectById: (projectId) => this.getProjectById(projectId),
      getSessionLinks: (sessionId) => this.getSessionLinks(sessionId),
      getKnowledgeWithTrust: (knowledgeId) => {
        const row = this.db
          .prepare("SELECT k.*, NULL AS project_name FROM knowledge k WHERE k.id = ?")
          .get(knowledgeId) as KnowledgeRow | undefined;
        return row ? this.withKnowledgeTrust(toKnowledge(row)) : undefined;
      },
      searchKnowledge: (query) => this.searchKnowledge(query),
      listReportSynthesisRequests: (query) => this.listReportSynthesisRequests(query),
      listMetadataBackfillRequests: (query) => this.listMetadataBackfillRequests(query),
      previewMetadataBackfill: (previewOptions) => this.previewMetadataBackfill(previewOptions),
      openKnowledgeCandidateRequests: (projectId) => this.knowledgeCandidates.openRequests(projectId),
    });
  }

  private checkProjectRoot(projectRoot: string): PolicyDecision {
    return checkTrackedProjectByRoot(this.policyGate, projectRoot);
  }

  private checkProjectById(projectId: string): PolicyDecision {
    return checkTrackedProjectById(this.policyGate, this, projectId);
  }

  /** Returns a lightweight token for writes made by this connection and other SQLite connections. */
  public getChangeToken(): string {
    const dataVersion = this.db.prepare("PRAGMA data_version").get() as { data_version?: number } | undefined;
    const localChanges = this.db.prepare("SELECT total_changes() AS total_changes").get() as
      { total_changes?: number } | undefined;
    return `${dataVersion?.data_version ?? 0}:${localChanges?.total_changes ?? 0}`;
  }

  public close(): void {
    this.db.close();
  }

  private backupUnavailable(): DatabaseBackupUnavailable | null {
    return this.databasePath === ":memory:"
      ? { outcome: "backup_unavailable", reason: "An in-memory database cannot be backed up." }
      : null;
  }

  /** Writes a checked snapshot of the whole database and prunes old ones. */
  public createBackup(): DatabaseBackupCreated | DatabaseBackupUnavailable {
    return this.backupUnavailable() ?? backupDatabase(this.db, this.databasePath, this.backupOptions);
  }

  public listBackups(): DatabaseBackupList | DatabaseBackupUnavailable {
    const unavailable = this.backupUnavailable();
    if (unavailable) {
      return unavailable;
    }
    const directory = this.backupOptions.directory ?? defaultBackupDirectory(this.databasePath);
    return {
      outcome: "database_backups",
      keep: this.backupOptions.keep ?? DEFAULT_BACKUP_KEEP,
      automaticKeep: this.backupOptions.automaticKeep ?? DEFAULT_AUTOMATIC_BACKUP_KEEP,
      backups: listDatabaseBackups(this.databasePath, directory),
    };
  }

  /** Removes a single recognized snapshot without accepting arbitrary filesystem paths. */
  public deleteBackup(fileName: string): DatabaseBackupDeleteResult {
    return this.backupUnavailable() ?? deleteDatabaseBackup(this.databasePath, fileName, this.backupOptions);
  }

  /** Writes the whole database to `target` for moving it to another computer; `target` must not exist yet. */
  public exportTo(target: string): { bytes: number } {
    if (this.backupUnavailable()) {
      throw new Error("An in-memory database cannot be exported.");
    }
    return exportDatabase(this.db, target);
  }

  /** Exports portable data for every project or one selected project. */
  public exportProjectData(scope: ProjectDataExportScope): ProjectDataExport {
    return this.projectDataTransfer.export(scope);
  }

  /** Counts additions, duplicates, and conflicts without writing imported data. */
  public previewProjectDataImport(input: ProjectDataImportInput): ProjectDataImportPreview {
    return this.projectDataTransfer.preview(input);
  }

  /** Merges portable project data inside one transaction while this store remains open. */
  public importProjectData(input: ProjectDataImportInput): ProjectDataImportResult {
    return this.projectDataTransfer.import(input);
  }

  /** Writes one automatic backup per local calendar day, independently of manual backups. */
  public backupIfDue(now = new Date()): DatabaseBackupCreated | null {
    if (this.backupUnavailable() || !isBackupDue(this.databasePath, this.backupOptions.directory, now)) {
      return null;
    }
    return backupDatabase(this.db, this.databasePath, { ...this.backupOptions, kind: "automatic", now });
  }

  public getProjectByRootPath(rootPath: string): ProjectRecord | undefined {
    return this.projects.getByRootPath(rootPath);
  }

  public getProjectById(projectId: string): ProjectRecord | undefined {
    return this.projects.getById(projectId);
  }

  public listProjects(): ProjectRecord[] {
    return this.projects.list();
  }

  public addProject(name: string, rootPath: string): ProjectRecord {
    return this.projects.add(name, rootPath);
  }

  public updateProject(
    projectId: string,
    update: { name?: string; status?: ProjectStatus },
  ): ProjectRecord | undefined {
    return this.projects.update(projectId, update);
  }

  /** Deletes a project and its local data after a checked full-database safety snapshot. */
  public deleteProject(projectId: string, confirmationName: string): DeleteProjectResult {
    return this.projectDeletionService.deleteProject(projectId, confirmationName);
  }

  public listProjectDeletionAudits(): ProjectDeletionAuditRecord[] {
    return this.projectDeletionService.listProjectDeletionAudits();
  }

  public previewMetadataBackfill(
    options: {
      projectRoot?: string;
      limit?: number;
    } = {},
  ): MetadataBackfillPreviewResult {
    return this.metadataBackfillService.previewMetadataBackfill(options);
  }

  public createMetadataBackfillRequest(input: CreateMetadataBackfillRequestInput): CreateMetadataBackfillRequestResult {
    return this.metadataBackfillService.createMetadataBackfillRequest(input);
  }

  public listMetadataBackfillRequests(
    options: MetadataBackfillRequestQuery = {},
  ): MetadataBackfillRequestListQueryResult {
    return this.metadataBackfillService.listMetadataBackfillRequests(options);
  }

  public cancelMetadataBackfillRequest(requestId: string): CancelMetadataBackfillRequestResult {
    return this.metadataBackfillService.cancelMetadataBackfillRequest(requestId);
  }

  public getMetadataBackfillContext(
    options: MetadataBackfillRequestContextQuery,
  ): MetadataBackfillRequestContextQueryResult {
    return this.metadataBackfillService.getMetadataBackfillContext(options);
  }

  public applyMetadataBackfill(input: MetadataBackfillApplyInput): MetadataBackfillBatchResult {
    return this.metadataBackfillService.applyMetadataBackfill(input);
  }

  private buildHandoffImportPlan(options: HandoffImportOptions): HandoffImportPlan | SkippedResult {
    const decision = this.checkProjectRoot(options.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const discovery = this.handoffImportService.discover(project.rootPath, {
      handoffDirectory: options.handoffDirectory,
      excludePaths: options.excludePaths,
      maxFiles: options.maxFiles,
    });
    const items = discovery.candidates.map((candidate) => {
      const existing =
        candidate.decision === "eligible"
          ? this.getSessionByIdempotencyKey(handoffImportIdempotencyKey(project.id, candidate.sourcePath))
          : undefined;
      return toHandoffPreviewItem(candidate, existing);
    });
    const preview: HandoffImportPreview = {
      outcome: "preview",
      project,
      projectStatus: "tracked",
      handoffDirectory: discovery.handoffDirectory,
      directoryFound: discovery.directoryFound,
      truncated: discovery.truncated,
      items,
      totals: countHandoffPreviewItems(items),
    };
    return { project, discovery, candidates: discovery.candidates, items, preview };
  }

  public previewHandoffImport(options: HandoffImportOptions): HandoffImportPreviewResult {
    const plan = this.buildHandoffImportPlan(options);
    return "preview" in plan ? plan.preview : plan;
  }

  public importHandoffs(input: HandoffImportApplyInput): HandoffImportBatchResult {
    const plan = this.buildHandoffImportPlan(input);
    if (!("preview" in plan)) {
      return plan;
    }

    const candidateByPath = new Map(
      plan.candidates.map((candidate) => [changedFileIdentity(candidate.sourcePath), candidate]),
    );
    const itemByPath = new Map(plan.items.map((item) => [changedFileIdentity(item.sourcePath), item]));
    const selectedPaths = new Set<string>();
    const failures: HandoffImportFailure[] = [];
    for (const sourcePath of input.sourcePaths) {
      try {
        const normalized = normalizeHandoffSelectionPath(plan.project.rootPath, sourcePath);
        selectedPaths.add(changedFileIdentity(normalized));
      } catch (error) {
        failures.push({
          sourcePath,
          reason: "invalid_path",
          detail: error instanceof Error ? error.message : "The selected handoff path is invalid.",
        });
      }
    }

    const imported: WorkSessionRecord[] = [];
    const skipped: HandoffImportPreviewItem[] = [];
    for (const selectedPath of selectedPaths) {
      const candidate = candidateByPath.get(selectedPath);
      const item = itemByPath.get(selectedPath);
      if (!candidate || !item) {
        failures.push({
          sourcePath: selectedPath,
          reason: "source_not_found",
          detail: "The selected handoff was not found in the preview result.",
        });
        continue;
      }
      if (item.decision !== "eligible") {
        skipped.push(item);
        continue;
      }

      try {
        const result = this.finalizeSession({
          projectRoot: plan.project.rootPath,
          idempotencyKey: handoffImportIdempotencyKey(plan.project.id, candidate.sourcePath),
          externalSessionId: `handoff:${candidate.sourcePath}`.slice(0, 300),
          title: candidate.title,
          summary: candidate.summary,
          handoffPath: candidate.sourcePath,
          handoffContent: candidate.content,
          completedAt: candidate.completedAt,
          changedFiles: candidate.changedFiles.length > 0 ? candidate.changedFiles : undefined,
          changedFilesProvenance:
            candidate.changedFiles.length > 0
              ? candidate.changedFiles.map((path) => ({
                  path,
                  sources: ["handoff" as const],
                  references: [candidate.sourcePath],
                }))
              : undefined,
          verification: candidate.verification,
          events: [
            {
              type: "closing",
              summary: `Historical handoff imported from ${candidate.sourcePath}.`,
              details: { source: "handoff-import", sourcePath: candidate.sourcePath },
            },
          ],
        });
        if (result.outcome !== "finalized") {
          failures.push({
            sourcePath: candidate.sourcePath,
            reason: "import_failed",
            detail: result.reason,
          });
        } else if (result.duplicate) {
          skipped.push({
            ...item,
            decision: "already_imported",
            reason: "already_imported",
            existingSessionId: result.session.id,
            detail: "This handoff was imported by another retry while the batch was running.",
          });
        } else {
          imported.push(result.session);
        }
      } catch (error) {
        failures.push({
          sourcePath: candidate.sourcePath,
          reason: "import_failed",
          detail: error instanceof Error ? error.message : "The handoff could not be imported.",
        });
      }
    }

    return {
      outcome: "imported",
      project: plan.project,
      selectedCount: input.sourcePaths.length,
      imported,
      skipped,
      failures,
    };
  }

  public getDashboardSummary(): DashboardSummary {
    const trackedProjects = this.db
      .prepare("SELECT COUNT(*) AS count FROM projects WHERE status = 'tracked'")
      .get() as { count: number };
    const activeProjects = trackedProjects;
    // Only tracked projects are shown: history of paused/ignored projects stays in SQLite but is hidden.
    const finalizedSessions = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.status = 'tracked' AND s.voided_at IS NULL",
      )
      .get() as { count: number };
    const recordedEvents = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM work_events e
         JOIN sessions s ON s.id = e.session_id
         JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked' AND s.voided_at IS NULL`,
      )
      .get() as { count: number };

    return {
      trackedProjects: trackedProjects.count,
      activeProjects: activeProjects.count,
      finalizedSessions: finalizedSessions.count,
      recordedEvents: recordedEvents.count,
      recentSessions: this.listSessions({ limit: 6, trackedOnly: true }),
    };
  }

  public getReport(options: {
    period: ReportPeriod;
    date?: string;
    /** An explicit calendar range (both or neither); the report's period is then "custom". */
    from?: string;
    to?: string;
    projectId?: string;
    evidencePage?: number;
    evidencePageSize?: number;
    evidenceKind?: ReportEvidenceKind;
    evidenceQuery?: string;
    includeAllEvidence?: boolean;
  }): ReportQueryResult {
    return this.reportReader.getReport(options);
  }

  public exportReport(options: {
    period: ReportPeriod;
    date?: string;
    from?: string;
    to?: string;
    projectId?: string;
    format: ReportExportFormat;
    evidencePage?: number;
    evidencePageSize?: number;
    evidenceKind?: ReportEvidenceKind;
    evidenceQuery?: string;
  }): ReportExportResult {
    return this.reportReader.exportReport(options);
  }

  public createReportSynthesisRequest(input: CreateReportSynthesisRequestInput): CreateReportSynthesisRequestResult {
    return this.reportSynthesis.createReportSynthesisRequest(input);
  }

  public listReportSynthesisRequests(options: ReportSynthesisRequestQuery = {}): ReportSynthesisRequestListQueryResult {
    return this.reportSynthesis.listReportSynthesisRequests(options);
  }

  public getReportSynthesisRequest(requestId: string): ReportSynthesisRequestLookupResult {
    return this.reportSynthesis.getReportSynthesisRequest(requestId);
  }

  public retryReportSynthesisRequest(requestId: string): RetryReportSynthesisRequestResult {
    return this.reportSynthesis.retryReportSynthesisRequest(requestId);
  }

  public cancelReportSynthesisRequest(requestId: string): CancelReportSynthesisRequestResult {
    return this.reportSynthesis.cancelReportSynthesisRequest(requestId);
  }

  public getReportSynthesisContext(options: ReportSynthesisContextQuery): ReportSynthesisContextQueryResult {
    return this.reportSynthesis.getReportSynthesisContext(options);
  }

  public saveReportSummary(input: SaveReportSummaryInput): SaveReportSummaryResult {
    return this.reportSynthesis.saveReportSummary(input);
  }

  public listReportSummaries(options: ReportSummaryQuery = {}): ReportSummaryQueryResult {
    return this.reportSynthesis.listReportSummaries(options);
  }

  public deleteReportSummary(summaryId: string): DeleteReportSummaryResult {
    return this.reportSynthesis.deleteReportSummary(summaryId);
  }

  public listSessions(options: SessionListOptions = {}): WorkSessionRecord[] {
    return this.sessions.list(options);
  }

  public listSessionsPage(options: SessionListOptions = {}): SessionListResult {
    return this.sessions.listPage(options);
  }

  public getSessionByIdempotencyKey(idempotencyKey: string): WorkSessionRecord | undefined {
    return this.sessions.getByIdempotencyKey(idempotencyKey);
  }

  public getSessionById(sessionId: string): WorkSessionRecord | undefined {
    return this.sessions.getById(sessionId);
  }

  /** Corrects a Session's verification in place; every change is kept in the verification audit. */
  public updateSessionVerification(
    sessionId: string,
    verification: VerificationSummary,
    source: VerificationUpdateSource = "agent",
  ): UpdateSessionVerificationResult {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId };
    }

    const decision = this.checkProjectById(row.project_id);
    if (!decision?.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId,
        projectStatus: decision?.projectStatus ?? "unregistered",
        reason: decision?.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const previous = parseJson<VerificationSummary | undefined>(row.verification_json, undefined);
    const next = normalizeVerification(verification);
    const unchanged = sameVerification(previous, next);
    if (!unchanged) {
      const updatedAt = nowIso();
      runImmediateSqlTransaction(this.db, () => {
        this.db.prepare("UPDATE sessions SET verification_json = ? WHERE id = ?").run(JSON.stringify(next), sessionId);
        this.touchSession(sessionId, updatedAt);
        this.insertVerificationUpdate(sessionId, source, previous, next, updatedAt);
        this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, project.id);
      });
    }

    const session = this.getSessionById(sessionId);
    if (!session) {
      throw new Error("Session verification was updated but could not be loaded.");
    }
    return { outcome: "updated", session, previous, ...(unchanged ? { unchanged } : {}) };
  }

  /**
   * Records what a finalized Session reported about Knowledge it used: applied items are confirmed as
   * of this Session (and leave review), contradicted items are flagged for review. Runs inside finalize.
   */
  private applyKnowledgeFeedback(
    projectId: string,
    sessionId: string,
    completedAt: string,
    input: Pick<FinalizeSessionInput, "appliedKnowledgeIds" | "contradictedKnowledgeIds">,
  ): string[] {
    const warnings: string[] = [];
    const contradicted = new Set(input.contradictedKnowledgeIds ?? []);
    const feedback = [
      ...[...new Set(input.appliedKnowledgeIds ?? [])]
        .filter((id) => {
          if (contradicted.has(id)) {
            warnings.push(`${id}: listed as both applied and contradicted; kept as contradicted.`);
            return false;
          }
          return true;
        })
        .map((id) => ({ id, applied: true })),
      ...[...contradicted].map((id) => ({ id, applied: false })),
    ];
    for (const { id, applied } of feedback) {
      const row = this.db
        .prepare(
          `SELECT k.*, p.name AS project_name FROM knowledge k JOIN projects p ON p.id = k.project_id
           WHERE k.id = ? AND k.project_id = ?`,
        )
        .get(id, projectId) as KnowledgeRow | undefined;
      if (!row) {
        warnings.push(`${id}: Knowledge was not found in this project.`);
        continue;
      }
      const before = toKnowledge(row);
      const after: KnowledgeRecord = applied
        ? { ...before, lastConfirmedAt: completedAt, lastConfirmedSessionId: sessionId }
        : { ...before, review: { reason: "contradicted", sessionId, at: completedAt } };
      if (applied) {
        delete after.review;
      }
      this.db
        .prepare(
          "UPDATE knowledge SET last_confirmed_at = ?, last_confirmed_session_id = ?, review_json = ? WHERE id = ?",
        )
        .run(
          after.lastConfirmedAt ?? null,
          after.lastConfirmedSessionId ?? null,
          after.review ? JSON.stringify(after.review) : null,
          id,
        );
      this.insertKnowledgeAudit({
        knowledge: after,
        before,
        action: "updated",
        changedFields: applied ? ["lastConfirmedAt", ...(before.review ? ["review"] : [])] : ["review"],
        occurredAt: completedAt,
      });
    }
    return warnings;
  }

  /** Adds the computed possiblyStale marker (see KnowledgeRecord.possiblyStale). */
  private withKnowledgeTrust(knowledge: KnowledgeRecord): KnowledgeRecord {
    const staleness = this.knowledgeStaleness(knowledge);
    return staleness ? { ...knowledge, possiblyStale: staleness } : knowledge;
  }

  private knowledgeStaleness(knowledge: KnowledgeRecord): KnowledgeStaleness | undefined {
    if (knowledge.appliesTo.length === 0) {
      return undefined;
    }
    const project = this.getProjectById(knowledge.projectId);
    const contexts = project ? [{ name: project.name, rootPath: project.rootPath }] : [];
    const patterns = knowledge.appliesTo.map((pattern) => normalizePath(pattern, contexts)).filter(Boolean);
    const excluded = new Set([knowledge.sessionId, knowledge.lastConfirmedSessionId].filter(Boolean));
    const rows = this.db
      .prepare(
        `SELECT id, title, completed_at, changed_files_json FROM sessions
         WHERE project_id = ? AND voided_at IS NULL AND completed_at > ?
         ORDER BY completed_at ASC, id ASC`,
      )
      .all(knowledge.projectId, knowledge.lastConfirmedAt ?? knowledge.createdAt) as Array<{
      id: string;
      title: string;
      completed_at: string;
      changed_files_json: string;
    }>;
    let first: KnowledgeStaleness | undefined;
    let sessionCount = 0;
    for (const row of rows) {
      if (excluded.has(row.id)) {
        continue;
      }
      const paths = parseJson<string[]>(row.changed_files_json, []).filter((file) => {
        const normalized = normalizePath(file, contexts);
        return patterns.some((pattern) => matchesAppliesTo(normalized, pattern));
      });
      if (paths.length === 0) {
        continue;
      }
      sessionCount += 1;
      first ??= {
        sessionId: row.id,
        sessionTitle: row.title,
        completedAt: row.completed_at,
        paths: paths.slice(0, 5),
        sessionCount: 0,
      };
    }
    return first ? { ...first, sessionCount } : undefined;
  }

  /** Opens a request for an Agent to propose Knowledge from the project's not-yet-reviewed Sessions. */
  public requestKnowledgeCandidates(projectRoot: string): RequestKnowledgeCandidatesResult {
    return this.knowledgeCandidates.request(projectRoot);
  }

  public getKnowledgeCandidateContext(input: {
    requestId?: string;
    projectRoot?: string;
  }): KnowledgeCandidateContextResult {
    return this.knowledgeCandidates.context(input);
  }

  public submitKnowledgeCandidates(input: {
    requestId: string;
    candidates: KnowledgeCandidateInput[];
  }): SubmitKnowledgeCandidatesResult {
    return this.knowledgeCandidates.submit(input);
  }

  public listKnowledgeCandidates(
    input: { projectRoot?: string; status?: KnowledgeCandidateStatus } = {},
  ): KnowledgeCandidateListResult {
    return this.knowledgeCandidates.list(input);
  }

  public decideKnowledgeCandidate(input: DecideKnowledgeCandidateInput): DecideKnowledgeCandidateResult {
    return this.knowledgeCandidates.decide(input);
  }

  /** Links or unlinks two Sessions; a pair has at most one link, so a new relation replaces the old one. */
  public linkSessions(input: LinkSessionsInput, source: VerificationUpdateSource = "agent"): LinkSessionsResult {
    const row = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(input.sessionId) as
      { project_id: string } | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }
    const decision = this.checkProjectById(row.project_id);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }
    const problem = this.linkProblem(input.sessionId, input.relatedSessionId);
    if (problem) {
      return { outcome: "invalid_link", sessionId: input.sessionId, reason: problem };
    }
    return runImmediateSqlTransaction(this.db, () => {
      const existing = this.db
        .prepare(
          `SELECT session_id, related_session_id, relation FROM session_links
           WHERE (session_id = ? AND related_session_id = ?) OR (session_id = ? AND related_session_id = ?)`,
        )
        .get(input.sessionId, input.relatedSessionId, input.relatedSessionId, input.sessionId) as
        { session_id: string; related_session_id: string; relation: SessionLinkRelation } | undefined;
      const same =
        existing?.session_id === input.sessionId &&
        existing.related_session_id === input.relatedSessionId &&
        existing.relation === input.relation;
      const duplicate = input.linked ? same : !existing;
      if (!duplicate) {
        this.db
          .prepare(
            `DELETE FROM session_links
             WHERE (session_id = ? AND related_session_id = ?) OR (session_id = ? AND related_session_id = ?)`,
          )
          .run(input.sessionId, input.relatedSessionId, input.relatedSessionId, input.sessionId);
        const changedAt = nowIso();
        if (input.linked) {
          this.writeSessionLink(input.sessionId, input.relatedSessionId, input.relation, source, changedAt);
        }
        this.touchSession(input.sessionId, changedAt);
        this.touchSession(input.relatedSessionId, changedAt);
      }
      return {
        outcome: "session_link_updated",
        duplicate,
        sessionId: input.sessionId,
        links: this.getSessionLinks(input.sessionId),
      };
    });
  }

  /** Both Sessions must exist in tracked projects and differ; returns why a link is not allowed. */
  private linkProblem(sessionId: string, relatedSessionId: string): string | undefined {
    if (sessionId === relatedSessionId) {
      return "A Session cannot be linked to itself.";
    }
    const related = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(relatedSessionId) as
      { project_id: string } | undefined;
    if (!related) {
      return "The related Session does not exist.";
    }
    if (!this.checkProjectById(related.project_id).allowed) {
      return "The related Session belongs to a project that is not tracked.";
    }
    return undefined;
  }

  private writeSessionLink(
    sessionId: string,
    relatedSessionId: string,
    relation: SessionLinkRelation,
    source: VerificationUpdateSource,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_links (id, session_id, related_session_id, relation, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), sessionId, relatedSessionId, relation, source, createdAt);
  }

  /** Links of one Session as seen from it, limited to tracked projects, oldest linked Session first. */
  private getSessionLinks(sessionId: string): SessionLinkRecord[] {
    const rows = this.db
      .prepare(
        `SELECT l.session_id, l.relation, s.id AS other_id, s.title, s.completed_at, s.voided_at, p.name AS project_name
         FROM session_links l
         JOIN sessions s ON s.id = CASE WHEN l.session_id = ? THEN l.related_session_id ELSE l.session_id END
         JOIN projects p ON p.id = s.project_id
         WHERE (l.session_id = ? OR l.related_session_id = ?) AND p.status = 'tracked'
         ORDER BY s.completed_at ASC, s.id ASC`,
      )
      .all(sessionId, sessionId, sessionId) as Array<{
      session_id: string;
      relation: SessionLinkRelation;
      other_id: string;
      title: string;
      completed_at: string;
      voided_at: string | null;
      project_name: string | null;
    }>;
    return rows.map((row) => ({
      sessionId: row.other_id,
      title: row.title,
      ...(row.project_name ? { projectName: row.project_name } : {}),
      completedAt: row.completed_at,
      relation: row.relation === "related" ? "related" : row.session_id === sessionId ? "continues" : "continued_by",
      ...(row.voided_at ? { voided: true } : {}),
    }));
  }

  private touchSession(sessionId: string, at: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, sessionId);
  }

  private hasConfirmedChangedFilesForSession(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT changed_files_json, changed_files_confirmed FROM sessions WHERE id = ?")
      .get(sessionId) as { changed_files_json: string | null; changed_files_confirmed?: number } | undefined;
    return row ? isChangedFilesMetadataConfirmed(row.changed_files_json, row.changed_files_confirmed) : false;
  }

  private insertVerificationUpdate(
    sessionId: string,
    source: VerificationUpdateSource,
    previous: VerificationSummary | undefined,
    resulting: VerificationSummary,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_verification_updates (id, session_id, source, previous_json, resulting_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        sessionId,
        source,
        previous ? JSON.stringify(previous) : null,
        JSON.stringify(resulting),
        createdAt,
      );
  }

  public updateSessionMetadata(input: UpdateSessionMetadataInput): UpdateSessionMetadataResult {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }

    const decision = this.checkProjectById(row.project_id);
    if (!decision?.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision?.projectStatus ?? "unregistered",
        reason: decision?.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const current = toSession(row);
    const pathResolver = createProjectPathResolver(project.rootPath);
    const incomingChangedFileChanges = normalizeChangedFileChanges(
      project.rootPath,
      input.changedFileChanges,
      pathResolver,
    );
    const normalizedChangedFiles =
      input.changedFilesMode === "merge"
        ? mergeChangedFiles(
            project.rootPath,
            current,
            [...input.changedFiles, ...changedFilePathsFromChanges(incomingChangedFileChanges)],
            input.changedFilesProvenance,
            pathResolver,
          )
        : normalizeChangedFiles(
            project.rootPath,
            [...input.changedFiles, ...changedFilePathsFromChanges(incomingChangedFileChanges)],
            input.changedFilesProvenance,
            pathResolver,
          );
    const changedFileChanges =
      input.changedFilesMode === "merge"
        ? mergeChangedFileChanges(project.rootPath, current, incomingChangedFileChanges, pathResolver)
        : input.changedFileChanges === undefined
          ? current.changedFileChanges
          : incomingChangedFileChanges;
    const changedFilesConfirmed =
      normalizedChangedFiles.files.length > 0 ||
      input.changedFilesMode !== "merge" ||
      (input.changedFileChanges?.length ?? 0) > 0 ||
      isChangedFilesMetadataConfirmed(row.changed_files_json, row.changed_files_confirmed);
    const updatedAt = nowIso();
    const nextVerification = input.verification ? normalizeVerification(input.verification) : undefined;
    runImmediateSqlTransaction(this.db, () => {
      if (nextVerification && !sameVerification(current.verification, nextVerification)) {
        this.insertVerificationUpdate(input.sessionId, "agent", current.verification, nextVerification, updatedAt);
      }
      this.db
        .prepare(
          `UPDATE sessions
           SET changed_files_json = @changedFiles,
               changed_files_confirmed = @changedFilesConfirmed,
               changed_files_provenance_json = @changedFilesProvenance,
               changed_file_changes_json = @changedFileChanges,
               verification_json = @verification,
               commit_sha = @commitSha,
               git_branch = @gitBranch
           WHERE id = @id`,
        )
        .run({
          id: input.sessionId,
          changedFiles: JSON.stringify(normalizedChangedFiles.files),
          changedFilesConfirmed: changedFilesConfirmed ? 1 : 0,
          changedFilesProvenance: JSON.stringify(normalizedChangedFiles.provenance),
          changedFileChanges: JSON.stringify(changedFileChanges),
          verification: nextVerification
            ? JSON.stringify(nextVerification)
            : current.verification
              ? JSON.stringify(current.verification)
              : null,
          commitSha: input.git?.commitSha ?? current.commitSha ?? null,
          gitBranch: input.git?.branch ?? current.gitBranch ?? null,
        });
      if (input.startedAt && input.startedAt <= current.completedAt) {
        this.db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(input.startedAt, input.sessionId);
      }
      this.touchSession(input.sessionId, updatedAt);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, project.id);
    });

    const session = this.getSessionById(input.sessionId);
    if (!session) {
      throw new Error("Session metadata was updated but could not be loaded.");
    }
    return { outcome: "updated", session };
  }

  public updateSessionSummary(input: UpdateSessionSummaryInput): UpdateSessionSummaryResult {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }

    const decision = this.checkProjectById(row.project_id);
    if (!decision?.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision?.projectStatus ?? "unregistered",
        reason: decision?.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const mode = input.mode ?? "replace";
    const summary = input.summary.trim();
    if (!summary) {
      throw new Error("Session summary must not be empty.");
    }

    return runImmediateSqlTransaction(this.db, () => {
      const existingUpdate = this.db
        .prepare(
          "SELECT session_id, idempotency_key, mode, summary, previous_summary, resulting_summary FROM session_summary_updates WHERE idempotency_key = ?",
        )
        .get(input.idempotencyKey) as
        | {
            session_id: string;
            idempotency_key: string;
            mode: "replace" | "append";
            summary: string;
            previous_summary: string;
            resulting_summary: string;
          }
        | undefined;
      if (existingUpdate) {
        if (
          existingUpdate.session_id !== input.sessionId ||
          existingUpdate.mode !== mode ||
          existingUpdate.summary !== summary
        ) {
          return {
            outcome: "summary_update_idempotency_conflict",
            sessionId: input.sessionId,
            idempotencyKey: input.idempotencyKey,
            reason: "這個摘要更新 idempotencyKey 已經用於不同的 Session、模式或內容；請使用新的 idempotencyKey。",
          };
        }

        const session = this.getSessionById(input.sessionId);
        if (!session) {
          return { outcome: "not_found", sessionId: input.sessionId };
        }
        return {
          outcome: "summary_updated",
          duplicate: true,
          session,
          idempotencyKey: input.idempotencyKey,
          mode,
          previousSummary: existingUpdate.previous_summary,
          appliedSummary: existingUpdate.resulting_summary,
        };
      }

      const currentRow = this.db.prepare("SELECT summary FROM sessions WHERE id = ?").get(input.sessionId) as
        { summary?: string } | undefined;
      if (!currentRow) {
        return { outcome: "not_found", sessionId: input.sessionId };
      }
      const previousSummary = currentRow.summary ?? "";
      const appliedSummary = mode === "append" ? `${previousSummary.trim()}\n\n${summary}` : summary;
      const createdAt = nowIso();
      this.db.prepare("UPDATE sessions SET summary = ? WHERE id = ?").run(appliedSummary, input.sessionId);
      this.touchSession(input.sessionId, createdAt);
      this.db
        .prepare(
          `INSERT INTO session_summary_updates (
             id, session_id, idempotency_key, mode, summary, previous_summary, resulting_summary, created_at
           ) VALUES (@id, @sessionId, @idempotencyKey, @mode, @summary, @previousSummary, @resultingSummary, @createdAt)`,
        )
        .run({
          id: randomUUID(),
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          mode,
          summary,
          previousSummary,
          resultingSummary: appliedSummary,
          createdAt,
        });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(createdAt, project.id);

      const session = this.getSessionById(input.sessionId);
      if (!session) {
        throw new Error("Session summary was updated but could not be loaded.");
      }
      return {
        outcome: "summary_updated",
        duplicate: false,
        session,
        idempotencyKey: input.idempotencyKey,
        mode,
        previousSummary,
        appliedSummary,
      };
    });
  }

  public updateSessionWorkSummary(input: UpdateSessionWorkSummaryInput): UpdateSessionWorkSummaryResult {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }

    const decision = this.checkProjectById(row.project_id);
    if (!decision?.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision?.projectStatus ?? "unregistered",
        reason: decision?.reason ?? "Project recording is not enabled.",
      };
    }

    const mode = input.mode ?? "replace";
    const normalizedPatch = normalizeWorkSummaryPatch(input.workSummary);
    if (Object.keys(normalizedPatch).length === 0) {
      throw new Error("At least one workSummary section is required.");
    }
    const replacement = mode === "replace" ? completeWorkSummary(normalizedPatch) : undefined;
    if (mode === "replace" && !replacement) {
      throw new Error("replace mode requires all five workSummary sections.");
    }
    const requestJson = JSON.stringify(normalizedPatch);
    const project = decision.project;

    return runImmediateSqlTransaction(this.db, () => {
      const existingUpdate = this.db
        .prepare(
          `SELECT session_id, idempotency_key, mode, work_summary_json, previous_work_summary_json, resulting_work_summary_json
           FROM session_work_summary_updates
           WHERE idempotency_key = ?`,
        )
        .get(input.idempotencyKey) as
        | {
            session_id: string;
            idempotency_key: string;
            mode: "replace" | "patch";
            work_summary_json: string;
            previous_work_summary_json: string;
            resulting_work_summary_json: string;
          }
        | undefined;
      if (existingUpdate) {
        if (
          existingUpdate.session_id !== input.sessionId ||
          existingUpdate.mode !== mode ||
          existingUpdate.work_summary_json !== requestJson
        ) {
          return {
            outcome: "work_summary_update_idempotency_conflict",
            sessionId: input.sessionId,
            idempotencyKey: input.idempotencyKey,
            reason:
              "這個 workSummary 更新 idempotencyKey 已經用於不同的 Session、模式或內容；請使用新的 idempotencyKey。",
          };
        }

        const session = this.getSessionById(input.sessionId);
        const appliedWorkSummary = parseWorkSummarySections(existingUpdate.resulting_work_summary_json);
        if (!session || !appliedWorkSummary) {
          return { outcome: "not_found", sessionId: input.sessionId };
        }
        const previousWorkSummary = parseWorkSummarySections(existingUpdate.previous_work_summary_json);
        return {
          outcome: "work_summary_updated",
          duplicate: true,
          session,
          idempotencyKey: input.idempotencyKey,
          mode,
          ...(previousWorkSummary ? { previousWorkSummary } : {}),
          appliedWorkSummary,
        };
      }

      const currentRow = this.db.prepare("SELECT work_summary_json FROM sessions WHERE id = ?").get(input.sessionId) as
        | {
            work_summary_json?: string | null;
          }
        | undefined;
      if (!currentRow) {
        return { outcome: "not_found", sessionId: input.sessionId };
      }
      const previousWorkSummary = parseWorkSummarySections(currentRow.work_summary_json ?? null);
      const appliedWorkSummary = replacement ?? mergeWorkSummary(previousWorkSummary, normalizedPatch);
      const createdAt = nowIso();
      this.db
        .prepare("UPDATE sessions SET work_summary_json = ? WHERE id = ?")
        .run(JSON.stringify(appliedWorkSummary), input.sessionId);
      this.touchSession(input.sessionId, createdAt);
      this.db
        .prepare(
          `INSERT INTO session_work_summary_updates (
             id, session_id, idempotency_key, mode, work_summary_json, previous_work_summary_json, resulting_work_summary_json, created_at
           ) VALUES (@id, @sessionId, @idempotencyKey, @mode, @workSummary, @previousWorkSummary, @resultingWorkSummary, @createdAt)`,
        )
        .run({
          id: randomUUID(),
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          mode,
          workSummary: requestJson,
          previousWorkSummary: JSON.stringify(previousWorkSummary ?? {}),
          resultingWorkSummary: JSON.stringify(appliedWorkSummary),
          createdAt,
        });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(createdAt, project.id);

      const session = this.getSessionById(input.sessionId);
      if (!session) {
        throw new Error("Session workSummary was updated but could not be loaded.");
      }
      return {
        outcome: "work_summary_updated",
        duplicate: false,
        session,
        idempotencyKey: input.idempotencyKey,
        mode,
        ...(previousWorkSummary ? { previousWorkSummary } : {}),
        appliedWorkSummary,
      };
    });
  }

  public getSessionDetail(sessionId: string): SessionDetail | undefined {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      return undefined;
    }

    const project = this.getProjectById(row.project_id);
    if (!project || project.status !== "tracked") {
      return undefined;
    }

    const events = this.db
      .prepare("SELECT * FROM work_events WHERE session_id = ? ORDER BY occurred_at ASC")
      .all(sessionId) as EventRow[];
    const snapshots = this.db
      .prepare("SELECT * FROM raw_snapshots WHERE session_id = ? ORDER BY captured_at ASC")
      .all(sessionId) as SnapshotRow[];
    const evidence = this.db
      .prepare("SELECT * FROM evidence WHERE session_id = ? ORDER BY captured_at ASC, rowid ASC")
      .all(sessionId) as EvidenceRow[];
    const knowledge = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE k.session_id = ?
         ORDER BY k.updated_at DESC, k.id ASC`,
      )
      .all(sessionId) as KnowledgeRow[];

    return {
      session: toSession(row),
      project,
      events: events.map(toEvent),
      rawSnapshots: snapshots.map(toSnapshot),
      evidence: evidence.map(toEvidence),
      knowledge: knowledge.map((row) => this.withKnowledgeTrust(toKnowledge(row))),
      links: this.getSessionLinks(sessionId),
      verificationHistory: (
        this.db
          .prepare(
            "SELECT * FROM session_verification_updates WHERE session_id = ? ORDER BY created_at DESC, rowid DESC",
          )
          .all(sessionId) as VerificationUpdateRow[]
      ).map(toVerificationUpdate),
      voidHistory: (
        this.db
          .prepare("SELECT * FROM void_audit WHERE session_id = ? ORDER BY occurred_at DESC, rowid DESC")
          .all(sessionId) as VoidAuditRow[]
      ).map(toVoidAudit),
    };
  }

  /** Voids or restores a Session. Voided Sessions leave lists, reports, the graph, context, and recall. */
  public setSessionVoid(input: SetSessionVoidInput): SetSessionVoidResult {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }
    const decision = this.checkProjectById(row.project_id);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }
    const projectId = decision.project.id;
    const reason = requireVoidReason(input.voided, input.reason);
    return runImmediateSqlTransaction(this.db, () => {
      const current = this.db.prepare("SELECT voided_at FROM sessions WHERE id = ?").get(input.sessionId) as {
        voided_at: string | null;
      };
      const duplicate = Boolean(current.voided_at) === input.voided;
      if (!duplicate) {
        const occurredAt = nowIso();
        this.db
          .prepare("UPDATE sessions SET voided_at = ?, void_reason = ? WHERE id = ?")
          .run(input.voided ? occurredAt : null, input.voided ? (reason ?? null) : null, input.sessionId);
        this.insertVoidAudit("session", input.sessionId, input.sessionId, projectId, input.voided, reason, occurredAt);
        this.touchSession(input.sessionId, occurredAt);
        this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(occurredAt, projectId);
      }
      const session = this.getSessionById(input.sessionId);
      if (!session) {
        throw new Error("Session void state was updated but the Session could not be loaded.");
      }
      return { outcome: "session_void_updated", duplicate, session };
    });
  }

  /** Marks evidence as wrong (or restores it); it stays in Session detail but leaves reports and the graph. */
  public setEvidenceVoid(input: SetEvidenceVoidInput): SetEvidenceVoidResult {
    const row = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(input.evidenceId) as EvidenceRow | undefined;
    if (!row) {
      return { outcome: "not_found", evidenceId: input.evidenceId };
    }
    const decision = this.checkProjectById(row.project_id);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        evidenceId: input.evidenceId,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }
    const projectId = decision.project.id;
    const reason = requireVoidReason(input.voided, input.reason);
    return runImmediateSqlTransaction(this.db, () => {
      const duplicate = Boolean(row.voided_at) === input.voided;
      if (!duplicate) {
        const occurredAt = nowIso();
        this.db
          .prepare("UPDATE evidence SET voided_at = ?, void_reason = ? WHERE id = ?")
          .run(input.voided ? occurredAt : null, input.voided ? (reason ?? null) : null, input.evidenceId);
        this.insertVoidAudit("evidence", input.evidenceId, row.session_id, projectId, input.voided, reason, occurredAt);
        this.touchSession(row.session_id, occurredAt);
        this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(occurredAt, projectId);
      }
      const updated = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(input.evidenceId) as EvidenceRow;
      return { outcome: "evidence_void_updated", duplicate, evidence: toEvidence(updated) };
    });
  }

  private insertVoidAudit(
    targetType: VoidTargetType,
    targetId: string,
    sessionId: string,
    projectId: string,
    voided: boolean,
    reason: string | undefined,
    occurredAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO void_audit (id, target_type, target_id, session_id, project_id, action, reason, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        targetType,
        targetId,
        sessionId,
        projectId,
        voided ? "voided" : "restored",
        reason ?? null,
        occurredAt,
      );
  }

  public recordKnowledge(input: RecordKnowledgeInput): RecordKnowledgeResult {
    const decision = this.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    return runImmediateSqlTransaction(this.db, () => {
      if (input.sessionId) {
        const session = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(input.sessionId) as
          { project_id?: string } | undefined;
        if (!session || session.project_id !== project.id) {
          return { outcome: "not_found", sessionId: input.sessionId };
        }
      }

      const existing = this.db
        .prepare(
          `SELECT k.*, p.name AS project_name
           FROM knowledge k
           JOIN projects p ON p.id = k.project_id
           WHERE k.project_id = ? AND k.idempotency_key = ?`,
        )
        .get(project.id, input.idempotencyKey) as KnowledgeRow | undefined;
      if (existing) {
        return {
          outcome: "knowledge_recorded",
          duplicate: true,
          knowledge: this.withKnowledgeTrust(toKnowledge(existing)),
        };
      }

      const createdAt = nowIso();
      const knowledge: KnowledgeRecord = {
        id: randomUUID(),
        projectId: project.id,
        projectName: project.name,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        title: input.title.trim(),
        body: input.body.trim(),
        tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
        references: [...new Set((input.references ?? []).map((reference) => reference.trim()).filter(Boolean))],
        status: "active",
        createdAt,
        updatedAt: createdAt,
        appliesTo: cleanList(input.appliesTo),
      };
      const warnings: string[] = [];
      const superseded = input.supersedesId
        ? (this.db
            .prepare(
              `SELECT k.*, p.name AS project_name FROM knowledge k JOIN projects p ON p.id = k.project_id
               WHERE k.id = ? AND k.project_id = ?`,
            )
            .get(input.supersedesId, project.id) as KnowledgeRow | undefined)
        : undefined;
      if (input.supersedesId && !superseded) {
        warnings.push(`supersedesId ${input.supersedesId} was not found in this project.`);
      }
      if (superseded) {
        knowledge.supersedesId = superseded.id;
      }

      this.db
        .prepare(
          `INSERT INTO knowledge (
             id, project_id, session_id, idempotency_key, kind, title, body,
             tags_json, references_json, status, created_at, updated_at, applies_to_json, supersedes_id
           ) VALUES (
             @id, @projectId, @sessionId, @idempotencyKey, @kind, @title, @body,
             @tags, @references, @status, @createdAt, @updatedAt, @appliesTo, @supersedesId
           )`,
        )
        .run({
          id: knowledge.id,
          projectId: knowledge.projectId,
          sessionId: knowledge.sessionId ?? null,
          idempotencyKey: knowledge.idempotencyKey,
          kind: knowledge.kind,
          title: knowledge.title,
          body: knowledge.body,
          tags: JSON.stringify(knowledge.tags),
          references: JSON.stringify(knowledge.references),
          status: knowledge.status,
          createdAt: knowledge.createdAt,
          updatedAt: knowledge.updatedAt,
          appliesTo: JSON.stringify(knowledge.appliesTo),
          supersedesId: knowledge.supersedesId ?? null,
        });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(createdAt, project.id);
      this.insertKnowledgeAudit({
        knowledge,
        action: "created",
        changedFields: [
          "kind",
          "title",
          "body",
          "tags",
          "references",
          "status",
          ...(knowledge.appliesTo.length > 0 ? ["appliesTo"] : []),
          ...(knowledge.supersedesId ? ["supersedesId"] : []),
        ],
        occurredAt: createdAt,
      });
      if (superseded && superseded.status === "active") {
        const before = toKnowledge(superseded);
        const after: KnowledgeRecord = { ...before, status: "archived", updatedAt: createdAt };
        this.db
          .prepare("UPDATE knowledge SET status = 'archived', updated_at = ? WHERE id = ?")
          .run(createdAt, before.id);
        this.insertKnowledgeAudit({
          knowledge: after,
          before,
          action: "archived",
          changedFields: ["status"],
          occurredAt: createdAt,
        });
      }

      return {
        outcome: "knowledge_recorded",
        duplicate: false,
        knowledge: this.withKnowledgeTrust(knowledge),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    });
  }

  public updateKnowledge(input: UpdateKnowledgeInput): UpdateKnowledgeResult {
    const decision = this.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }

    const row = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE k.id = ? AND k.project_id = ?`,
      )
      .get(input.knowledgeId, decision.project.id) as KnowledgeRow | undefined;
    if (!row) {
      return { outcome: "not_found", knowledgeId: input.knowledgeId };
    }

    const current = toKnowledge(row);
    const updatedAt = nowIso();
    const next: KnowledgeRecord = {
      ...current,
      kind: input.kind ?? current.kind,
      title: input.title?.trim() || current.title,
      body: input.body?.trim() || current.body,
      tags: input.tags ? [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))] : current.tags,
      references: input.references
        ? [...new Set(input.references.map((reference) => reference.trim()).filter(Boolean))]
        : current.references,
      status: input.status ?? current.status,
      updatedAt,
      appliesTo: input.appliesTo ? cleanList(input.appliesTo) : current.appliesTo,
      ...(input.confirm ? { lastConfirmedAt: updatedAt } : {}),
    };
    if (input.confirm) {
      delete next.lastConfirmedSessionId;
      delete next.review;
    }
    const changedFields = [
      ...(current.kind !== next.kind ? ["kind"] : []),
      ...(current.title !== next.title ? ["title"] : []),
      ...(current.body !== next.body ? ["body"] : []),
      ...(JSON.stringify(current.tags) !== JSON.stringify(next.tags) ? ["tags"] : []),
      ...(JSON.stringify(current.references) !== JSON.stringify(next.references) ? ["references"] : []),
      ...(current.status !== next.status ? ["status"] : []),
      ...(JSON.stringify(current.appliesTo) !== JSON.stringify(next.appliesTo) ? ["appliesTo"] : []),
      ...(input.confirm ? ["lastConfirmedAt"] : []),
      ...(input.confirm && current.review ? ["review"] : []),
    ];
    const action: KnowledgeAuditAction =
      current.status !== next.status ? (next.status === "archived" ? "archived" : "restored") : "updated";

    this.db
      .prepare(
        `UPDATE knowledge
         SET kind = @kind,
             title = @title,
             body = @body,
             tags_json = @tags,
             references_json = @references,
             status = @status,
             updated_at = @updatedAt,
             applies_to_json = @appliesTo,
             last_confirmed_at = @lastConfirmedAt,
             last_confirmed_session_id = @lastConfirmedSessionId,
             review_json = @review
         WHERE id = @id AND project_id = @projectId`,
      )
      .run({
        id: next.id,
        projectId: next.projectId,
        kind: next.kind,
        title: next.title,
        body: next.body,
        tags: JSON.stringify(next.tags),
        references: JSON.stringify(next.references),
        status: next.status,
        updatedAt: next.updatedAt,
        appliesTo: JSON.stringify(next.appliesTo),
        lastConfirmedAt: next.lastConfirmedAt ?? null,
        lastConfirmedSessionId: next.lastConfirmedSessionId ?? null,
        review: next.review ? JSON.stringify(next.review) : null,
      });
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, decision.project.id);
    this.insertKnowledgeAudit({ knowledge: next, before: current, action, changedFields, occurredAt: updatedAt });

    return { outcome: "knowledge_updated", knowledge: this.withKnowledgeTrust(next) };
  }

  public getKnowledgeHistory(input: KnowledgeHistoryQuery): KnowledgeHistoryResult {
    const decision = this.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        knowledgeId: input.knowledgeId,
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }

    const row = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE k.id = ? AND k.project_id = ?`,
      )
      .get(input.knowledgeId, decision.project.id) as KnowledgeRow | undefined;
    if (!row) {
      return { outcome: "not_found", knowledgeId: input.knowledgeId };
    }

    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const auditRows = this.db
      .prepare(
        `SELECT *
         FROM knowledge_audit
         WHERE knowledge_id = ? AND project_id = ?
         ORDER BY occurred_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(input.knowledgeId, decision.project.id, limit) as KnowledgeAuditRow[];

    return {
      outcome: "knowledge_history",
      project: decision.project,
      knowledge: toKnowledge(row),
      history: auditRows.map(toKnowledgeAudit),
    };
  }

  public searchKnowledge(options: KnowledgeQuery = {}): KnowledgeQueryResult | KnowledgeSkippedResult {
    const result = this.knowledge.search(options);
    return result.outcome === "knowledge"
      ? { ...result, items: result.items.map((item) => this.withKnowledgeTrust(item)) }
      : result;
  }

  public getGraph(options: GraphQuery = {}): GraphQueryResult {
    return this.graphBuilder.build(options);
  }

  public attachEvidence(input: AttachEvidenceInput): AttachEvidenceResult {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }

    const decision = this.checkProjectById(row.project_id);
    if (!decision?.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision?.projectStatus ?? "unregistered",
        reason: decision?.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const kind = input.kind.trim();
    const reference = input.reference.trim();
    return runImmediateSqlTransaction(this.db, () => {
      const existing = this.db
        .prepare("SELECT * FROM evidence WHERE session_id = ? AND kind = ? AND reference = ?")
        .get(input.sessionId, kind, reference) as EvidenceRow | undefined;
      if (existing) {
        return { outcome: "evidence_attached", duplicate: true, evidence: toEvidence(existing) };
      }

      const evidence: EvidenceRecord = {
        id: randomUUID(),
        sessionId: input.sessionId,
        projectId: project.id,
        kind,
        reference,
        summary: input.summary?.trim() || undefined,
        capturedAt: nowIso(),
      };
      this.db
        .prepare(
          `INSERT INTO evidence (id, session_id, project_id, kind, reference, summary, captured_at)
           VALUES (@id, @sessionId, @projectId, @kind, @reference, @summary, @capturedAt)`,
        )
        .run({
          id: evidence.id,
          sessionId: evidence.sessionId,
          projectId: evidence.projectId,
          kind: evidence.kind,
          reference: evidence.reference,
          summary: evidence.summary ?? null,
          capturedAt: evidence.capturedAt,
        });
      this.touchSession(evidence.sessionId, evidence.capturedAt);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(evidence.capturedAt, project.id);

      return { outcome: "evidence_attached", duplicate: false, evidence };
    });
  }

  public finalizeSession(input: FinalizeSessionInput): FinalizeSessionResult {
    const decision = this.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const pathResolver = createProjectPathResolver(project.rootPath);
    const normalizedBaselineChangedFiles = normalizeChangedFiles(
      project.rootPath,
      input.baselineChangedFiles,
      undefined,
      pathResolver,
    ).files;
    const baselineChangedFileIdentities = new Set(normalizedBaselineChangedFiles.map(changedFileIdentity));
    const normalizedChangedFileChanges = excludeBaselineChangedFileChanges(
      normalizeChangedFileChanges(project.rootPath, input.changedFileChanges, pathResolver),
      baselineChangedFileIdentities,
    );
    const normalizedChangedFiles = excludeBaselineChangedFiles(
      normalizeChangedFiles(
        project.rootPath,
        [...(input.changedFiles ?? []), ...changedFilePathsFromChanges(normalizedChangedFileChanges)],
        input.changedFilesProvenance,
        pathResolver,
      ),
      baselineChangedFileIdentities,
    );
    const normalizedWorkSummary = normalizeWorkSummarySections(input.workSummary);
    const capturedHandoff = this.captureHandoff(project.rootPath, input);
    const git = input.git ?? this.readGitMetadata(project.rootPath);
    const sessionId = randomUUID();
    const createdAt = nowIso();
    const completedAt = input.completedAt ?? createdAt;
    const startedAt = resolveStartedAt(input.startedAt, input.events, completedAt);
    const events = [
      ...(input.events ?? []),
      {
        type: "finalized" as const,
        summary: "Session finalized after closing handoff.",
      },
    ];

    return runImmediateSqlTransaction(this.db, () => {
      const existing = this.getSessionByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const incomingSummary = input.summary.trim();
        if (existing.summary !== incomingSummary) {
          return {
            outcome: "idempotency_conflict",
            idempotencyKey: input.idempotencyKey,
            sessionId: existing.id,
            existingSummary: existing.summary,
            reason:
              "同一 idempotencyKey 已經完成過，但這次 summary 不同；請使用 work_update_session_summary 明確更新同一筆 Session。",
            suggestedTool: "work_update_session_summary",
          };
        }
        return {
          outcome: "finalized",
          duplicate: true,
          session: existing,
          verificationFollowUp: getVerificationFollowUp(existing),
          ...(this.hasConfirmedChangedFilesForSession(existing.id)
            ? {}
            : { changedFilesFollowUp: getChangedFilesFollowUp(existing) }),
          workSummaryFollowUp: getWorkSummaryFollowUp(existing),
        };
      }

      this.db
        .prepare(
          `INSERT INTO sessions (
             id, project_id, external_session_id, idempotency_key, title, summary,
             work_summary_json, status, execution_status, completed_at, created_at, commit_sha, git_branch,
             changed_files_json, changed_files_confirmed, changed_files_provenance_json, changed_file_changes_json, verification_json,
             started_at, updated_at
           ) VALUES (
             @id, @projectId, @externalSessionId, @idempotencyKey, @title, @summary,
             @workSummary, 'finalized', 'completed', @completedAt, @createdAt, @commitSha, @gitBranch,
             @changedFiles, @changedFilesConfirmed, @changedFilesProvenance, @changedFileChanges, @verification,
             @startedAt, @createdAt
           )`,
        )
        .run({
          id: sessionId,
          projectId: project.id,
          externalSessionId: input.externalSessionId ?? null,
          idempotencyKey: input.idempotencyKey,
          title: input.title,
          summary: input.summary,
          workSummary: JSON.stringify(normalizedWorkSummary ?? {}),
          completedAt,
          createdAt,
          commitSha: git?.commitSha ?? null,
          gitBranch: git?.branch ?? null,
          changedFiles: JSON.stringify(normalizedChangedFiles.files),
          changedFilesConfirmed: input.changedFiles !== undefined || normalizedChangedFiles.files.length > 0 ? 1 : 0,
          changedFilesProvenance: JSON.stringify(normalizedChangedFiles.provenance),
          changedFileChanges: JSON.stringify(normalizedChangedFileChanges),
          verification: input.verification ? JSON.stringify(input.verification) : null,
          startedAt: startedAt ?? null,
        });

      for (const event of events) {
        this.db
          .prepare(
            `INSERT INTO work_events (id, session_id, type, summary, details_json, occurred_at)
             VALUES (@id, @sessionId, @type, @summary, @details, @occurredAt)`,
          )
          .run({
            id: randomUUID(),
            sessionId,
            type: event.type,
            summary: event.summary,
            details: event.details ? JSON.stringify(event.details) : null,
            occurredAt: event.occurredAt ?? completedAt,
          });
      }

      if (capturedHandoff) {
        this.db
          .prepare(
            `INSERT INTO raw_snapshots (id, session_id, project_id, kind, source_path, content, captured_at)
             VALUES (@id, @sessionId, @projectId, 'handoff', @sourcePath, @content, @capturedAt)`,
          )
          .run({
            id: randomUUID(),
            sessionId,
            projectId: project.id,
            sourcePath: capturedHandoff.sourcePath ?? null,
            content: capturedHandoff.content,
            capturedAt: createdAt,
          });
      }

      this.db
        .prepare("UPDATE projects SET last_ingested_at = ?, updated_at = ? WHERE id = ?")
        .run(createdAt, createdAt, project.id);

      const linkWarnings = [
        ...(input.parentSessionId ? [{ id: input.parentSessionId, relation: "continues" as const }] : []),
        ...(input.relatedSessionIds ?? []).map((id) => ({ id, relation: "related" as const })),
      ].flatMap(({ id, relation }) => {
        const problem = this.linkProblem(sessionId, id);
        if (problem) {
          return [`${id}: ${problem}`];
        }
        this.writeSessionLink(sessionId, id, relation, "agent", createdAt);
        return [];
      });

      const knowledgeWarnings = this.applyKnowledgeFeedback(project.id, sessionId, completedAt, input);

      const session = this.getSessionByIdempotencyKey(input.idempotencyKey);
      if (!session) {
        throw new Error("Session was inserted but could not be loaded.");
      }

      return {
        outcome: "finalized",
        duplicate: false,
        session,
        verificationFollowUp: getVerificationFollowUp(session),
        changedFilesFollowUp: input.changedFiles === undefined ? getChangedFilesFollowUp(session) : undefined,
        workSummaryFollowUp: getWorkSummaryFollowUp(session),
        ...(linkWarnings.length > 0 ? { linkWarnings } : {}),
        ...(knowledgeWarnings.length > 0 ? { knowledgeWarnings } : {}),
      };
    });
  }

  public getContext(projectRoot?: string, focus: ContextFocus = {}): ContextQueryResult {
    return this.contextRecallService.getContext(projectRoot, focus);
  }

  /**
   * Ranked retrieval across Sessions (including raw handoff sections) and active Knowledge of tracked
   * projects. Returns compact hits; read full records with getSessionDetailForAgent or searchKnowledge.
   */
  public recall(input: { q?: string; paths?: string[]; projectRoot?: string; limit?: number }): RecallQueryResult {
    return this.contextRecallService.recall(input);
  }

  public search(query: string, projectRoot?: string): SearchResult[] | SkippedResult {
    return this.contextRecallService.search(query, projectRoot);
  }

  /** Read-only recording state of a workspace root, so an Agent can skip preparing an untracked finalize. */
  public getProjectStatus(projectRoot: string): ProjectStatusResult {
    const decision = this.checkProjectRoot(projectRoot);
    const project = decision.project ?? this.getProjectByRootPath(decision.canonicalRoot);
    return {
      outcome: "project_status",
      projectRoot: decision.canonicalRoot,
      projectStatus: decision.projectStatus,
      tracked: decision.allowed && decision.project !== undefined,
      ...(project ? { project } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  }

  /** Session detail for Agents: policy-gated, with raw handoff content omitted unless requested. */
  public getSessionDetailForAgent(query: {
    sessionId: string;
    includeRawSnapshots?: boolean;
  }): SessionDetailQueryResult {
    const notFound: SessionNotFoundResult = {
      outcome: "not_found",
      sessionId: query.sessionId,
      reason: "Session does not exist.",
    };
    const session = this.getSessionById(query.sessionId);
    if (!session) {
      return notFound;
    }
    const decision = this.checkProjectById(session.projectId);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: query.sessionId,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }
    const detail = this.getSessionDetail(query.sessionId);
    if (!detail) {
      return notFound;
    }
    return {
      outcome: "session_detail",
      ...detail,
      rawSnapshots: query.includeRawSnapshots
        ? detail.rawSnapshots
        : detail.rawSnapshots.map(({ content, ...snapshot }) => ({ ...snapshot, contentLength: content.length })),
    };
  }

  /** Paged tracked-only Session list for Agents, scoped by projectRoot or projectId. */
  public listSessionsForAgent(
    input: {
      q?: string;
      from?: string;
      to?: string;
      voided?: SessionVoidedFilter;
      page?: number;
      pageSize?: number;
    } & TrackedScopeInput,
  ): SessionListQueryResult {
    const scope = this.resolveTrackedScope(input);
    if ("outcome" in scope) {
      return scope;
    }
    return this.listSessionsPage({
      query: input.q || undefined,
      from: input.from,
      to: input.to,
      voided: input.voided,
      page: input.page,
      pageSize: input.pageSize,
      projectId: scope.projectId,
      trackedOnly: true,
    });
  }

  /** Agent-created report synthesis request; the same policy and dedupe rules as the Reports page. */
  public requestReportSynthesis(
    input: Omit<CreateReportSynthesisRequestInput, "projectId"> & TrackedScopeInput,
  ): CreateReportSynthesisRequestResult | SkippedResult | ProjectIdSkippedResult {
    const scope = this.resolveTrackedScope(input);
    if ("outcome" in scope) {
      return scope;
    }
    return this.createReportSynthesisRequest({
      period: input.period,
      ...(input.date ? { date: input.date } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
    });
  }

  /** Agent-created metadata backfill request; the same policy and dedupe rules as the Projects page. */
  public requestMetadataBackfill(
    input: Omit<CreateMetadataBackfillRequestInput, "projectId"> & TrackedScopeInput,
  ): CreateMetadataBackfillRequestResult {
    const scope = this.resolveTrackedScope(input);
    if ("outcome" in scope) {
      return scope;
    }
    return this.createMetadataBackfillRequest({
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
    });
  }

  /** Resolves an optional projectRoot/projectId pair to a tracked project id, or the quiet skip result. */
  private resolveTrackedScope(
    scope: TrackedScopeInput,
  ): { projectId?: string } | SkippedResult | ProjectIdSkippedResult {
    if (scope.projectRoot) {
      const decision = this.checkProjectRoot(scope.projectRoot);
      if (!decision.allowed || !decision.project) {
        return skippedByRoot(decision);
      }
      if (scope.projectId && scope.projectId !== decision.project.id) {
        return {
          outcome: "skipped",
          projectId: scope.projectId,
          projectStatus: decision.projectStatus,
          reason: "projectRoot and projectId refer to different projects.",
        };
      }
      return { projectId: decision.project.id };
    }
    if (scope.projectId) {
      const decision = this.checkProjectById(scope.projectId);
      if (!decision.allowed || !decision.project) {
        return skippedByProjectId(scope.projectId, decision);
      }
      return { projectId: decision.project.id };
    }
    return {};
  }

  private captureHandoff(
    projectRoot: string,
    input: FinalizeSessionInput,
  ): { content: string; sourcePath?: string } | undefined {
    if (input.handoffContent !== undefined) {
      return { content: input.handoffContent, sourcePath: input.handoffPath };
    }

    if (!input.handoffPath) {
      return undefined;
    }

    const handoffPath = safeExistingProjectPath(projectRoot, input.handoffPath);
    if (!handoffPath) {
      return undefined;
    }

    try {
      return {
        content: readFileSync(handoffPath, "utf8").slice(0, 200_000),
        sourcePath: input.handoffPath,
      };
    } catch {
      return undefined;
    }
  }

  private readGitMetadata(projectRoot: string): GitSummary | undefined {
    try {
      const headPath = safeExistingProjectPath(projectRoot, ".git/HEAD");
      if (!headPath) {
        return undefined;
      }

      const head = readFileSync(headPath, "utf8").trim();
      if (head.startsWith("ref: ")) {
        const ref = head.slice("ref: ".length);
        let commitSha: string | undefined;
        try {
          const refPath = safeExistingProjectPath(projectRoot, `.git/${ref}`);
          commitSha = refPath ? readFileSync(refPath, "utf8").trim() || undefined : undefined;
        } catch {
          commitSha = undefined;
        }
        return { branch: ref.replace(/^refs\/heads\//, ""), commitSha };
      }
      return { commitSha: head || undefined };
    } catch {
      return undefined;
    }
  }

  private insertKnowledgeAudit(input: {
    knowledge: KnowledgeRecord;
    before?: KnowledgeRecord;
    action: KnowledgeAuditAction;
    changedFields: string[];
    occurredAt: string;
  }): void {
    const audit: KnowledgeAuditRecord = {
      id: randomUUID(),
      knowledgeId: input.knowledge.id,
      projectId: input.knowledge.projectId,
      action: input.action,
      ...(input.before ? { before: input.before } : {}),
      after: input.knowledge,
      changedFields: [...new Set(input.changedFields)],
      occurredAt: input.occurredAt,
    };

    this.db
      .prepare(
        `INSERT INTO knowledge_audit (
           id, knowledge_id, project_id, action, before_json, after_json,
           changed_fields_json, occurred_at
         ) VALUES (
           @id, @knowledgeId, @projectId, @action, @before, @after,
           @changedFields, @occurredAt
         )`,
      )
      .run({
        id: audit.id,
        knowledgeId: audit.knowledgeId,
        projectId: audit.projectId,
        action: audit.action,
        before: audit.before ? JSON.stringify(audit.before) : null,
        after: JSON.stringify(audit.after),
        changedFields: JSON.stringify(audit.changedFields),
        occurredAt: audit.occurredAt,
      });
  }
}
