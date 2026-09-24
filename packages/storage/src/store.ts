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
  ContextResult,
  DecisionDigest,
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
  RecallHit,
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
  RelevantContext,
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
  KnowledgeDigest,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeRecord,
  KnowledgeSkippedResult,
  KnowledgeStatus,
  MetadataBackfillApplyInput,
  MetadataBackfillBatchResult,
  MetadataBackfillFailure,
  MetadataBackfillItem,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequest,
  MetadataBackfillRequestContextQuery,
  MetadataBackfillRequestContextQueryResult,
  MetadataBackfillRequestListQueryResult,
  MetadataBackfillRequestQuery,
  MetadataBackfillSkipped,
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
  ReportRange,
  ReportEvidence,
  ReportEvidenceKind,
  ReportDecision,
  ReportInsight,
  ReportMetricComparison,
  ReportQueryResult,
  ReportProjectSummary,
  ReportSynthesisContextQuery,
  ReportSynthesisContextQueryResult,
  ReportSynthesisContextResult,
  ReportSynthesisRequest,
  ReportSynthesisRequestQuery,
  ReportSynthesisRequestListQueryResult,
  RetryReportSynthesisRequestResult,
  ReportSummary,
  ReportSummaryBlock,
  ReportSummaryRequestNotReadyResult,
  ReportSummaryQuery,
  ReportSummaryQueryResult,
  ReportSummaryListResult,
  DeleteReportSummaryResult,
  SaveReportSummaryInput,
  SaveReportSummaryResult,
  CreateReportSynthesisRequestInput,
  CreateReportSynthesisRequestResult,
  ReportSynthesisRequestLookupResult,
  ReportSynthesisRequestDetailResult,
  ReportTrendGranularity,
  ReportTrendPoint,
  WorkReport,
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
  DatabaseBackupCreated,
  DatabaseBackupList,
  DatabaseBackupUnavailable,
  ProjectStatusResult,
  SessionDetailQueryResult,
  SessionListQueryResult,
  SessionNotFoundResult,
} from "@work-intelligence/core";
import { localTimeZone, nowIso, toLocalCalendarDate, truncateText } from "@work-intelligence/shared";
import { createProjectPathResolver, ProjectPolicyGate, safeProjectPath } from "@work-intelligence/project-policy";
import {
  backupDatabase,
  DEFAULT_BACKUP_KEEP,
  defaultBackupDirectory,
  exportDatabase,
  isBackupDue,
  listDatabaseBackups,
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
import { MetadataBackfillRepository } from "./metadata-backfill-repository.js";
import { ReportBuilder } from "./report-builder.js";
import { ReportSynthesisRequestRepository } from "./report-synthesis-request-repository.js";
import { SessionRepository, type SessionListOptions, type SessionRow } from "./session-repository.js";
import { runImmediateTransaction as runImmediateSqlTransaction } from "./sqlite-transaction.js";
import { DIGEST_ITEM_LENGTH, toKnowledgeDigest, toSessionDigest } from "./digest.js";
import { applySchemaMigrations } from "./schema-migrations.js";
import { matchesAppliesTo, normalizePath } from "./search-text.js";
import { KnowledgeCandidateService } from "./knowledge-candidates.js";
import { SearchRepository } from "./search-repository.js";

const RECENT_DECISION_LIMIT = 12;
const RELEVANT_LIMIT = 5;
const RECALL_DEFAULT_LIMIT = 8;
const RECALL_MAX_LIMIT = 30;
const SEARCH_LIMIT = 20;

/** What an Agent is about to work on; ranks relevant records into the context result. */
export type ContextFocus = { task?: string; paths?: string[] };

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

type ReportSynthesisRequestRow = {
  id: string;
  idempotency_key: string;
  scope_type: "all" | "project";
  project_id: string | null;
  project_name: string | null;
  period: ReportPeriod;
  range_from: string;
  range_to: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  source_session_ids_json: string;
};

type ReportSummaryRow = {
  id: string;
  request_id: string;
  period: ReportPeriod;
  range_from: string;
  range_to: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  executive_summary: string;
  themes_json: string;
  highlights_json: string;
  verification_json: string;
  comparison_json: string;
  risks_json: string;
  decisions_json: string;
  next_steps_json: string;
  source_session_ids_json: string;
  generated_by_agent: string;
  generated_by_model: string | null;
  prompt_version: string;
  created_at: string;
  is_current: number;
};

type MetadataBackfillRequestRow = {
  id: string;
  idempotency_key: string;
  scope_type: "all" | "project";
  project_id: string | null;
  project_name: string | null;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  source_session_ids_json: string;
};

type ReportAttachedEvidenceRow = EvidenceRow & {
  session_title: string;
  project_name: string | null;
};

type ReportEventRow = EventRow & { project_id: string };
type ReportSnapshotSummaryRow = {
  session_id: string;
  source_path: string | null;
};

type MetadataBackfillRow = SessionRow & {
  project_root: string;
  raw_snapshot_count: number;
};

type HandoffImportPlan = {
  project: ProjectRecord;
  discovery: HandoffDiscoveryResult;
  candidates: HandoffImportCandidate[];
  items: HandoffImportPreviewItem[];
  preview: HandoffImportPreview;
};

const schema = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('unregistered', 'tracked', 'paused', 'ignored')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_session_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  work_summary_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status = 'finalized'),
  execution_status TEXT NOT NULL DEFAULT 'completed' CHECK (execution_status = 'completed'),
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  commit_sha TEXT,
  git_branch TEXT,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  changed_files_provenance_json TEXT NOT NULL DEFAULT '[]',
  changed_file_changes_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT
);

CREATE TABLE IF NOT EXISTS work_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('planning', 'execution', 'verification', 'closing', 'note', 'finalized')),
  summary TEXT NOT NULL,
  details_json TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind = 'handoff'),
  source_path TEXT,
  content TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  reference TEXT NOT NULL,
  summary TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE(session_id, kind, reference)
);

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'pattern', 'gotcha', 'procedure', 'skill')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  references_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS knowledge_audit (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'archived', 'restored')),
  before_json TEXT,
  after_json TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_synthesis_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'project')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'year')),
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failure_reason TEXT,
  source_session_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS report_summaries (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES report_synthesis_requests(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'year')),
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  executive_summary TEXT NOT NULL,
  themes_json TEXT NOT NULL DEFAULT '[]',
  highlights_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT NOT NULL DEFAULT '[]',
  comparison_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  next_steps_json TEXT NOT NULL DEFAULT '[]',
  source_session_ids_json TEXT NOT NULL DEFAULT '[]',
  generated_by_agent TEXT NOT NULL,
  generated_by_model TEXT,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
);

CREATE TABLE IF NOT EXISTS metadata_backfill_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'project')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failure_reason TEXT,
  source_session_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS session_summary_updates (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('replace', 'append')),
  summary TEXT NOT NULL,
  previous_summary TEXT NOT NULL,
  resulting_summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_work_summary_updates (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('replace', 'patch')),
  work_summary_json TEXT NOT NULL,
  previous_work_summary_json TEXT NOT NULL DEFAULT '{}',
  resulting_work_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_sessions_project_completed ON sessions(project_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_completed ON sessions(completed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_occurred ON work_events(session_id, occurred_at ASC);
-- Context decisions now come from workSummary.decisions; drop the old note/closing event index.
DROP INDEX IF EXISTS idx_events_decisions_occurred;
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON raw_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_evidence_session_captured ON evidence(session_id, captured_at ASC);
CREATE INDEX IF NOT EXISTS idx_knowledge_project_updated ON knowledge(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_session_updated ON knowledge(session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_audit_knowledge_occurred ON knowledge_audit(knowledge_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_report_synthesis_requests_status ON report_synthesis_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_synthesis_requests_scope ON report_synthesis_requests(project_id, period, range_from, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_summaries_request_created ON report_summaries(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_summaries_current_scope ON report_summaries(is_current, project_id, period, range_from, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_metadata_backfill_requests_status ON metadata_backfill_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_metadata_backfill_requests_scope ON metadata_backfill_requests(project_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_summary_updates_session ON session_summary_updates(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_work_summary_updates_session ON session_work_summary_updates(session_id, created_at DESC);
`;

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

function toReportSynthesisRequest(row: ReportSynthesisRequestRow): ReportSynthesisRequest {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    scopeType: row.scope_type,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    period: row.period,
    range: { from: row.range_from, to: row.range_to },
    status: row.status,
    requestedAt: row.requested_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    sourceSessionIds: parseJson<string[]>(row.source_session_ids_json, []),
  };
}

function toMetadataBackfillRequest(row: MetadataBackfillRequestRow): MetadataBackfillRequest {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    scopeType: row.scope_type,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    status: row.status,
    requestedAt: row.requested_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    sourceSessionIds: parseJson<string[]>(row.source_session_ids_json, []),
  };
}

function toReportSummary(row: ReportSummaryRow): ReportSummary {
  return {
    id: row.id,
    requestId: row.request_id,
    period: row.period,
    range: { from: row.range_from, to: row.range_to },
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    title: row.title,
    executiveSummary: row.executive_summary,
    themes: parseJson<ReportSummaryBlock[]>(row.themes_json, []),
    highlights: parseJson<ReportSummaryBlock[]>(row.highlights_json, []),
    verification: parseJson<ReportSummaryBlock[]>(row.verification_json, []),
    comparison: parseJson<ReportSummaryBlock[]>(row.comparison_json, []),
    risks: parseJson<ReportSummaryBlock[]>(row.risks_json, []),
    decisions: parseJson<ReportSummaryBlock[]>(row.decisions_json, []),
    nextSteps: parseJson<ReportSummaryBlock[]>(row.next_steps_json, []),
    sourceSessionIds: parseJson<string[]>(row.source_session_ids_json, []),
    generatedByAgent: row.generated_by_agent,
    ...(row.generated_by_model ? { generatedByModel: row.generated_by_model } : {}),
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    isCurrent: row.is_current === 1,
  };
}

function parseUtcCalendarDate(value: string): Date {
  const [year = "0", month = "0", day = "0"] = value.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (!Number.isFinite(date.getTime()) || formatUtcCalendarDate(date) !== value) {
    throw new Error("Report date must use a valid YYYY-MM-DD value.");
  }
  return date;
}

function formatUtcCalendarDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getReportRange(period: ReportPeriod, anchorValue: string): { from: string; to: string } {
  const anchor = parseUtcCalendarDate(anchorValue);
  if (period === "day") {
    const day = formatUtcCalendarDate(anchor);
    return { from: day, to: day };
  }

  if (period === "year") {
    const from = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
    const to = new Date(Date.UTC(anchor.getUTCFullYear(), 11, 31));
    return { from: formatUtcCalendarDate(from), to: formatUtcCalendarDate(to) };
  }

  if (period === "quarter") {
    const quarterMonth = Math.floor(anchor.getUTCMonth() / 3) * 3;
    const from = new Date(Date.UTC(anchor.getUTCFullYear(), quarterMonth, 1));
    const to = new Date(Date.UTC(anchor.getUTCFullYear(), quarterMonth + 3, 0));
    return { from: formatUtcCalendarDate(from), to: formatUtcCalendarDate(to) };
  }

  if (period === "month") {
    const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
    return { from: formatUtcCalendarDate(from), to: formatUtcCalendarDate(to) };
  }

  const mondayOffset = (anchor.getUTCDay() + 6) % 7;
  const from = new Date(anchor);
  from.setUTCDate(from.getUTCDate() - mondayOffset);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 6);
  return { from: formatUtcCalendarDate(from), to: formatUtcCalendarDate(to) };
}

function getPreviousReportRange(period: ReportPeriod, range: ReportRange): ReportRange {
  const from = parseUtcCalendarDate(range.from);
  if (period === "day") {
    from.setUTCDate(from.getUTCDate() - 1);
    const previousDay = formatUtcCalendarDate(from);
    return { from: previousDay, to: previousDay };
  }

  if (period === "year") {
    const previousFrom = new Date(Date.UTC(from.getUTCFullYear() - 1, 0, 1));
    const previousTo = new Date(Date.UTC(from.getUTCFullYear() - 1, 11, 31));
    return { from: formatUtcCalendarDate(previousFrom), to: formatUtcCalendarDate(previousTo) };
  }

  if (period === "quarter") {
    const previousFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 3, 1));
    const previousTo = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 0));
    return { from: formatUtcCalendarDate(previousFrom), to: formatUtcCalendarDate(previousTo) };
  }

  if (period === "month") {
    const previousFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
    const previousTo = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 0));
    return { from: formatUtcCalendarDate(previousFrom), to: formatUtcCalendarDate(previousTo) };
  }

  const previousFrom = new Date(from);
  previousFrom.setUTCDate(previousFrom.getUTCDate() - 7);
  const previousTo = new Date(previousFrom);
  previousTo.setUTCDate(previousTo.getUTCDate() + 6);
  return { from: formatUtcCalendarDate(previousFrom), to: formatUtcCalendarDate(previousTo) };
}

function listCalendarDates(range: ReportRange): string[] {
  const current = parseUtcCalendarDate(range.from);
  const end = parseUtcCalendarDate(range.to);
  const dates: string[] = [];
  while (current <= end) {
    dates.push(formatUtcCalendarDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function listCalendarMonths(range: ReportRange): string[] {
  const current = parseUtcCalendarDate(range.from);
  current.setUTCDate(1);
  const end = parseUtcCalendarDate(range.to);
  end.setUTCDate(1);
  const dates: string[] = [];
  while (current <= end) {
    dates.push(formatUtcCalendarDate(current));
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return dates;
}

function getReportTrendGranularity(period: ReportPeriod): ReportTrendGranularity {
  return period === "quarter" || period === "year" ? "month" : "day";
}

function buildReportTrends(
  period: ReportPeriod,
  range: ReportRange,
  sessions: WorkSessionRecord[],
  eventsBySession: Map<string, ReportEventRow[]>,
): ReportTrendPoint[] {
  const granularity = getReportTrendGranularity(period);
  const dates = granularity === "month" ? listCalendarMonths(range) : listCalendarDates(range);
  return dates.map((date) => {
    const keyLength = granularity === "month" ? 7 : 10;
    const bucketKey = date.slice(0, keyLength);
    const bucketSessions = sessions.filter(
      (session) => toLocalCalendarDate(session.completedAt).slice(0, keyLength) === bucketKey,
    );
    return {
      date,
      sessions: bucketSessions.length,
      events: bucketSessions.reduce((total, session) => total + (eventsBySession.get(session.id)?.length ?? 0), 0),
    };
  });
}

function compareReportMetric(current: number, previous: number): ReportMetricComparison {
  const delta = current - previous;
  return {
    current,
    previous,
    delta,
    direction: delta === 0 ? "flat" : delta > 0 ? "up" : "down",
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

function verificationStatusLabel(status: VerificationSummary["status"]): string {
  return status === "passed" ? "Passed" : status === "failed" ? "Failed" : "未執行";
}

function toMetadataBackfillItem(row: MetadataBackfillRow): MetadataBackfillItem {
  const session = toSession(row);
  const gaps = [
    ...(session.changedFiles.length === 0 ? ["changed_files" as const] : []),
    ...(!session.verification || session.verification.status === "not_run" ? ["verification" as const] : []),
  ];
  return {
    sessionId: session.id,
    projectId: session.projectId,
    projectName: session.projectName ?? session.projectId,
    projectRoot: row.project_root,
    title: session.title,
    completedAt: session.completedAt,
    changedFilesCount: session.changedFiles.length,
    changedFilesProvenanceCount: session.changedFilesProvenance.length,
    changedFileChangesCount: session.changedFileChanges.length,
    changedFiles: session.changedFiles,
    changedFilesProvenance: session.changedFilesProvenance,
    changedFileChanges: session.changedFileChanges,
    verificationStatus: session.verification?.status ?? "not_supplied",
    ...(session.verification ? { verification: session.verification } : {}),
    rawSnapshotCount: row.raw_snapshot_count,
    gaps,
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
  /** Where database backups go (default: `backups/` beside the database) and how many to keep. */
  backup?: { directory?: string; keep?: number };
}

export class WorkIntelligenceStore {
  private readonly db: DatabaseSync;
  private readonly backupOptions: { directory?: string; keep?: number };
  private readonly projects: ProjectRepository;
  private readonly sessions: SessionRepository;
  private readonly knowledge: KnowledgeRepository;
  private readonly graphBuilder: GraphBuilder;
  private readonly handoffImportService = new HandoffImportService();
  private readonly reportBuilder = new ReportBuilder();
  private readonly reportSynthesisRequests: ReportSynthesisRequestRepository;
  private readonly metadataBackfills: MetadataBackfillRepository;
  private readonly searchIndex: SearchRepository;
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
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(schema);
    this.ensureSchemaMigrations();
    this.projects = new ProjectRepository(this.db);
    this.sessions = new SessionRepository(this.db, toSession, createPageInfo);
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
    this.reportSynthesisRequests = new ReportSynthesisRequestRepository(this.db);
    this.metadataBackfills = new MetadataBackfillRepository(this.db);
    this.searchIndex = new SearchRepository(this.db);
    this.knowledgeCandidates = new KnowledgeCandidateService(this.db, {
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      checkProjectById: (projectId) => this.checkProjectById(projectId),
      recordKnowledge: (input) => this.recordKnowledge(input),
    });
    this.policyGate = new ProjectPolicyGate(this);
  }

  private ensureSchemaMigrations(): void {
    this.runImmediateTransaction(() => {
      const columns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name?: string }>;
      const columnNames = new Set(columns.map((column) => column.name));
      if (!columnNames.has("execution_status")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'completed'");
      }
      if (!columnNames.has("changed_files_provenance_json")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN changed_files_provenance_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!columnNames.has("changed_file_changes_json")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN changed_file_changes_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!columnNames.has("work_summary_json")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN work_summary_json TEXT NOT NULL DEFAULT '{}'");
      }
      if (columnNames.has("commit_required")) {
        this.db.exec("ALTER TABLE sessions DROP COLUMN commit_required");
      }

      const reportSummaryColumns = this.db.prepare("PRAGMA table_info(report_summaries)").all() as Array<{
        name?: string;
      }>;
      const reportSummaryColumnNames = new Set(reportSummaryColumns.map((column) => column.name));
      if (!reportSummaryColumnNames.has("themes_json")) {
        this.db.exec("ALTER TABLE report_summaries ADD COLUMN themes_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!reportSummaryColumnNames.has("verification_json")) {
        this.db.exec("ALTER TABLE report_summaries ADD COLUMN verification_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!reportSummaryColumnNames.has("comparison_json")) {
        this.db.exec("ALTER TABLE report_summaries ADD COLUMN comparison_json TEXT NOT NULL DEFAULT '[]'");
      }

      const metadataBackfillTable = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'metadata_backfill_requests'")
        .get() as { sql?: string | null } | undefined;
      if (metadataBackfillTable?.sql && !metadataBackfillTable.sql.includes("'cancelled'")) {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_metadata_backfill_requests_status;
          DROP INDEX IF EXISTS idx_metadata_backfill_requests_scope;
          ALTER TABLE metadata_backfill_requests RENAME TO metadata_backfill_requests_legacy;
          CREATE TABLE metadata_backfill_requests (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'project')),
            project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
            requested_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            failure_reason TEXT,
            source_session_ids_json TEXT NOT NULL DEFAULT '[]'
          );
          INSERT INTO metadata_backfill_requests (
            id, idempotency_key, scope_type, project_id, status, requested_at,
            started_at, completed_at, failure_reason, source_session_ids_json
          )
          SELECT id, idempotency_key, scope_type, project_id, status, requested_at,
            started_at, completed_at, failure_reason, source_session_ids_json
          FROM metadata_backfill_requests_legacy;
          DROP TABLE metadata_backfill_requests_legacy;
          CREATE INDEX idx_metadata_backfill_requests_status ON metadata_backfill_requests(status, requested_at DESC);
          CREATE INDEX idx_metadata_backfill_requests_scope ON metadata_backfill_requests(project_id, status, requested_at DESC);
        `);
      }

      applySchemaMigrations(this.db);
    });
  }

  private runImmediateTransaction<T>(operation: () => T): T {
    return runImmediateSqlTransaction(this.db, operation);
  }

  private checkProjectRoot(projectRoot: string): PolicyDecision {
    return checkTrackedProjectByRoot(this.policyGate, projectRoot);
  }

  private checkProjectById(projectId: string): PolicyDecision {
    return checkTrackedProjectById(this.policyGate, this, projectId);
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
      backups: listDatabaseBackups(this.databasePath, directory),
    };
  }

  /** Writes the whole database to `target` for moving it to another computer; `target` must not exist yet. */
  public exportTo(target: string): { bytes: number } {
    if (this.backupUnavailable()) {
      throw new Error("An in-memory database cannot be exported.");
    }
    return exportDatabase(this.db, target);
  }

  /** Backs up only when there is no backup yet or the newest is a day old; used by the API server's schedule. */
  public backupIfDue(now = new Date()): DatabaseBackupCreated | null {
    if (this.backupUnavailable() || !isBackupDue(this.databasePath, this.backupOptions.directory, now)) {
      return null;
    }
    return backupDatabase(this.db, this.databasePath, { ...this.backupOptions, now });
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

  public previewMetadataBackfill(
    options: {
      projectRoot?: string;
      limit?: number;
    } = {},
  ): MetadataBackfillPreviewResult {
    let project: ProjectRecord | undefined;
    let projectId: string | undefined;
    if (options.projectRoot) {
      const decision = this.checkProjectRoot(options.projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      project = decision.project;
      projectId = project.id;
    }

    const parameters: string[] = [];
    const projectClause = projectId ? " AND s.project_id = ?" : "";
    if (projectId) {
      parameters.push(projectId);
    }
    const scanned = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sessions s JOIN projects p ON p.id = s.project_id " +
          "WHERE p.status = 'tracked' AND s.voided_at IS NULL" +
          projectClause,
      )
      .get(...parameters) as { count: number };
    // SQL pre-filter only drops rows that certainly have no gap (non-empty changed files and a
    // passed/failed verification); toMetadataBackfillItem still decides the exact gaps.
    const rows = this.db
      .prepare(
        "SELECT s.*, p.name AS project_name, p.root_path AS project_root, " +
          "(SELECT COUNT(*) FROM raw_snapshots rs WHERE rs.session_id = s.id) AS raw_snapshot_count " +
          "FROM sessions s JOIN projects p ON p.id = s.project_id " +
          "WHERE p.status = 'tracked' AND s.voided_at IS NULL" +
          projectClause +
          " AND NOT (" +
          "COALESCE(CASE WHEN json_valid(s.changed_files_json) AND json_type(s.changed_files_json) = 'array' " +
          "THEN json_array_length(s.changed_files_json) END, 0) > 0 " +
          "AND COALESCE(CASE WHEN json_valid(s.verification_json) " +
          "THEN json_extract(s.verification_json, '$.status') END, 'not_run') IN ('passed', 'failed')" +
          ") " +
          "ORDER BY s.completed_at DESC, s.id DESC",
      )
      .all(...parameters) as MetadataBackfillRow[];
    const allItems = rows.map(toMetadataBackfillItem).filter((item) => item.gaps.length > 0);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const items = allItems.slice(0, limit);

    return {
      outcome: "backfill_preview",
      project,
      scannedSessions: scanned.count,
      truncated: allItems.length > limit,
      items,
      totals: {
        needsBackfill: allItems.length,
        changedFilesMissing: allItems.filter((item) => item.gaps.includes("changed_files")).length,
        verificationMissing: allItems.filter((item) => item.verificationStatus === "not_supplied").length,
        verificationNotRun: allItems.filter((item) => item.verificationStatus === "not_run").length,
      },
    };
  }

  public createMetadataBackfillRequest(input: CreateMetadataBackfillRequestInput): CreateMetadataBackfillRequestResult {
    this.recoverStaleMetadataBackfillRequests();
    let project: ProjectRecord | undefined;
    if (input.projectId) {
      project = this.getProjectById(input.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: input.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        } satisfies ProjectIdSkippedResult;
      }
      const decision = this.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        } satisfies ProjectIdSkippedResult;
      }
    }

    const preview = this.previewMetadataBackfill({ projectRoot: project?.rootPath, limit: 500 });
    if (preview.outcome !== "backfill_preview") {
      return preview;
    }
    const sourceSessionIds = preview.items.map((item) => item.sessionId);
    if (sourceSessionIds.length === 0) {
      return {
        outcome: "metadata_backfill_not_needed",
        scannedSessions: preview.scannedSessions,
        reason: "目前沒有需要回補的 metadata。",
      };
    }

    const scopeType = project ? "project" : "all";
    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `metadata-backfill-${createHash("sha256")
        .update(`${scopeType}:${project?.id ?? "all"}:${sourceSessionIds.join(",")}`)
        .digest("hex")}`;
    return this.runImmediateTransaction(() => {
      const existingRow = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM metadata_backfill_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.idempotency_key = ?`,
        )
        .get(idempotencyKey) as MetadataBackfillRequestRow | undefined;
      if (existingRow) {
        if (existingRow.status === "cancelled") {
          // A cancelled request must not block a later scan with the same
          // deterministic source set. The retry gets its own idempotency key.
          const retryIdempotencyKey = `${idempotencyKey}:retry:${randomUUID()}`;
          const requestedAt = nowIso();
          const id = randomUUID();
          this.db
            .prepare(
              `INSERT INTO metadata_backfill_requests (
                 id, idempotency_key, scope_type, project_id, status, requested_at, source_session_ids_json
               ) VALUES (@id, @idempotencyKey, @scopeType, @projectId, 'pending', @requestedAt, @sourceSessionIds)`,
            )
            .run({
              id,
              idempotencyKey: retryIdempotencyKey,
              scopeType,
              projectId: project?.id ?? null,
              requestedAt,
              sourceSessionIds: JSON.stringify(sourceSessionIds),
            });
          const retryRow = this.db
            .prepare(
              `SELECT r.*, p.name AS project_name
               FROM metadata_backfill_requests r
               LEFT JOIN projects p ON p.id = r.project_id
               WHERE r.id = ?`,
            )
            .get(id) as MetadataBackfillRequestRow | undefined;
          if (!retryRow) {
            throw new Error("Metadata backfill retry request was inserted but could not be loaded.");
          }
          return {
            outcome: "metadata_backfill_request",
            duplicate: false,
            request: toMetadataBackfillRequest(retryRow),
          };
        }
        return {
          outcome: "metadata_backfill_request",
          duplicate: true,
          request: toMetadataBackfillRequest(existingRow),
        };
      }

      const requestedAt = nowIso();
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO metadata_backfill_requests (
             id, idempotency_key, scope_type, project_id, status, requested_at, source_session_ids_json
           ) VALUES (@id, @idempotencyKey, @scopeType, @projectId, 'pending', @requestedAt, @sourceSessionIds)`,
        )
        .run({
          id,
          idempotencyKey,
          scopeType,
          projectId: project?.id ?? null,
          requestedAt,
          sourceSessionIds: JSON.stringify(sourceSessionIds),
        });
      const row = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM metadata_backfill_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.id = ?`,
        )
        .get(id) as MetadataBackfillRequestRow | undefined;
      if (!row) {
        throw new Error("Metadata backfill request was inserted but could not be loaded.");
      }
      return {
        outcome: "metadata_backfill_request",
        duplicate: false,
        request: toMetadataBackfillRequest(row),
      };
    });
  }

  public listMetadataBackfillRequests(
    options: MetadataBackfillRequestQuery = {},
  ): MetadataBackfillRequestListQueryResult {
    this.recoverStaleMetadataBackfillRequests();
    if (options.projectId) {
      const project = this.getProjectById(options.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: options.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        } satisfies ProjectIdSkippedResult;
      }
      const decision = this.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        } satisfies ProjectIdSkippedResult;
      }
    }

    const clauses = ["(r.project_id IS NULL OR p.status = 'tracked')"];
    const parameters: Array<string | number> = [];
    if (options.scopeType) {
      clauses.push("r.scope_type = ?");
      parameters.push(options.scopeType);
    }
    if (options.projectId) {
      clauses.push("r.project_id = ?");
      parameters.push(options.projectId);
    }
    if (options.status) {
      clauses.push("r.status = ?");
      parameters.push(options.status);
    }
    if (options.requestId) {
      clauses.push("r.id = ?");
      parameters.push(options.requestId);
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const rows = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM metadata_backfill_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY r.requested_at DESC, r.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit) as MetadataBackfillRequestRow[];
    return {
      outcome: "metadata_backfill_requests",
      requests: rows.map(toMetadataBackfillRequest),
    };
  }

  public cancelMetadataBackfillRequest(requestId: string): CancelMetadataBackfillRequestResult {
    this.recoverStaleMetadataBackfillRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM metadata_backfill_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as MetadataBackfillRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId };
    }

    if (row.project_id) {
      const decision = this.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project recording is not enabled.",
        } satisfies ProjectIdSkippedResult;
      }
    }

    const request = toMetadataBackfillRequest(row);
    if (request.status === "cancelled") {
      return { outcome: "metadata_backfill_request_cancelled", duplicate: true, request };
    }
    if (request.status !== "pending" && request.status !== "processing") {
      return {
        outcome: "metadata_backfill_cancel_rejected",
        requestId,
        status: request.status,
        reason: "只有等待 Agent 處理或 Agent 處理中的 metadata 回補可以取消。",
      };
    }

    this.db
      .prepare(
        `UPDATE metadata_backfill_requests
         SET status = 'cancelled', failure_reason = ?, completed_at = NULL
         WHERE id = ? AND status IN ('pending', 'processing')`,
      )
      .run("使用者取消這次 metadata 回補；Session 原有資料保留。", requestId);
    const nextRow = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM metadata_backfill_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as MetadataBackfillRequestRow | undefined;
    if (!nextRow) {
      return { outcome: "not_found", requestId };
    }
    const nextRequest = toMetadataBackfillRequest(nextRow);
    if (nextRequest.status !== "cancelled") {
      return {
        outcome: "metadata_backfill_cancel_rejected",
        requestId,
        status: nextRequest.status,
        reason: "這次 metadata 回補已在取消前被其他流程更新，請重新整理狀態。",
      };
    }
    return { outcome: "metadata_backfill_request_cancelled", duplicate: false, request: nextRequest };
  }

  public getMetadataBackfillContext(
    options: MetadataBackfillRequestContextQuery,
  ): MetadataBackfillRequestContextQueryResult {
    this.recoverStaleMetadataBackfillRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM metadata_backfill_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(options.requestId) as MetadataBackfillRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId: options.requestId };
    }

    const project = row.project_id ? this.getProjectById(row.project_id) : undefined;
    if (row.project_id) {
      const decision = this.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project recording is not enabled.",
        } satisfies ProjectIdSkippedResult;
      }
    }

    const request = toMetadataBackfillRequest(row);
    if (request.status === "cancelled") {
      return {
        outcome: "metadata_backfill_request_not_ready",
        request,
        reason: "這筆 metadata 回補請求已取消；請由使用者重新建立請求後再處理。",
      };
    }
    const preview = this.previewMetadataBackfill({ projectRoot: project?.rootPath, limit: 500 });
    if (preview.outcome !== "backfill_preview") {
      return preview;
    }
    const sourceSessionSet = new Set(request.sourceSessionIds);
    const currentItems = preview.items.filter((item) => sourceSessionSet.has(item.sessionId));
    const currentSessionSet = new Set(currentItems.map((item) => item.sessionId));
    const resolvedSessionIds = request.sourceSessionIds.filter((sessionId) => !currentSessionSet.has(sessionId));

    if (request.status === "pending" && currentItems.length > 0) {
      const startedAt = nowIso();
      this.db
        .prepare(
          "UPDATE metadata_backfill_requests SET status = 'processing', started_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(startedAt, request.id);
      request.status = "processing";
      request.startedAt = startedAt;
    }
    if ((request.status === "pending" || request.status === "processing") && currentItems.length === 0) {
      const completedAt = nowIso();
      this.db
        .prepare(
          "UPDATE metadata_backfill_requests SET status = 'completed', completed_at = ?, failure_reason = NULL WHERE id = ?",
        )
        .run(completedAt, request.id);
      request.status = "completed";
      request.completedAt = completedAt;
    }

    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
    return {
      outcome: "metadata_backfill_context",
      request,
      items: currentItems.slice(0, limit),
      resolvedSessionIds,
      sourceSessionIds: request.sourceSessionIds,
      truncated: currentItems.length > limit,
    };
  }

  public applyMetadataBackfill(input: MetadataBackfillApplyInput): MetadataBackfillBatchResult {
    this.recoverStaleMetadataBackfillRequests();
    let request: MetadataBackfillRequest | undefined;
    if (input.requestId) {
      const requestRow = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM metadata_backfill_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.id = ?`,
        )
        .get(input.requestId) as MetadataBackfillRequestRow | undefined;
      if (!requestRow) {
        throw new Error(`Metadata backfill request was not found: ${input.requestId}`);
      }
      request = toMetadataBackfillRequest(requestRow);
      if (request.status === "cancelled") {
        return {
          outcome: "metadata_backfill_request_not_ready",
          request,
          reason: "這筆 metadata 回補請求已取消；不允許再寫入 Session。",
        };
      }
      if (request.status === "pending") {
        const startedAt = nowIso();
        this.db
          .prepare(
            "UPDATE metadata_backfill_requests SET status = 'processing', started_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(startedAt, request.id);
        request.status = "processing";
        request.startedAt = startedAt;
      }
    }
    const updated: WorkSessionRecord[] = [];
    const skipped: MetadataBackfillSkipped[] = [];
    const failures: MetadataBackfillFailure[] = [];
    const seenSessionIds = new Set<string>();

    for (const update of input.updates) {
      if (seenSessionIds.has(update.sessionId)) {
        failures.push({
          sessionId: update.sessionId,
          reason: "The same sessionId was provided more than once in this batch.",
        });
        continue;
      }
      seenSessionIds.add(update.sessionId);

      try {
        const result = this.updateSessionMetadata(update);
        if (result.outcome === "updated") {
          updated.push(result.session);
        } else if (result.outcome === "skipped") {
          skipped.push({
            sessionId: result.sessionId,
            projectStatus: result.projectStatus,
            reason: result.reason,
          });
        } else {
          failures.push({
            sessionId: result.sessionId,
            reason: "Session was not found.",
          });
        }
      } catch (error) {
        failures.push({
          sessionId: update.sessionId,
          reason: error instanceof Error ? error.message : "Session metadata update failed.",
        });
      }
    }

    let remainingItems: MetadataBackfillItem[] | undefined;
    if (request) {
      const context = this.getMetadataBackfillContext({ requestId: request.id, limit: 500 });
      if (context.outcome === "metadata_backfill_context") {
        request = context.request;
        remainingItems = context.items;
      }
    }

    return {
      outcome: "backfill_applied",
      requestedCount: input.updates.length,
      updated,
      skipped,
      failures,
      ...(request ? { request } : {}),
      ...(remainingItems ? { remainingItems } : {}),
    };
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
    projectId?: string;
    evidencePage?: number;
    evidencePageSize?: number;
    evidenceKind?: ReportEvidenceKind;
    evidenceQuery?: string;
    includeAllEvidence?: boolean;
  }): ReportQueryResult {
    let project: ProjectRecord | undefined;
    if (options.projectId) {
      project = this.getProjectById(options.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: options.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        };
      }
      if (project.status !== "tracked") {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: project.status,
          reason: "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const range = getReportRange(options.period, options.date ?? toLocalCalendarDate());
    const previousRange = getPreviousReportRange(options.period, range);
    const sessions = this.listSessions({
      from: range.from,
      to: range.to,
      projectId: project?.id,
      limit: 200,
      trackedOnly: true,
    });
    const previousSessions = this.listSessions({
      from: previousRange.from,
      to: previousRange.to,
      projectId: project?.id,
      limit: 200,
      trackedOnly: true,
    });
    const sessionIds = sessions.map((session) => session.id);
    const previousSessionIds = previousSessions.map((session) => session.id);
    const eventRows = this.getReportEvents(sessionIds);
    const previousEventRows = this.getReportEvents(previousSessionIds);
    const snapshotRows = sessionIds.length
      ? (this.db
          .prepare(
            `SELECT rs.session_id, rs.source_path
             FROM raw_snapshots rs
             CROSS JOIN projects p ON p.id = rs.project_id
             WHERE p.status = 'tracked'
               AND rs.session_id IN (${sessionIds.map(() => "?").join(", ")})
             ORDER BY rs.captured_at ASC, rs.id ASC`,
          )
          .all(...sessionIds) as ReportSnapshotSummaryRow[])
      : [];
    const attachedEvidenceRows = sessionIds.length
      ? (this.db
          .prepare(
            `SELECT e.*, s.title AS session_title, p.name AS project_name
             FROM evidence e
             CROSS JOIN sessions s ON s.id = e.session_id
             CROSS JOIN projects p ON p.id = e.project_id
             WHERE p.status = 'tracked'
               AND e.voided_at IS NULL
               AND e.session_id IN (${sessionIds.map(() => "?").join(", ")})
             ORDER BY e.captured_at ASC, e.id ASC`,
          )
          .all(...sessionIds) as ReportAttachedEvidenceRow[])
      : [];

    const verification: Record<"passed" | "failed" | "not_run" | "not_supplied", number> = {
      passed: 0,
      failed: 0,
      not_run: 0,
      not_supplied: 0,
    };
    const projectSummaries = new Map<string, ReportProjectSummary>();
    for (const session of sessions) {
      const verificationStatus = session.verification?.status ?? "not_supplied";
      verification[verificationStatus] += 1;
      const existing = projectSummaries.get(session.projectId);
      if (existing) {
        existing.sessionCount += 1;
        existing.sourceSessionIds.push(session.id);
      } else {
        projectSummaries.set(session.projectId, {
          projectId: session.projectId,
          projectName: session.projectName ?? session.projectId,
          sessionCount: 1,
          eventCount: 0,
          sourceSessionIds: [session.id],
        });
      }
    }
    for (const event of eventRows) {
      const summary = projectSummaries.get(event.project_id);
      if (summary) {
        summary.eventCount += 1;
      }
    }

    const currentMetrics = {
      sessions: sessions.length,
      events: eventRows.length,
      changedFiles: sessions.reduce((total, session) => total + session.changedFiles.length, 0),
    };
    const previousMetrics = {
      sessions: previousSessions.length,
      events: previousEventRows.length,
      changedFiles: previousSessions.reduce((total, session) => total + session.changedFiles.length, 0),
    };
    const comparison = {
      sessions: compareReportMetric(currentMetrics.sessions, previousMetrics.sessions),
      events: compareReportMetric(currentMetrics.events, previousMetrics.events),
      changedFiles: compareReportMetric(currentMetrics.changedFiles, previousMetrics.changedFiles),
    };
    const periodScope = project ? `專案「${project.name}」` : `${projectSummaries.size} 個記錄中專案`;
    const periodSummary = sessions.length
      ? `${range.from} 至 ${range.to}，${periodScope}完成 ${sessions.length} 個 Session，留下 ${eventRows.length} 個事件與 ${currentMetrics.changedFiles} 筆檔案變更 metadata。`
      : `${range.from} 至 ${range.to} 沒有可彙整的完成工作。`;

    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const eventsBySession = new Map<string, ReportEventRow[]>();
    for (const event of eventRows) {
      const events = eventsBySession.get(event.session_id) ?? [];
      events.push(event);
      eventsBySession.set(event.session_id, events);
    }
    const snapshotsBySession = new Map<string, ReportSnapshotSummaryRow>();
    for (const snapshot of snapshotRows) {
      if (!snapshotsBySession.has(snapshot.session_id)) {
        snapshotsBySession.set(snapshot.session_id, snapshot);
      }
    }

    const risks: ReportInsight[] = [];
    const notSuppliedSessions = sessions.filter((session) => !session.verification);
    if (notSuppliedSessions.length) {
      risks.push({
        kind: "verification",
        label: "Verification 尚未回報",
        detail: `${notSuppliedSessions.length} 個 Session 沒有結構化 verification；不能只根據文件內容推測結果。`,
        sourceSessionIds: notSuppliedSessions.map((session) => session.id),
      });
    }
    const notRunSessions = sessions.filter((session) => session.verification?.status === "not_run");
    if (notRunSessions.length) {
      risks.push({
        kind: "verification",
        label: "Verification 明確標示未執行",
        detail: `${notRunSessions.length} 個 Session 由 Agent 明確回報 verification 尚未執行；Agent 應再確認是否能補回 passed 或 failed。`,
        sourceSessionIds: notRunSessions.map((session) => session.id),
      });
    }
    const failedSessions = sessions.filter((session) => session.verification?.status === "failed");
    if (failedSessions.length) {
      risks.push({
        kind: "verification",
        label: "Verification 失敗",
        detail: `${failedSessions.length} 個 Session 回報 failed，請回到來源工作檢查驗證事件。`,
        sourceSessionIds: failedSessions.map((session) => session.id),
      });
    }
    const missingHandoffSessions = sessions.filter((session) => !snapshotsBySession.has(session.id));
    if (missingHandoffSessions.length) {
      risks.push({
        kind: "metadata",
        label: "Handoff snapshot 未保存",
        detail: `${missingHandoffSessions.length} 個 Session 沒有可追溯的 raw handoff snapshot。`,
        sourceSessionIds: missingHandoffSessions.map((session) => session.id),
      });
    }
    const missingChangedFilesSessions = sessions.filter((session) => session.changedFiles.length === 0);
    if (missingChangedFilesSessions.length) {
      risks.push({
        kind: "metadata",
        label: "變更檔案 metadata 未提供",
        detail: `${missingChangedFilesSessions.length} 個 Session 沒有 changed files metadata；請由 Agent 檢查工作樹後補回，這不代表工作沒有完成。`,
        sourceSessionIds: missingChangedFilesSessions.map((session) => session.id),
      });
    }

    const decisions: ReportDecision[] = eventRows
      .filter((event) => event.type === "note" || event.type === "closing")
      .sort((left, right) => {
        if (right.occurred_at !== left.occurred_at) {
          return right.occurred_at < left.occurred_at ? -1 : 1;
        }
        return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
      })
      .slice(0, 8)
      .flatMap((event) => {
        const session = sessionById.get(event.session_id);
        return session
          ? [
              {
                sessionId: session.id,
                sessionTitle: session.title,
                projectName: session.projectName,
                summary: event.summary,
                occurredAt: event.occurred_at,
              },
            ]
          : [];
      });

    const trendGranularity = getReportTrendGranularity(options.period);
    const trends = buildReportTrends(options.period, range, sessions, eventsBySession);

    const evidence: ReportEvidence[] = [];
    for (const session of sessions) {
      const snapshot = snapshotsBySession.get(session.id);
      if (snapshot) {
        evidence.push({
          sessionId: session.id,
          sessionTitle: session.title,
          projectName: session.projectName,
          kind: "handoff",
          label: "Handoff snapshot",
          detail: "Closing handoff 已保存為 raw snapshot。",
          reference: snapshot.source_path ?? "captured handoff",
        });
      }
      if (session.verification) {
        evidence.push({
          sessionId: session.id,
          sessionTitle: session.title,
          projectName: session.projectName,
          kind: "verification",
          label: `Verification ${verificationStatusLabel(session.verification.status)}`,
          detail: session.verification.summary ?? "Agent 提供了 verification 狀態。",
        });
      }
      if (session.changedFiles.length) {
        evidence.push({
          sessionId: session.id,
          sessionTitle: session.title,
          projectName: session.projectName,
          kind: "changed-files",
          label: "Changed files metadata",
          detail: `記錄 ${session.changedFiles.length} 個檔案變更；不等同 Git commit。`,
          reference: session.changedFiles.slice(0, 3).join(", "),
        });
      }
      const primaryEvent = (eventsBySession.get(session.id) ?? []).find(
        (event) => event.type === "verification" || event.type === "note" || event.type === "closing",
      );
      if (primaryEvent) {
        evidence.push({
          sessionId: session.id,
          sessionTitle: session.title,
          projectName: session.projectName,
          kind: "event",
          label: `${primaryEvent.type} event`,
          detail: primaryEvent.summary,
          reference: primaryEvent.id,
        });
      }
    }
    for (const item of attachedEvidenceRows) {
      evidence.push({
        sessionId: item.session_id,
        sessionTitle: item.session_title,
        projectName: item.project_name ?? undefined,
        kind: "attached",
        label: `Evidence · ${item.kind}`,
        detail: item.summary ?? item.reference,
        reference: item.reference,
      });
    }

    const filteredEvidence = evidence.filter((item) => {
      if (options.evidenceKind && item.kind !== options.evidenceKind) {
        return false;
      }
      const query = options.evidenceQuery?.trim().toLowerCase();
      if (!query) {
        return true;
      }
      return [item.label, item.detail, item.reference, item.sessionTitle, item.projectName]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(query));
    });
    const evidencePageInfo = createPageInfo(
      options.evidencePage,
      options.evidencePageSize,
      filteredEvidence.length,
      100,
    );
    const pageEvidence = options.includeAllEvidence
      ? filteredEvidence
      : filteredEvidence.slice(
          (evidencePageInfo.page - 1) * evidencePageInfo.pageSize,
          evidencePageInfo.page * evidencePageInfo.pageSize,
        );

    return {
      outcome: "report",
      period: options.period,
      range,
      previousRange,
      timezone: localTimeZone(),
      project,
      periodSummary,
      sourceSessionIds: sessionIds,
      sessions,
      completedWork: sessions.slice(0, 6),
      projects: [...projectSummaries.values()].sort((left, right) => {
        if (right.sessionCount !== left.sessionCount) {
          return right.sessionCount - left.sessionCount;
        }
        return left.projectName < right.projectName ? -1 : left.projectName > right.projectName ? 1 : 0;
      }),
      totals: {
        sessions: currentMetrics.sessions,
        events: eventRows.length,
        changedFiles: currentMetrics.changedFiles,
        verification,
      },
      comparison,
      risks,
      decisions,
      trendGranularity,
      trends,
      evidence: pageEvidence,
      evidencePageInfo,
    };
  }

  public exportReport(options: {
    period: ReportPeriod;
    date?: string;
    projectId?: string;
    format: ReportExportFormat;
    evidencePage?: number;
    evidencePageSize?: number;
    evidenceKind?: ReportEvidenceKind;
    evidenceQuery?: string;
  }): ReportExportResult {
    const report = this.getReport({ ...options, includeAllEvidence: true });
    if (report.outcome !== "report") {
      return report;
    }

    const projectSuffix = report.project ? "-" + this.reportBuilder.filenamePart(report.project.name) : "-all-projects";
    const baseName =
      "work-report-" + report.period + "-" + report.range.from + "-to-" + report.range.to + projectSuffix;
    const contentType = options.format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8";
    const content =
      options.format === "json" ? JSON.stringify(report, null, 2) + "\n" : this.reportBuilder.toMarkdown(report);

    return {
      outcome: "report_export",
      format: options.format,
      filename: baseName + (options.format === "json" ? ".json" : ".md"),
      contentType,
      content,
      report,
    };
  }

  private recoverStaleReportSynthesisRequests(): void {
    this.reportSynthesisRequests.recoverStale();
  }

  private recoverStaleMetadataBackfillRequests(): void {
    this.metadataBackfills.recoverStale();
  }

  public createReportSynthesisRequest(input: CreateReportSynthesisRequestInput): CreateReportSynthesisRequestResult {
    this.recoverStaleReportSynthesisRequests();
    let project: ProjectRecord | undefined;
    if (input.projectId) {
      project = this.getProjectById(input.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: input.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        };
      }
      const decision = this.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const range = getReportRange(input.period, input.date ?? toLocalCalendarDate());
    const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();

    const report = this.getReport({
      period: input.period,
      date: input.date,
      projectId: project?.id,
      evidencePage: 1,
      evidencePageSize: 100,
      includeAllEvidence: true,
    });
    if (report.outcome !== "report") {
      return report;
    }

    const requestedAt = nowIso();
    const id = randomUUID();
    return this.runImmediateTransaction(() => {
      const existingRow = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM report_synthesis_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.idempotency_key = ?`,
        )
        .get(idempotencyKey) as ReportSynthesisRequestRow | undefined;
      if (existingRow) {
        return {
          outcome: "report_synthesis_request",
          duplicate: true,
          request: toReportSynthesisRequest(existingRow),
        };
      }

      this.db
        .prepare(
          `INSERT INTO report_synthesis_requests (
             id, idempotency_key, scope_type, project_id, period, range_from, range_to,
             status, requested_at, source_session_ids_json
           ) VALUES (@id, @idempotencyKey, @scopeType, @projectId, @period, @rangeFrom, @rangeTo,
                     'pending', @requestedAt, @sourceSessionIds)`,
        )
        .run({
          id,
          idempotencyKey,
          scopeType: project ? "project" : "all",
          projectId: project?.id ?? null,
          period: input.period,
          rangeFrom: range.from,
          rangeTo: range.to,
          requestedAt,
          sourceSessionIds: JSON.stringify(report.sourceSessionIds),
        });

      const row = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM report_synthesis_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.id = ?`,
        )
        .get(id) as ReportSynthesisRequestRow | undefined;
      if (!row) {
        throw new Error("Report synthesis request was inserted but could not be loaded.");
      }
      return {
        outcome: "report_synthesis_request",
        duplicate: false,
        request: toReportSynthesisRequest(row),
      };
    });
  }

  public listReportSynthesisRequests(options: ReportSynthesisRequestQuery = {}): ReportSynthesisRequestListQueryResult {
    this.recoverStaleReportSynthesisRequests();
    if (options.projectId) {
      const project = this.getProjectById(options.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: options.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        };
      }
      const decision = this.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const clauses = ["(r.project_id IS NULL OR p.status = 'tracked')"];
    const parameters: Array<string | number> = [];
    if (options.projectId) {
      clauses.push("r.project_id = ?");
      parameters.push(options.projectId);
    }
    if (options.scopeType) {
      clauses.push("r.scope_type = ?");
      parameters.push(options.scopeType);
    }
    if (options.requestId) {
      clauses.push("r.id = ?");
      parameters.push(options.requestId);
    }
    if (options.status) {
      clauses.push("r.status = ?");
      parameters.push(options.status);
    }
    if (options.period) {
      clauses.push("r.period = ?");
      parameters.push(options.period);
      if (options.date) {
        const range = getReportRange(options.period, options.date);
        clauses.push("r.range_from = ?", "r.range_to = ?");
        parameters.push(range.from, range.to);
      }
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const rows = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY r.requested_at DESC, r.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit) as ReportSynthesisRequestRow[];
    return {
      outcome: "report_synthesis_requests",
      requests: rows.map(toReportSynthesisRequest),
    };
  }

  public getReportSynthesisRequest(requestId: string): ReportSynthesisRequestLookupResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId };
    }
    if (row.project_id) {
      const decision = this.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }
    const summaryRow = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM report_summaries s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.request_id = ? AND s.is_current = 1
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 1`,
      )
      .get(requestId) as ReportSummaryRow | undefined;
    const result: ReportSynthesisRequestDetailResult = {
      outcome: "report_synthesis_request_detail",
      request: toReportSynthesisRequest(row),
    };
    if (summaryRow) {
      result.summary = toReportSummary(summaryRow);
    }
    return result;
  }

  public retryReportSynthesisRequest(requestId: string): RetryReportSynthesisRequestResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId };
    }

    if (row.project_id) {
      const decision = this.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const request = toReportSynthesisRequest(row);
    if (request.status !== "failed" && request.status !== "cancelled") {
      return {
        outcome: "report_synthesis_retry_rejected",
        requestId,
        status: request.status,
        reason:
          request.status === "processing"
            ? "The report synthesis request is still processing. Wait for the timeout recovery or let the Agent finish before retrying."
            : "Only failed or cancelled report synthesis requests can be retried.",
      };
    }

    const nextRequestId = randomUUID();
    const nextIdempotencyKey = `${request.idempotencyKey}:retry:${nextRequestId}`;
    const requestedAt = nowIso();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE report_synthesis_requests
           SET status = 'cancelled', failure_reason = ?
           WHERE id = ? AND status IN ('failed', 'cancelled')`,
        )
        .run(`Superseded by retry request ${nextRequestId}.`, request.id);
      this.db
        .prepare(
          `INSERT INTO report_synthesis_requests (
             id, idempotency_key, scope_type, project_id, period, range_from, range_to,
             status, requested_at, source_session_ids_json
           ) VALUES (@id, @idempotencyKey, @scopeType, @projectId, @period, @rangeFrom, @rangeTo,
                     'pending', @requestedAt, @sourceSessionIds)`,
        )
        .run({
          id: nextRequestId,
          idempotencyKey: nextIdempotencyKey,
          scopeType: request.scopeType,
          projectId: request.projectId ?? null,
          period: request.period,
          rangeFrom: request.range.from,
          rangeTo: request.range.to,
          requestedAt,
          sourceSessionIds: JSON.stringify(request.sourceSessionIds),
        });
      const nextRow = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM report_synthesis_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.id = ?`,
        )
        .get(nextRequestId) as ReportSynthesisRequestRow | undefined;
      if (!nextRow) {
        throw new Error("Report synthesis retry request was inserted but could not be loaded.");
      }
      this.db.exec("COMMIT");
      return {
        outcome: "report_synthesis_request_retried",
        previousRequestId: request.id,
        request: toReportSynthesisRequest(nextRow),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public cancelReportSynthesisRequest(requestId: string): CancelReportSynthesisRequestResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId };
    }

    if (row.project_id) {
      const decision = this.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const request = toReportSynthesisRequest(row);
    if (request.status === "cancelled") {
      return { outcome: "report_synthesis_request_cancelled", duplicate: true, request };
    }
    if (request.status !== "pending" && request.status !== "processing") {
      return {
        outcome: "report_synthesis_cancel_rejected",
        requestId,
        status: request.status,
        reason: "只有等待 Agent 處理或 Agent 處理中的報告提煉可以取消。",
      };
    }

    this.db
      .prepare(
        `UPDATE report_synthesis_requests
         SET status = 'cancelled', failure_reason = ?, completed_at = NULL
         WHERE id = ? AND status IN ('pending', 'processing')`,
      )
      .run("使用者取消這次報告提煉；既有摘要與歷史版本保留。", requestId);
    const nextRow = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as ReportSynthesisRequestRow | undefined;
    if (!nextRow) {
      return { outcome: "not_found", requestId };
    }
    const nextRequest = toReportSynthesisRequest(nextRow);
    if (nextRequest.status !== "cancelled") {
      return {
        outcome: "report_synthesis_cancel_rejected",
        requestId,
        status: nextRequest.status,
        reason: "這次報告提煉已在取消前被其他流程更新，請重新整理狀態。",
      };
    }
    return { outcome: "report_synthesis_request_cancelled", duplicate: false, request: nextRequest };
  }

  public getReportSynthesisContext(options: ReportSynthesisContextQuery): ReportSynthesisContextQueryResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(options.requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId: options.requestId };
    }

    if (row.project_id) {
      const decision = this.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const request = toReportSynthesisRequest(row);
    if (request.status === "cancelled") {
      return {
        outcome: "report_synthesis_request_not_ready",
        request,
        reason: "這次報告提煉已取消；請建立新的提煉請求後再取得報告 Context。",
      };
    }
    if (request.status === "pending") {
      const startedAt = nowIso();
      this.db
        .prepare(
          "UPDATE report_synthesis_requests SET status = 'processing', started_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(startedAt, request.id);
      request.status = "processing";
      request.startedAt = startedAt;
    }

    const maxEvidence = Math.min(Math.max(Math.trunc(options.maxEvidence ?? 40), 1), 100);
    const reportResult = this.getReport({
      period: request.period,
      date: request.range.from,
      projectId: request.projectId,
      evidencePage: 1,
      evidencePageSize: maxEvidence,
    });
    if (reportResult.outcome !== "report") {
      return reportResult;
    }

    const maxSessions = Math.min(Math.max(Math.trunc(options.maxSessions ?? 24), 1), 100);
    const sourceSessionSet = new Set(request.sourceSessionIds);
    const availableSessions = reportResult.sessions.filter((session) => sourceSessionSet.has(session.id));
    const sessions = availableSessions.slice(0, maxSessions);
    const selectedSessionIds = new Set(sessions.map((session) => session.id));
    const handoffRows = selectedSessionIds.size
      ? (this.db
          .prepare(
            `SELECT rs.*, s.title AS session_title, p.name AS project_name
             FROM raw_snapshots rs
             CROSS JOIN sessions s ON s.id = rs.session_id
             CROSS JOIN projects p ON p.id = rs.project_id
             WHERE p.status = 'tracked'
               AND rs.session_id IN (${[...selectedSessionIds].map(() => "?").join(", ")})
             ORDER BY rs.captured_at ASC, rs.id ASC`,
          )
          .all(...selectedSessionIds) as Array<SnapshotRow & { session_title: string; project_name: string }>)
      : [];
    const maxHandoffCharacters = Math.min(Math.max(Math.trunc(options.maxHandoffCharacters ?? 40_000), 1_000), 200_000);
    let remainingCharacters = maxHandoffCharacters;
    const handoffSummaries = handoffRows.flatMap((snapshot) => {
      if (remainingCharacters <= 0) {
        return [];
      }
      const content = snapshot.content.slice(0, remainingCharacters);
      remainingCharacters -= content.length;
      return [
        {
          sessionId: snapshot.session_id,
          sessionTitle: snapshot.session_title,
          projectName: snapshot.project_name,
          ...(snapshot.source_path ? { sourcePath: snapshot.source_path } : {}),
          content,
        },
      ];
    });
    const totalHandoffCharacters = selectedSessionIds.size
      ? Number(
          (
            this.db
              .prepare(
                `SELECT COALESCE(SUM(LENGTH(rs.content)), 0) AS total
               FROM raw_snapshots rs
               CROSS JOIN projects p ON p.id = rs.project_id
               WHERE p.status = 'tracked'
                 AND rs.session_id IN (${[...selectedSessionIds].map(() => "?").join(", ")})`,
              )
              .get(...selectedSessionIds) as { total: number }
          ).total,
        )
      : 0;
    const contextEvidence = reportResult.evidence.filter((item) => selectedSessionIds.has(item.sessionId));
    const contextSourceSessionIds = request.sourceSessionIds.filter((sessionId) => selectedSessionIds.has(sessionId));
    const contextReport: WorkReport = {
      ...reportResult,
      sourceSessionIds: contextSourceSessionIds,
      sessions,
      completedWork: sessions.slice(0, 6),
      evidence: contextEvidence,
      evidencePageInfo: createPageInfo(1, Math.max(contextEvidence.length, 1), contextEvidence.length, 100),
    };
    const context: ReportSynthesisContextResult = {
      outcome: "report_context",
      request,
      report: contextReport,
      sessions,
      handoffSummaries,
      sourceSessionIds: contextSourceSessionIds,
      truncation: {
        sessions: availableSessions.length > sessions.length,
        evidence: reportResult.evidencePageInfo.total > contextEvidence.length,
        handoffCharacters: totalHandoffCharacters > maxHandoffCharacters,
      },
    };
    return context;
  }

  public saveReportSummary(input: SaveReportSummaryInput): SaveReportSummaryResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(input.requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId: input.requestId };
    }

    if (row.project_id) {
      const decision = this.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const existingRow = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM report_summaries s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.request_id = ? AND s.is_current = 1
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 1`,
      )
      .get(input.requestId) as ReportSummaryRow | undefined;
    if (existingRow && row.status === "completed") {
      return { outcome: "report_summary_saved", duplicate: true, summary: toReportSummary(existingRow) };
    }

    if (row.status === "failed" || row.status === "cancelled") {
      const result: ReportSummaryRequestNotReadyResult = {
        outcome: "report_summary_request_not_ready",
        requestId: row.id,
        status: row.status,
        reason:
          row.status === "failed"
            ? "The report synthesis request failed or timed out. Retry the request before saving a summary."
            : "The report synthesis request was superseded by a retry and can no longer accept a summary.",
      };
      return result;
    }

    const request = toReportSynthesisRequest(row);
    const allowedSourceIds = new Set(request.sourceSessionIds);
    const sourceSessionIds = [...new Set(input.sourceSessionIds)];
    const invalidSourceId = sourceSessionIds.find((sessionId) => !allowedSourceIds.has(sessionId));
    if (invalidSourceId) {
      throw new Error(`Summary sourceSessionIds must belong to the synthesis request: ${invalidSourceId}`);
    }
    if (sourceSessionIds.length > 0) {
      const trackedCount = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sessions s
           CROSS JOIN projects p ON p.id = s.project_id
           WHERE p.status = 'tracked'
             AND s.id IN (${sourceSessionIds.map(() => "?").join(", ")})`,
        )
        .get(...sourceSessionIds) as { count: number };
      if (trackedCount.count !== sourceSessionIds.length) {
        throw new Error("Summary sourceSessionIds must reference tracked projects only.");
      }
    }

    const summary: ReportSummary = {
      id: randomUUID(),
      requestId: request.id,
      period: request.period,
      range: request.range,
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.projectName ? { projectName: request.projectName } : {}),
      title: input.title.trim(),
      executiveSummary: input.executiveSummary.trim(),
      themes: input.themes ?? [],
      highlights: input.highlights,
      verification: input.verification ?? [],
      comparison: input.comparison ?? [],
      risks: input.risks,
      decisions: input.decisions,
      nextSteps: input.nextSteps,
      sourceSessionIds,
      generatedByAgent: input.generatedByAgent.trim(),
      ...(input.generatedByModel?.trim() ? { generatedByModel: input.generatedByModel.trim() } : {}),
      promptVersion: input.promptVersion.trim(),
      createdAt: nowIso(),
      isCurrent: true,
    };

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE report_summaries
           SET is_current = 0
           WHERE period = ? AND range_from = ? AND range_to = ?
             AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))`,
        )
        .run(
          request.period,
          request.range.from,
          request.range.to,
          request.projectId ?? null,
          request.projectId ?? null,
        );
      this.db
        .prepare(
          `INSERT INTO report_summaries (
             id, request_id, period, range_from, range_to, project_id, title, executive_summary,
             themes_json, highlights_json, verification_json, comparison_json, risks_json, decisions_json,
             next_steps_json, source_session_ids_json,
             generated_by_agent, generated_by_model, prompt_version, created_at, is_current
           ) VALUES (
             @id, @requestId, @period, @rangeFrom, @rangeTo, @projectId, @title, @executiveSummary,
             @themes, @highlights, @verification, @comparison, @risks, @decisions, @nextSteps, @sourceSessionIds,
             @generatedByAgent, @generatedByModel, @promptVersion, @createdAt, 1
           )`,
        )
        .run({
          id: summary.id,
          requestId: summary.requestId,
          period: summary.period,
          rangeFrom: summary.range.from,
          rangeTo: summary.range.to,
          projectId: summary.projectId ?? null,
          title: summary.title,
          executiveSummary: summary.executiveSummary,
          themes: JSON.stringify(summary.themes),
          highlights: JSON.stringify(summary.highlights),
          verification: JSON.stringify(summary.verification),
          comparison: JSON.stringify(summary.comparison),
          risks: JSON.stringify(summary.risks),
          decisions: JSON.stringify(summary.decisions),
          nextSteps: JSON.stringify(summary.nextSteps),
          sourceSessionIds: JSON.stringify(summary.sourceSessionIds),
          generatedByAgent: summary.generatedByAgent,
          generatedByModel: summary.generatedByModel ?? null,
          promptVersion: summary.promptVersion,
          createdAt: summary.createdAt,
        });
      this.db
        .prepare(
          "UPDATE report_synthesis_requests SET status = 'completed', completed_at = ?, failure_reason = NULL WHERE id = ?",
        )
        .run(summary.createdAt, request.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { outcome: "report_summary_saved", duplicate: false, summary };
  }

  public listReportSummaries(options: ReportSummaryQuery = {}): ReportSummaryQueryResult {
    if (options.projectId) {
      const project = this.getProjectById(options.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: options.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        };
      }
      const decision = this.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const clauses = ["(s.project_id IS NULL OR p.status = 'tracked')"];
    const parameters: Array<string | number> = [];
    if (options.projectId) {
      clauses.push("s.project_id = ?");
      parameters.push(options.projectId);
    }
    if (options.scopeType) {
      clauses.push("s.request_id IN (SELECT id FROM report_synthesis_requests WHERE scope_type = ?)");
      parameters.push(options.scopeType);
    }
    if (options.period) {
      clauses.push("s.period = ?");
      parameters.push(options.period);
      if (options.date) {
        const range = getReportRange(options.period, options.date);
        clauses.push("s.range_from = ?", "s.range_to = ?");
        parameters.push(range.from, range.to);
      }
    }
    if (options.requestId) {
      clauses.push("s.request_id = ?");
      parameters.push(options.requestId);
    }
    if (options.currentOnly !== false) {
      clauses.push("s.is_current = 1");
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const rows = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM report_summaries s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit) as ReportSummaryRow[];
    const result: ReportSummaryListResult = { outcome: "report_summaries", summaries: rows.map(toReportSummary) };
    return result;
  }

  public deleteReportSummary(summaryId: string): DeleteReportSummaryResult {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM report_summaries s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(summaryId) as ReportSummaryRow | undefined;
    if (!row) {
      return { outcome: "not_found", summaryId };
    }

    if (row.project_id) {
      const decision = this.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    if (row.is_current === 1) {
      return {
        outcome: "report_summary_delete_rejected",
        summaryId,
        reason: "目前使用中的報告版本不能移除；請保留至少一個目前版本。",
      };
    }

    this.db.prepare("DELETE FROM report_summaries WHERE id = ? AND is_current = 0").run(summaryId);
    return { outcome: "report_summary_deleted", summaryId, deleted: true };
  }

  private getReportEvents(sessionIds: string[]): ReportEventRow[] {
    if (!sessionIds.length) {
      return [];
    }

    // CROSS JOIN pins the join order in SQLite: drive from the session-id list instead of letting
    // the planner walk every tracked project's sessions first. Used the same way for the other
    // IN-list report/synthesis queries and the recent-decision lookup.
    return this.db
      .prepare(
        `SELECT e.*, s.project_id
         FROM work_events e
         CROSS JOIN sessions s ON s.id = e.session_id
         CROSS JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked'
           AND e.session_id IN (${sessionIds.map(() => "?").join(", ")})
         ORDER BY e.occurred_at ASC, e.id ASC`,
      )
      .all(...sessionIds) as ReportEventRow[];
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
      this.runImmediateTransaction(() => {
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
    return this.runImmediateTransaction(() => {
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
    const updatedAt = nowIso();
    const nextVerification = input.verification ? normalizeVerification(input.verification) : undefined;
    this.runImmediateTransaction(() => {
      if (nextVerification && !sameVerification(current.verification, nextVerification)) {
        this.insertVerificationUpdate(input.sessionId, "agent", current.verification, nextVerification, updatedAt);
      }
      this.db
        .prepare(
          `UPDATE sessions
           SET changed_files_json = @changedFiles,
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

    return this.runImmediateTransaction(() => {
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

    return this.runImmediateTransaction(() => {
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
      .prepare("SELECT * FROM evidence WHERE session_id = ? ORDER BY captured_at ASC, id ASC")
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
          .prepare("SELECT * FROM session_verification_updates WHERE session_id = ? ORDER BY created_at DESC, id DESC")
          .all(sessionId) as VerificationUpdateRow[]
      ).map(toVerificationUpdate),
      voidHistory: (
        this.db
          .prepare("SELECT * FROM void_audit WHERE session_id = ? ORDER BY occurred_at DESC, id DESC")
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
    return this.runImmediateTransaction(() => {
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
    return this.runImmediateTransaction(() => {
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
    return this.runImmediateTransaction(() => {
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
    return this.runImmediateTransaction(() => {
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
    const normalizedChangedFileChanges = normalizeChangedFileChanges(
      project.rootPath,
      input.changedFileChanges,
      pathResolver,
    );
    const normalizedChangedFiles = normalizeChangedFiles(
      project.rootPath,
      [...(input.changedFiles ?? []), ...changedFilePathsFromChanges(normalizedChangedFileChanges)],
      input.changedFilesProvenance,
      pathResolver,
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

    return this.runImmediateTransaction(() => {
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
          changedFilesFollowUp: getChangedFilesFollowUp(existing),
          workSummaryFollowUp: getWorkSummaryFollowUp(existing),
        };
      }

      this.db
        .prepare(
          `INSERT INTO sessions (
             id, project_id, external_session_id, idempotency_key, title, summary,
             work_summary_json, status, execution_status, completed_at, created_at, commit_sha, git_branch,
             changed_files_json, changed_files_provenance_json, changed_file_changes_json, verification_json,
             started_at, updated_at
           ) VALUES (
             @id, @projectId, @externalSessionId, @idempotencyKey, @title, @summary,
             @workSummary, 'finalized', 'completed', @completedAt, @createdAt, @commitSha, @gitBranch,
             @changedFiles, @changedFilesProvenance, @changedFileChanges, @verification,
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
    if (projectRoot) {
      const decision = this.checkProjectRoot(projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }

      return this.buildContext(decision.project, focus);
    }

    const projects = this.listProjects().filter((project) => project.status === "tracked");
    const relevant = this.getRelevantContext(focus);
    return {
      outcome: "context",
      projects,
      recentSessions: this.listSessions({ limit: 12, trackedOnly: true }).map(toSessionDigest),
      recentDecisions: this.getRecentDecisions(),
      recentKnowledge: this.getRecentKnowledge(),
      metadataFollowUps: this.getMetadataFollowUps(),
      pendingRequests: this.getPendingRequests(),
      ...(relevant ? { relevant } : {}),
    };
  }

  /**
   * Ranked retrieval across Sessions (including raw handoff sections) and active Knowledge of tracked
   * projects. Returns compact hits; read full records with getSessionDetailForAgent or searchKnowledge.
   */
  public recall(input: { q?: string; paths?: string[]; projectRoot?: string; limit?: number }): RecallQueryResult {
    let project: ProjectRecord | undefined;
    if (input.projectRoot) {
      const decision = this.checkProjectRoot(input.projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      project = decision.project;
    }
    const result = this.searchIndex.recall({
      q: input.q,
      paths: input.paths,
      projectId: project?.id,
      limit: Math.min(Math.max(input.limit ?? RECALL_DEFAULT_LIMIT, 1), RECALL_MAX_LIMIT),
    });
    return {
      outcome: "recall",
      ...(project ? { project } : {}),
      ...result,
      hits: result.hits.map((hit) => this.withRelatedSessions(hit)),
    };
  }

  private withRelatedSessions(hit: RecallHit): RecallHit {
    if (hit.type === "knowledge") {
      const row = this.db.prepare("SELECT k.*, NULL AS project_name FROM knowledge k WHERE k.id = ?").get(hit.id) as
        KnowledgeRow | undefined;
      const knowledge = row ? this.withKnowledgeTrust(toKnowledge(row)) : undefined;
      return {
        ...hit,
        ...(knowledge?.possiblyStale ? { possiblyStale: true } : {}),
        ...(knowledge?.review ? { needsReview: true } : {}),
      };
    }
    const related = this.getSessionLinks(hit.id)
      .filter((link) => !link.voided)
      .map((link) => ({ id: link.sessionId, title: link.title, relation: link.relation }));
    return related.length > 0 ? { ...hit, related } : hit;
  }

  public search(query: string, projectRoot?: string): SearchResult[] | SkippedResult {
    let projectId: string | undefined;
    if (projectRoot) {
      const decision = this.checkProjectRoot(projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      projectId = decision.project.id;
    }

    const { hits } = this.searchIndex.recall({ q: query, projectId, types: ["session"], limit: SEARCH_LIMIT });
    return hits.flatMap((hit) => {
      const record = this.getSessionById(hit.id);
      if (!record) {
        return [];
      }
      return [
        {
          session: toSessionDigest(record),
          matchedIn: hit.matchedIn[0] ?? "title",
          ...(hit.section ? { section: hit.section } : {}),
          excerpt: hit.excerpt,
        },
      ];
    });
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

  private buildContext(project: ProjectRecord, focus: ContextFocus): ContextResult {
    const relevant = this.getRelevantContext(focus, project.id);
    return {
      outcome: "context",
      project,
      projects: [project],
      recentSessions: this.listSessions({ projectId: project.id, limit: 12, trackedOnly: true }).map(toSessionDigest),
      recentDecisions: this.getRecentDecisions(project.id),
      recentKnowledge: this.getRecentKnowledge(project.id),
      metadataFollowUps: this.getMetadataFollowUps(project.id),
      pendingRequests: this.getPendingRequests(project.id),
      ...(relevant ? { relevant } : {}),
    };
  }

  /** Records ranked for the task and paths an Agent is about to work on; undefined without a focus. */
  private getRelevantContext(focus: ContextFocus, projectId?: string): RelevantContext | undefined {
    const task = focus.task?.trim();
    const paths = (focus.paths ?? []).map((path) => path.trim()).filter(Boolean);
    if (!task && paths.length === 0) {
      return undefined;
    }
    const recalled = this.searchIndex.recall({ q: task, paths, projectId, limit: 20 });
    const termHits = recalled.termHits;
    const hits = recalled.hits.map((hit) => this.withRelatedSessions(hit));
    const knowledge = hits.filter((hit) => hit.type === "knowledge").slice(0, RELEVANT_LIMIT);
    const sessions = hits
      .filter((hit) => hit.type === "session")
      .slice(0, RELEVANT_LIMIT)
      .flatMap((hit) => {
        const record = this.getSessionById(hit.id);
        return record ? [{ hit, record }] : [];
      });
    const decisions = sessions
      .flatMap(({ record }) =>
        (record.workSummary?.decisions ?? [])
          .filter((text) => text.trim().length > 0)
          .map((text) => ({
            sessionId: record.id,
            sessionTitle: record.title,
            completedAt: record.completedAt,
            text: truncateText(text, DIGEST_ITEM_LENGTH),
          })),
      )
      .slice(0, RECENT_DECISION_LIMIT);
    return {
      ...(task ? { task } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      knowledge,
      decisions,
      sessions: sessions.map(({ hit, record }) => ({ ...hit, openItems: toSessionDigest(record).openItems })),
      ...(termHits ? { termHits } : {}),
    };
  }

  /** Pending/processing requests an Agent could pick up; a project scope also includes its "all projects" requests. */
  private getPendingRequests(projectId?: string): ContextResult["pendingRequests"] {
    const active = new Set(["pending", "processing"]);
    const inScope = (request: { projectId?: string }) =>
      !projectId || !request.projectId || request.projectId === projectId;
    const byNewest = (left: { requestedAt: string }, right: { requestedAt: string }) =>
      right.requestedAt.localeCompare(left.requestedAt);
    const reports = this.listReportSynthesisRequests({ limit: 100 });
    const backfills = this.listMetadataBackfillRequests({ limit: 100 });
    return {
      reportSynthesis:
        reports.outcome === "report_synthesis_requests"
          ? reports.requests
              .filter((request) => active.has(request.status) && inScope(request))
              .sort(byNewest)
              .slice(0, 5)
          : [],
      metadataBackfill:
        backfills.outcome === "metadata_backfill_requests"
          ? backfills.requests
              .filter((request) => active.has(request.status) && inScope(request))
              .sort(byNewest)
              .slice(0, 5)
          : [],
      knowledgeCandidates: this.knowledgeCandidates.openRequests(projectId),
    };
  }

  private getMetadataFollowUps(projectId?: string): ContextResult["metadataFollowUps"] {
    const projectRoot = projectId ? this.getProjectById(projectId)?.rootPath : undefined;
    const preview = this.previewMetadataBackfill({ projectRoot, limit: 1 });
    return preview.outcome === "backfill_preview"
      ? preview.totals
      : { needsBackfill: 0, changedFilesMissing: 0, verificationMissing: 0, verificationNotRun: 0 };
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

  private getRecentKnowledge(projectId?: string): KnowledgeDigest[] {
    const result = this.searchKnowledge({ projectId, status: "active", limit: 12 });
    return result.outcome === "knowledge" ? result.items.map(toKnowledgeDigest) : [];
  }

  /*
   * Decisions come from workSummary.decisions, the confirmed technical decisions an Agent wrote at
   * finalize. note/closing events are not used: they mostly record process state (commits,
   * worktree status), not decisions.
   */
  private getRecentDecisions(projectId?: string): DecisionDigest[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.completed_at, json_extract(s.work_summary_json, '$.decisions') AS decisions_json
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked'
           AND s.voided_at IS NULL
           ${projectId ? "AND p.id = ?" : ""}
           AND json_valid(s.work_summary_json)
           AND json_type(s.work_summary_json, '$.decisions') = 'array'
           AND json_array_length(s.work_summary_json, '$.decisions') > 0
         ORDER BY s.completed_at DESC, s.id DESC
         LIMIT ${RECENT_DECISION_LIMIT}`,
      )
      .all(...(projectId ? [projectId] : [])) as Array<{
      id: string;
      title: string;
      completed_at: string;
      decisions_json: string;
    }>;
    return rows
      .flatMap((row) =>
        parseJson<unknown[]>(row.decisions_json, [])
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((text) => ({
            sessionId: row.id,
            sessionTitle: row.title,
            completedAt: row.completed_at,
            text: truncateText(text, DIGEST_ITEM_LENGTH),
          })),
      )
      .slice(0, RECENT_DECISION_LIMIT);
  }
}
