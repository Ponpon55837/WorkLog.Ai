import type { KnowledgePageSize, KnowledgePageSplitSuggestion } from "./knowledge-page-limits.js";

export * from "./applies-to.js";
export * from "./attention.js";
export * from "./file-history.js";
export * from "./knowledge-page-limits.js";
export * from "./list-search-terms.js";
export * from "./project-data-columns.js";
export * from "./related-work.js";
export * from "./report-presentation.js";
export * from "./usage.js";

export const PROJECT_STATUSES = ["unregistered", "tracked", "paused", "ignored"] as const;

export const API_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "conflict",
  "payload_too_large",
  "unsupported_media_type",
  "host_not_allowed",
  "origin_not_allowed",
  "service_unavailable",
  "internal_error",
  "project_not_found",
  "invalid_bundle",
  "unsupported_schema",
  "invalid_project_deletion_confirmation",
  "project_location_confirmation_required",
  "project_location_conflict",
  "project_location_invalid",
  "backup_unavailable",
  "backup_worker_out_of_memory",
  "database_busy",
  "database_read_only",
  "database_disk_full",
  "server_restart_required",
  "project_name_mismatch",
  "project_backup_failed",
  "project_delete_failed",
  "session_not_found",
  "session_not_voided",
  "session_cited_by_pending_cleanup",
  "session_backup_failed",
  "session_delete_failed",
  "knowledge_page_not_found",
  "knowledge_page_default",
  "convention_limit_reached",
  "usage_timeout",
  "usage_cancelled",
  "usage_failed",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type PolicyStatus = ProjectStatus | "unregistered";

export const WORK_EVENT_TYPES = ["planning", "execution", "verification", "closing", "note", "finalized"] as const;

export type WorkEventType = (typeof WORK_EVENT_TYPES)[number];
export const VERIFICATION_STATUSES = ["passed", "failed", "in_progress", "not_run"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type ReportVerificationStatus = VerificationStatus | "not_supplied";
export const CHANGED_FILE_SOURCES = ["agent", "handoff", "git", "worktree"] as const;
export type ChangedFileSource = (typeof CHANGED_FILE_SOURCES)[number];
export const CHANGED_FILES_MODES = ["replace", "merge"] as const;
export type ChangedFilesMode = (typeof CHANGED_FILES_MODES)[number];
export const CHANGED_FILE_CHANGE_STATUSES = ["added", "modified", "deleted", "renamed"] as const;
export type ChangedFileChangeStatus = (typeof CHANGED_FILE_CHANGE_STATUSES)[number];
export type ExecutionStatus = "completed";
export const KNOWLEDGE_KINDS = ["decision", "pattern", "gotcha", "procedure", "skill"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KNOWLEDGE_STATUSES = ["active", "archived"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const SENSITIVE_DATA_KINDS = [
  "github_token",
  "openai_token",
  "anthropic_token",
  "slack_token",
  "google_api_key",
  "aws_access_key",
  "aws_secret_key",
  "private_key",
  "jwt",
  "connection_string_password",
  "environment_secret",
  "private_block",
] as const;
export type SensitiveDataKind = (typeof SENSITIVE_DATA_KINDS)[number];

/** Counts only: never the matched value or a token fragment. */
export interface RedactionSummary {
  total: number;
  byKind: Partial<Record<SensitiveDataKind, number>>;
}

export interface ChangedFileProvenance {
  path: string;
  sources: ChangedFileSource[];
  references?: string[];
}

export interface ChangedFileChange {
  path: string;
  status: ChangedFileChangeStatus;
  previousPath?: string;
}

export interface SessionFileEntry {
  path: string;
  status?: ChangedFileChangeStatus;
  previousPath?: string;
  sources?: ChangedFileSource[];
  references?: string[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  lastIngestedAt?: string;
  repositoryUrl?: string;
}

export interface MatchingProject {
  name: string;
  rootPath: string;
  status: "tracked" | "paused";
}

/**
 * https with a host and no embedded credentials: a token in `https://token@host/...` would be stored and shown in plain
 * text.
 */
export function isSafeRepositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export type ProjectFolderStatus = "found" | "missing" | "unavailable";

/** Derived by the local API with stat-only checks; this value is never persisted or exported. */
export interface ProjectListRecord extends ProjectRecord {
  folderStatus: ProjectFolderStatus;
}

export interface ProjectDeletionCounts {
  projects: number;
  sessions: number;
  workEvents: number;
  rawSnapshots: number;
  evidence: number;
  knowledge: number;
  knowledgeAudit: number;
  voidAudit: number;
  sessionVerificationUpdates: number;
  sessionLinks: number;
  knowledgeCandidateRequests: number;
  knowledgeCandidates: number;
  reportSynthesisRequests: number;
  reportSummaries: number;
  reportPresentations: number;
  attentionPreferences: number;
  metadataBackfillRequests: number;
  sessionSummaryUpdates: number;
  sessionWorkSummaryUpdates: number;
  sessionDecisions: number;
  outstandingItems: number;
  outstandingItemEvents: number;
  outstandingCleanupRequests: number;
  outstandingCleanupRequestItems: number;
  outstandingCleanupSubmissions: number;
  outstandingCleanupProposals: number;
  outstandingCleanupProposalEvidence: number;
  agentReviewRequests: number;
  agentReviewSubmissions: number;
  agentReviewRequestItems: number;
  knowledgePages: number;
  knowledgePageVersions: number;
  knowledgeFeedback: number;
  sessionDiagrams: number;
  searchChunks: number;
  searchFts: number;
  searchPaths: number;
  searchDirty: number;
}

export interface DeleteProjectResult {
  outcome: "project_deleted";
  projectId: string;
  deletedAt: string;
  backupFileName: string;
  deletedCounts: ProjectDeletionCounts;
}

export interface SessionDeletionCounts {
  sessions: number;
  workEvents: number;
  rawSnapshots: number;
  evidence: number;
  voidAudit: number;
  sessionLinks: number;
  sessionDecisions: number;
  sessionDiagrams: number;
  sessionSummaryUpdates: number;
  sessionWorkSummaryUpdates: number;
  sessionVerificationUpdates: number;
  outstandingItems: number;
  knowledgeFeedback: number;
  agentReadRecords: number;
}

export interface DeleteSessionResult {
  outcome: "session_deleted";
  sessionId: string;
  projectId: string;
  deletedAt: string;
  backupFileName: string;
  deletedCounts: SessionDeletionCounts;
}

export interface ProjectDeletionAuditRecord {
  deletedAt: string;
  projectId: string;
  deletedCounts: ProjectDeletionCounts;
}

export interface VerificationSummary {
  status: VerificationStatus;
  summary?: string;
}

export interface GitSummary {
  branch?: string;
  commitSha?: string;
  dirty?: boolean;
}

export interface WorkSummarySections {
  outcomes: string[];
  scope: string[];
  decisions: string[];
  verification: string[];
  nextSteps: string[];
}

export type WorkSummaryDecisionOrigin = "user_requested" | "agent_autonomous";
export const WORK_SUMMARY_DECISION_ORIGINS = ["user_requested", "agent_autonomous"] as const;
export const SESSION_DECISION_ORIGINS = [...WORK_SUMMARY_DECISION_ORIGINS, "unspecified"] as const;
export const SESSION_DECISION_REVIEW_STATUSES = ["pending", "confirmed", "rejected", "promoted"] as const;
export type SessionDecisionOrigin = WorkSummaryDecisionOrigin | "unspecified";
export type SessionDecisionReviewStatus = "pending" | "confirmed" | "rejected" | "promoted";

export interface WorkSummaryDecisionInput {
  text: string;
  origin: WorkSummaryDecisionOrigin;
}

export type WorkSummaryDecisionEntry = string | WorkSummaryDecisionInput;

export interface WorkSummaryInputSections extends Omit<WorkSummarySections, "decisions"> {
  decisions: WorkSummaryDecisionEntry[];
}

export type ReviewActor = "user" | "agent";

export interface SessionDecisionRecord {
  id: string;
  sessionId: string;
  projectId: string;
  position: number;
  text: string;
  origin: SessionDecisionOrigin;
  reviewStatus: SessionDecisionReviewStatus;
  reviewedAt?: string;
  knowledgeId?: string;
  /** Rows reviewed before Agent review existed read as "user". */
  reviewedBy?: ReviewActor;
  reviewReason?: string;
  reviewRequestId?: string;
  sessionTitle?: string;
  sessionCompletedAt?: string;
}

export const OUTSTANDING_ITEM_STATUSES = ["pending", "completed", "not_needed"] as const;
export const MAX_OUTSTANDING_ITEM_BATCH_SIZE = 100;
export type OutstandingItemStatus = (typeof OUTSTANDING_ITEM_STATUSES)[number];
export type OutstandingItemEventSource = "agent" | "web" | "migration";
/**
 * From the latest event that set the current status: source_session = the source Session dropped it from its nextSteps;
 * later_session = another Session's finalize; user = the web UI; cleanup_review = an Agent cleanup verdict; migration = a backfill.
 */
export const OUTSTANDING_ITEM_CLOSED_BY = [
  "source_session",
  "later_session",
  "user",
  "cleanup_review",
  "migration",
] as const;
export type OutstandingItemClosedBy = (typeof OUTSTANDING_ITEM_CLOSED_BY)[number];

export interface OutstandingItem {
  id: string;
  sourceSessionId: string;
  projectId: string;
  projectName: string;
  sourceSessionTitle: string;
  sourceSessionCompletedAt: string;
  position: number;
  text: string;
  status: OutstandingItemStatus;
  closedBy?: OutstandingItemClosedBy;
  createdAt: string;
  updatedAt: string;
}

export interface ListOutstandingItemsInput {
  projectRoot?: string;
  projectId?: string;
  status?: OutstandingItemStatus;
  closedBy?: readonly OutstandingItemClosedBy[];
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
}

export interface OutstandingItemListResult {
  outcome: "outstanding_items";
  items: OutstandingItem[];
  pageInfo: PageInfo;
}

export interface ContextOutstandingItem extends OutstandingItem {
  textTruncated?: true;
}

export type OutstandingItemListQueryResult =
  | OutstandingItemListResult
  | { outcome: "skipped"; projectId?: string; projectRoot?: string; projectStatus: PolicyStatus; reason?: string };

export interface UpdateOutstandingItemStatusInput {
  itemId: string;
  status: OutstandingItemStatus;
}

export type UpdateOutstandingItemStatusResult =
  | { outcome: "outstanding_item_updated"; item: OutstandingItem; duplicate: boolean }
  | { outcome: "not_found"; itemId: string }
  | { outcome: "skipped"; itemId: string; projectStatus: PolicyStatus; reason?: string };

export interface BatchUpdateOutstandingItemStatusInput {
  itemIds: string[];
  status: OutstandingItemStatus;
  expectedStatus?: OutstandingItemStatus;
}

export type BatchUpdateOutstandingItemStatusResult =
  | { outcome: "outstanding_items_updated"; items: OutstandingItem[]; updatedItemIds: string[]; duplicate: boolean }
  | { outcome: "rejected"; reason: "invalid_batch" | "invalid_items" | "status_conflict"; invalidItemIds: string[] }
  | { outcome: "skipped"; projectStatus: PolicyStatus; reason?: string };

export type OutstandingItemRejectionCode =
  | "not_found"
  | "other_project"
  | "not_pending"
  | "source_voided"
  | "held_by_cleanup"
  | "not_earlier"
  | "no_next_steps"
  | "both_lists";

export interface OutstandingItemRejectionReason {
  id: string;
  list: "resolved" | "superseded";
  code: OutstandingItemRejectionCode;
}

export interface ResolveOutstandingItemsInput {
  sessionId: string;
  resolvedOutstandingItemIds?: string[];
  supersededOutstandingItemIds?: string[];
}

export type ResolveOutstandingItemsResult =
  | {
      outcome: "outstanding_items_resolved";
      sessionId: string;
      resolvedOutstandingItemIds: string[];
      supersededOutstandingItemIds: string[];
      alreadyAppliedIds?: string[];
      duplicate?: true;
      outstandingItemWarnings?: {
        unresolvedIds: string[];
        unsupersededIds: string[];
        message: string;
        reasons: OutstandingItemRejectionReason[];
      };
    }
  | { outcome: "not_found"; sessionId: string }
  | { outcome: "skipped"; sessionId: string; projectStatus: PolicyStatus; reason: string };

export interface ListSessionDecisionsInput {
  projectRoot?: string;
  status?: "pending" | "all" | "agent_reviewed";
  limit?: number;
}

export interface SessionDecisionListResult {
  outcome: "session_decisions";
  items: SessionDecisionRecord[];
  pendingCount: number;
}

export type SessionDecisionListQueryResult =
  | SessionDecisionListResult
  | { outcome: "skipped"; projectRoot?: string; projectStatus: PolicyStatus; reason?: string };

export type ReviewSessionDecisionInput =
  | { decisionId: string; projectRoot: string; reviewStatus: "confirmed" | "rejected" }
  | { decisionId: string; projectRoot: string; reviewStatus: "promoted"; knowledgeId: string };

export type ReviewSessionDecisionResult =
  | { outcome: "session_decision_reviewed"; decision: SessionDecisionRecord; duplicate: boolean }
  | { outcome: "not_found"; decisionId: string }
  | { outcome: "skipped"; decisionId?: string; projectStatus: PolicyStatus; reason?: string };

export interface WorkSessionRecord {
  id: string;
  projectId: string;
  projectName?: string;
  externalSessionId?: string;
  idempotencyKey: string;
  title: string;
  summary: string;
  workSummary?: WorkSummarySections;
  redactionCount?: number;
  agentClient?: string;
  /** Model id as reported by the Agent when it chose to; never guessed. */
  agentModel?: string;
  status: "finalized";
  executionStatus: ExecutionStatus;
  /** When the work began, if the Agent reported it or an event predates completion; never guessed. */
  startedAt?: string;
  completedAt: string;
  createdAt: string;
  updatedAt: string;
  commitSha?: string;
  gitBranch?: string;
  changedFiles: string[];
  changedFilesProvenance: ChangedFileProvenance[];
  changedFileChanges: ChangedFileChange[];
  verification?: VerificationSummary;
  /** Set when the Session was voided (recorded by mistake or as a test); voided Sessions are hidden by default. */
  voided?: VoidState;
}

export interface VoidState {
  at: string;
  reason: string;
}

export interface WorkEventRecord {
  id: string;
  sessionId: string;
  type: WorkEventType;
  summary: string;
  details?: Record<string, unknown>;
  occurredAt: string;
}

export interface RawSnapshotRecord {
  id: string;
  sessionId: string;
  projectId: string;
  kind: "handoff";
  sourcePath?: string;
  content: string;
  capturedAt: string;
}

/** Ids only, never content; `errorCode` is a machine-readable code, never an error message. */
export interface AgentReadAuditItem {
  id: string;
  at: string;
  tool: string;
  agentClient?: string;
  projectId?: string;
  projectName?: string;
  outcome: string;
  returnedCount: number;
  sessionIds: string[];
  knowledgeIds: string[];
  omittedSessionCount: number;
  omittedKnowledgeCount: number;
  /** Wall time of the read in whole milliseconds; absent for rows recorded before timing existed. */
  durationMs?: number;
  /** Characters (UTF-16 code units) of the MCP response sent for this read; absent when unknown (older rows). */
  responseChars?: number;
  errorCode?: string;
}

export interface AgentReadAuditPage {
  items: AgentReadAuditItem[];
  pageInfo: PageInfo;
  agents: string[];
}

export interface AgentReadReference {
  at: string;
  tool: string;
  agentClient?: string;
}

export interface AgentReadResponseCharsStats {
  count: number;
  /** Nearest-rank percentiles in characters; null when count is 0. */
  p50: number | null;
  p95: number | null;
  total: number;
}

export interface AgentReadToolStats {
  tool: string;
  count: number;
  errorCount: number;
  timedCount: number;
  /** Nearest-rank percentiles and maximum in milliseconds; null when no row has a duration. */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  responseChars: AgentReadResponseCharsStats;
  errorCodes: Record<string, number>;
}

export interface AgentReadStats {
  tools: AgentReadToolStats[];
}

export interface AgentReadReferences {
  total: number;
  items: AgentReadReference[];
}

export interface SessionDetail {
  session: WorkSessionRecord;
  project: ProjectRecord;
  events: WorkEventRecord[];
  rawSnapshots: RawSnapshotRecord[];
  evidence: EvidenceRecord[];
  knowledge: KnowledgeRecord[];
  decisions: SessionDecisionRecord[];
  voidHistory: VoidAuditRecord[];
  verificationHistory: VerificationUpdateRecord[];
  links: SessionLinkRecord[];
  diagrams: SessionDiagramRecord[];
}

export const SESSION_DIAGRAM_KINDS = ["mermaid", "architecture"] as const;
export type SessionDiagramKind = (typeof SESSION_DIAGRAM_KINDS)[number];

export interface SessionDiagramRecord {
  id: string;
  sessionId: string;
  projectId: string;
  title: string;
  kind: SessionDiagramKind;
  formatVersion: number;
  source: string;
  createdAt: string;
  voided?: VoidState;
}

export interface DiagramContentInput {
  title: string;
  source: string;
  kind: "architecture";
  formatVersion: 1;
}

export interface AttachDiagramInput extends DiagramContentInput {
  sessionId: string;
  idempotencyKey: string;
}

export type AttachDiagramResult =
  | { outcome: "diagram_attached"; duplicate: boolean; diagram: SessionDiagramRecord; redactions?: RedactionSummary }
  | { outcome: "not_found"; sessionId: string }
  | { outcome: "idempotency_conflict"; reason: string }
  | SkippedResult;

export interface SetDiagramVoidInput {
  diagramId: string;
  voided: boolean;
  reason?: string;
}

export type SetDiagramVoidResult =
  | { outcome: "diagram_void_updated"; duplicate: boolean; diagram: SessionDiagramRecord }
  | { outcome: "not_found"; diagramId: string }
  | SkippedResult;

export type SessionLinkRelation = "continues" | "related";

export type SessionLinkDirection = "continues" | "continued_by" | "related";

export interface SessionLinkRecord {
  sessionId: string;
  title: string;
  projectName?: string;
  completedAt: string;
  relation: SessionLinkDirection;
  voided?: boolean;
}

export interface LinkSessionsInput {
  sessionId: string;
  relatedSessionId: string;
  relation: SessionLinkRelation;
  linked: boolean;
}

export type LinkSessionsResult =
  | { outcome: "session_link_updated"; duplicate: boolean; sessionId: string; links: SessionLinkRecord[] }
  | { outcome: "not_found"; sessionId: string }
  | { outcome: "invalid_link"; sessionId: string; reason: string }
  | { outcome: "skipped"; sessionId: string; projectStatus: PolicyStatus; reason: string };

export type VerificationUpdateSource = "web" | "agent";

export interface VerificationUpdateRecord {
  id: string;
  source: VerificationUpdateSource;
  previous?: VerificationSummary;
  resulting: VerificationSummary;
  createdAt: string;
}

export interface EvidenceRecord {
  id: string;
  sessionId: string;
  projectId: string;
  kind: string;
  reference: string;
  summary?: string;
  capturedAt: string;
  voided?: VoidState;
}

export type VoidTargetType = "session" | "evidence";

export type SessionVoidedFilter = "exclude" | "include" | "only";

export interface VoidAuditRecord {
  id: string;
  targetType: VoidTargetType;
  targetId: string;
  action: "voided" | "restored";
  reason?: string;
  occurredAt: string;
}

export interface SetSessionVoidInput {
  sessionId: string;
  voided: boolean;
  /** Required when voiding. */
  reason?: string;
}

export interface UpdateSessionTitleInput {
  sessionId: string;
  title: string;
}

export type UpdateSessionTitleResult =
  | {
      outcome: "title_updated";
      duplicate: boolean;
      session: WorkSessionRecord;
      previousTitle: string;
      redactions?: RedactionSummary;
    }
  | { outcome: "not_found"; sessionId: string }
  | { outcome: "skipped"; sessionId: string; projectStatus: PolicyStatus; reason: string };

export interface SetEvidenceVoidInput {
  evidenceId: string;
  voided: boolean;
  reason?: string;
}

export type SetSessionVoidResult =
  | { outcome: "session_void_updated"; duplicate: boolean; session: WorkSessionRecord; redactions?: RedactionSummary }
  | { outcome: "not_found"; sessionId: string }
  | { outcome: "skipped"; sessionId: string; projectStatus: PolicyStatus; reason: string };

export type SetEvidenceVoidResult =
  | { outcome: "evidence_void_updated"; duplicate: boolean; evidence: EvidenceRecord; redactions?: RedactionSummary }
  | { outcome: "not_found"; evidenceId: string }
  | { outcome: "skipped"; evidenceId: string; projectStatus: PolicyStatus; reason: string };

export interface AttachEvidenceInput {
  sessionId: string;
  kind: string;
  reference: string;
  summary?: string;
}

export interface AttachedEvidenceResult {
  outcome: "evidence_attached";
  duplicate: boolean;
  evidence: EvidenceRecord;
  redactions?: RedactionSummary;
}

export interface EvidenceNotFoundResult {
  outcome: "not_found";
  sessionId: string;
}

export interface EvidenceSkippedResult {
  outcome: "skipped";
  sessionId: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export type AttachEvidenceResult = AttachedEvidenceResult | EvidenceNotFoundResult | EvidenceSkippedResult;

export interface KnowledgeRecord {
  id: string;
  projectId: string;
  projectName?: string;
  sessionId?: string;
  idempotencyKey: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string[];
  references: string[];
  status: KnowledgeStatus;
  createdAt: string;
  updatedAt: string;
  appliesTo: string[];
  lastConfirmedAt?: string;
  lastConfirmedSessionId?: string;
  supersedesId?: string;
  review?: KnowledgeReview;
  /** Set only by the user; cleared (and `conventionWithdrawal` written) when the item changes under the Agent's hands. */
  conventionConfirmedAt?: string;
  conventionWithdrawal?: KnowledgeConventionWithdrawal;
  /** Computed on read, never stored. */
  possiblyStale?: KnowledgeStaleness;
  broadChangesSince?: number;
  stalenessUnchecked?: true;
  evidence?: KnowledgeEvidence;
}

export const KNOWLEDGE_FEEDBACK_KINDS = ["applied", "contradicted", "manual_confirm"] as const;
export type KnowledgeFeedbackKind = (typeof KNOWLEDGE_FEEDBACK_KINDS)[number];

export interface KnowledgeEvidence {
  confirmed: number;
  contradicted: number;
  lastConfirmedAt?: string;
  lastContradictedAt?: string;
}

export interface KnowledgeFeedbackRecord {
  id: string;
  kind: KnowledgeFeedbackKind;
  sessionId?: string;
  sessionTitle?: string;
  occurredAt: string;
}

export interface KnowledgeReview {
  reason: "contradicted";
  sessionId?: string;
  at: string;
}

export const KNOWLEDGE_CONVENTION_LIMIT = 5;
export const KNOWLEDGE_CONVENTION_WITHDRAWAL_REASONS = [
  "unmarked",
  "archived",
  "superseded",
  "needs_review",
  "agent_edit",
  "import_cap",
  "import_changed",
] as const;
export type KnowledgeConventionWithdrawalReason = (typeof KNOWLEDGE_CONVENTION_WITHDRAWAL_REASONS)[number];
export type KnowledgeConventionActor = "user" | "agent" | "system";

export interface KnowledgeConventionWithdrawal {
  at: string;
  by: KnowledgeConventionActor;
  reason: KnowledgeConventionWithdrawalReason;
}

export const KNOWLEDGE_STALENESS_REASONS = ["applies_to_changed", "broad_applies_to"] as const;
export type KnowledgeStalenessReason = (typeof KNOWLEDGE_STALENESS_REASONS)[number];

export interface KnowledgeAppliesToBreadth {
  /** Touching Sessions divided by `sessions`, rounded to 3 decimals. */
  share: number;
  /** The Sessions compared: the project's newest (up to 200) with 1-20 changed files, not only later ones. */
  sessions: number;
}

export interface KnowledgeWriteBreadth extends KnowledgeAppliesToBreadth {
  truncated: boolean;
  broad: boolean;
}

export interface KnowledgeStaleness {
  /** The earliest later Session with at most 20 changed files that touched a matching path. */
  sessionId: string;
  sessionTitle: string;
  completedAt: string;
  paths: string[];
  /** How many later Sessions with at most 20 changed files touched matching paths. */
  sessionCount: number;
  reason: KnowledgeStalenessReason;
  appliesToBreadth?: KnowledgeAppliesToBreadth;
}

export const KNOWLEDGE_AUDIT_ACTIONS = ["created", "updated", "archived", "restored"] as const;
export type KnowledgeAuditAction = (typeof KNOWLEDGE_AUDIT_ACTIONS)[number];

export interface KnowledgeAuditRecord {
  id: string;
  knowledgeId: string;
  projectId: string;
  action: KnowledgeAuditAction;
  before?: KnowledgeRecord;
  after: KnowledgeRecord;
  changedFields: string[];
  occurredAt: string;
}

export interface RecordKnowledgeInput {
  projectRoot: string;
  idempotencyKey: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  sessionId?: string;
  tags?: string[];
  references?: string[];
  appliesTo?: string[];
  supersedesId?: string;
}

export interface RecordedKnowledgeResult {
  outcome: "knowledge_recorded";
  duplicate: boolean;
  knowledge: KnowledgeRecord;
  warnings?: string[];
  appliesToBreadth?: KnowledgeWriteBreadth;
  redactions?: RedactionSummary;
}

export interface UpdateKnowledgeInput {
  projectRoot: string;
  knowledgeId: string;
  kind?: KnowledgeKind;
  title?: string;
  body?: string;
  tags?: string[];
  references?: string[];
  status?: KnowledgeStatus;
  appliesTo?: string[];
  confirm?: boolean;
}

export interface UpdatedKnowledgeResult {
  outcome: "knowledge_updated";
  knowledge: KnowledgeRecord;
  redactions?: RedactionSummary;
  warnings?: string[];
  appliesToBreadth?: KnowledgeWriteBreadth;
}

export type SetKnowledgeConventionResult =
  | { outcome: "knowledge_updated"; knowledge: KnowledgeRecord; conventionCount: number }
  | { outcome: "not_found"; knowledgeId: string }
  | { outcome: "rejected"; reason: "not_active" | "needs_review" | "convention_limit_reached"; knowledgeId: string }
  | KnowledgeSkippedResult;

export interface KnowledgeRestoreRejectedResult {
  outcome: "rejected";
  reason: "superseded_by_active";
  knowledgeId: string;
  successorId: string;
}

export interface KnowledgeUpdateNotFoundResult {
  outcome: "not_found";
  knowledgeId: string;
}

export type UpdateKnowledgeResult =
  UpdatedKnowledgeResult | KnowledgeUpdateNotFoundResult | KnowledgeRestoreRejectedResult | KnowledgeSkippedResult;

export interface KnowledgeSessionNotFoundResult {
  outcome: "not_found";
  sessionId: string;
}

export interface KnowledgeSkippedResult {
  outcome: "skipped";
  projectRoot: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export type RecordKnowledgeResult = RecordedKnowledgeResult | KnowledgeSessionNotFoundResult | KnowledgeSkippedResult;

export interface KnowledgeQuery {
  projectRoot?: string;
  projectId?: string;
  q?: string;
  query?: string;
  kind?: KnowledgeKind;
  status?: KnowledgeStatus;
  limit?: number;
  page?: number;
  pageSize?: number;
  view?: "full" | "compact";
  convention?: boolean;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
  truncated: boolean;
}

export interface SessionListResult {
  outcome: "sessions";
  items: WorkSessionRecord[];
  pageInfo: PageInfo;
  warnings?: string[];
  searchSkippedRecords?: number;
}

export interface CompactKnowledgeItem {
  id: string;
  projectId: string;
  projectName?: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  title: string;
  updatedAt: string;
  appliesToCount?: number;
  needsReview?: true;
}

export interface KnowledgeQueryResult<Item = KnowledgeRecord> {
  outcome: "knowledge";
  project?: ProjectRecord;
  projects: ProjectRecord[];
  items: Item[];
  pageInfo: PageInfo;
  warnings?: string[];
  searchSkippedRecords?: number;
}

export type KnowledgeSearchResult = KnowledgeQueryResult | KnowledgeSkippedResult;

export type KnowledgeSearchMatch = "strict" | "relaxed" | "none";

export interface RelaxedKnowledgeMatch {
  id: string;
  projectId: string;
  projectName?: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  title: string;
  /** At most 3 entries; appliesToOmittedCount counts the rest. */
  appliesTo?: string[];
  appliesToOmittedCount?: number;
  matchedTerms: string[];
  matchedPaths?: string[];
  /** Up to 400 characters of the body around the matched terms; excerptTruncated marks a cut body. */
  excerpt: string;
  excerptTruncated?: true;
  possiblyStale?: true;
  staleReason?: "broad_applies_to";
  broadChangesSince?: number;
  needsReview?: true;
}

export interface AgentKnowledgeQueryResult<Item = KnowledgeRecord> extends KnowledgeQueryResult<Item> {
  match?: KnowledgeSearchMatch;
  relaxedMatches?: RelaxedKnowledgeMatch[];
  otherStatusMatches?: Partial<Record<KnowledgeStatus, number>>;
  otherStatusFullMatches?: Partial<Record<KnowledgeStatus, number>>;
  effectiveQuery?: string;
  queryTruncated?: true;
  appliesToScanTruncated?: true;
  termHits?: RecallTermHits[];
  termHitsTruncated?: true;
  hint?: string;
}

export interface KnowledgeHistoryQuery {
  projectRoot: string;
  knowledgeId: string;
  limit?: number;
}

export interface KnowledgeHistoryQueryResult {
  outcome: "knowledge_history";
  project: ProjectRecord;
  knowledge: KnowledgeRecord;
  history: KnowledgeAuditRecord[];
  /** Confirmations and contradictions, newest first (at most 100). */
  feedback: KnowledgeFeedbackRecord[];
}

export interface KnowledgeHistoryNotFoundResult {
  outcome: "not_found";
  knowledgeId: string;
}

export interface KnowledgeHistorySkippedResult extends KnowledgeSkippedResult {
  knowledgeId: string;
}

export type KnowledgeHistoryResult =
  KnowledgeHistoryQueryResult | KnowledgeHistoryNotFoundResult | KnowledgeHistorySkippedResult;

export const GRAPH_NODE_KINDS = ["project", "session", "knowledge", "evidence", "file"] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];
export const GRAPH_EDGE_KINDS = [
  "contains",
  "changed_file",
  "has_knowledge",
  "has_evidence",
  "session_link",
  "co_changed",
] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  projectId?: string;
  sessionId?: string;
  metadata: Record<string, string | number | boolean>;
}

export type GraphEdgeProvenance = "recorded" | "derived";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  provenance: GraphEdgeProvenance;
  reason?: string;
}

export type GraphNodeTotals = Record<GraphNodeKind, number>;

export interface GraphQuery {
  projectRoot?: string;
  projectId?: string;
  limit?: number;
  maxNodes?: number;
  maxEdges?: number;
  pageSize?: number;
  cursor?: string;
  /** Adds derived co_changed edges between loaded files (hidden by default). */
  includeDerived?: boolean;
  /** Sessions two files must share to get a co_changed edge (default 3). */
  coChangeMinSessions?: number;
}

export interface GraphPathQuery {
  projectRoot?: string;
  projectId?: string;
  from: string;
  to: string;
  includeDerived?: boolean;
}

export interface GraphPathStep {
  from: GraphNode;
  to: GraphNode;
  edge: GraphEdge;
  reason: string;
}

export type GraphPathResult =
  | {
      outcome: "graph_path";
      found: boolean;
      steps: GraphPathStep[];
      searchedNodes: number;
      reason?: string;
    }
  | GraphSkippedResult;

export interface GraphPageInfo {
  unit: "sessions";
  phase?: "projects" | "sessions" | "project_knowledge";
  offset: number;
  pageSize: number;
  hasNext: boolean;
}

export interface GraphTruncation {
  nodeLimit: number;
  edgeLimit: number;
  nodesTruncated: boolean;
  edgesTruncated: boolean;
}

export interface GraphResult {
  outcome: "graph";
  project?: ProjectRecord;
  projects: ProjectRecord[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
  totalNodesByKind: GraphNodeTotals;
  sourceProjectIds: string[];
  sourceSessionIds: string[];
  truncation: GraphTruncation;
  pageInfo?: GraphPageInfo;
  cursor?: string;
  nextCursor?: string;
}

export interface GraphSkippedResult {
  outcome: "skipped";
  projectRoot: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export type GraphQueryResult = GraphResult | GraphSkippedResult;

export interface DashboardSummary {
  trackedProjects: number;
  activeProjects: number;
  finalizedSessions: number;
  recordedEvents: number;
  recentSessions: WorkSessionRecord[];
}

export const REPORT_PERIODS = ["day", "week", "month", "quarter", "year"] as const;

export type ReportPeriod = (typeof REPORT_PERIODS)[number];
export const WORK_REPORT_PERIODS = [...REPORT_PERIODS, "custom"] as const;
export type WorkReportPeriod = (typeof WORK_REPORT_PERIODS)[number];
export const MAX_CUSTOM_REPORT_DAYS = 366;
export type ReportTrendGranularity = "day" | "month";
export const REPORT_EXPORT_FORMATS = ["json", "markdown"] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];
export const REPORT_SYNTHESIS_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"] as const;
export type ReportSynthesisStatus = (typeof REPORT_SYNTHESIS_STATUSES)[number];
export const REPORT_SYNTHESIS_SCOPE_TYPES = ["all", "project"] as const;
export type ReportSynthesisScopeType = (typeof REPORT_SYNTHESIS_SCOPE_TYPES)[number];
export const METADATA_BACKFILL_REQUEST_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type MetadataBackfillRequestStatus = (typeof METADATA_BACKFILL_REQUEST_STATUSES)[number];
export const METADATA_BACKFILL_SCOPE_TYPES = ["all", "project"] as const;
export type MetadataBackfillScopeType = (typeof METADATA_BACKFILL_SCOPE_TYPES)[number];

export interface ReportRange {
  from: string;
  to: string;
}

export interface ReportProjectSummary {
  projectId: string;
  projectName: string;
  sessionCount: number;
  eventCount: number;
  sourceSessionIds: string[];
}

export interface ReportMetricComparison {
  current: number;
  previous: number;
  delta: number;
  direction: "up" | "down" | "flat";
}

export interface ReportComparison {
  sessions: ReportMetricComparison;
  events: ReportMetricComparison;
  changedFiles: ReportMetricComparison;
}

export interface ReportTrendPoint {
  date: string;
  sessions: number;
  events: number;
}

export type ReportInsightKind = "verification" | "metadata" | "event" | "hotspot";

export interface ReportInsight {
  kind: ReportInsightKind;
  label: string;
  detail: string;
  sourceSessionIds: string[];
}

export interface ReportDecision {
  sessionId: string;
  sessionTitle: string;
  projectName?: string;
  summary: string;
  occurredAt: string;
}

export const REPORT_EVIDENCE_KINDS = ["handoff", "verification", "changed-files", "event", "attached"] as const;
export type ReportEvidenceKind = (typeof REPORT_EVIDENCE_KINDS)[number];

export interface ReportEvidence {
  sessionId: string;
  sessionTitle: string;
  projectName?: string;
  kind: ReportEvidenceKind;
  label: string;
  detail: string;
  reference?: string;
}

export interface ReportSpanningSession {
  id: string;
  title: string;
  projectName?: string;
  startedAt?: string;
  completedAt: string;
  updatedAt: string;
}

export interface ReportSpanningSessions {
  startedEarlier: ReportSpanningSession[];
  continuedLater: ReportSpanningSession[];
  updatedInPeriod: ReportSpanningSession[];
}

export interface WorkReport {
  outcome: "report";
  period: WorkReportPeriod;
  range: ReportRange;
  previousRange: ReportRange;
  /** IANA time zone of the host that computed the calendar-date range. */
  timezone: string;
  project?: ProjectRecord;
  periodSummary: string;
  sourceSessionIds: string[];
  sessions: WorkSessionRecord[];
  sessionTruncation: {
    currentPeriod: boolean;
    previousPeriod: boolean;
  };
  completedWork: WorkSessionRecord[];
  projects: ReportProjectSummary[];
  totals: {
    sessions: number;
    events: number;
    changedFiles: number;
    changedFilesOversizedSessions: number;
    verification: Record<ReportVerificationStatus, number>;
  };
  comparison: ReportComparison;
  /** Includes up to five "hotspot" risks: files that at least two of the period's Sessions changed. */
  risks: ReportInsight[];
  decisions: ReportDecision[];
  agentAutonomousDecisions: {
    total: number;
    pending: number;
    pendingItems: SessionDecisionRecord[];
  };
  trendGranularity: ReportTrendGranularity;
  trends: ReportTrendPoint[];
  spanning: ReportSpanningSessions;
  evidence: ReportEvidence[];
  evidencePageInfo: PageInfo;
}

export interface SkippedReportResult {
  outcome: "skipped";
  projectId?: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export type ReportQueryResult = WorkReport | SkippedReportResult;

export interface ReportExport {
  outcome: "report_export";
  format: ReportExportFormat;
  filename: string;
  contentType: "application/json; charset=utf-8" | "text/markdown; charset=utf-8";
  content: string;
  report: WorkReport;
}

export type ReportExportResult = ReportExport | SkippedReportResult;

export interface ReportSynthesisRequest {
  id: string;
  idempotencyKey: string;
  scopeType: ReportSynthesisScopeType;
  projectId?: string;
  projectName?: string;
  period: WorkReportPeriod;
  range: ReportRange;
  status: ReportSynthesisStatus;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  sourceSessionIds: string[];
}

export interface ReportSummaryBlock {
  title: string;
  detail: string;
  sourceSessionIds: string[];
}

export interface ReportSummary {
  id: string;
  requestId: string;
  period: WorkReportPeriod;
  range: ReportRange;
  projectId?: string;
  projectName?: string;
  title: string;
  executiveSummary: string;
  themes: ReportSummaryBlock[];
  highlights: ReportSummaryBlock[];
  verification: ReportSummaryBlock[];
  comparison: ReportSummaryBlock[];
  risks: ReportSummaryBlock[];
  decisions: ReportSummaryBlock[];
  nextSteps: ReportSummaryBlock[];
  sourceSessionIds: string[];
  generatedByAgent: string;
  generatedByModel?: string;
  promptVersion: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface CreateReportSynthesisRequestInput {
  period: WorkReportPeriod;
  date?: string;
  from?: string;
  to?: string;
  projectId?: string;
  idempotencyKey?: string;
}

export interface ReportSynthesisRequestQuery {
  period?: WorkReportPeriod;
  date?: string;
  from?: string;
  to?: string;
  projectId?: string;
  scopeType?: ReportSynthesisScopeType;
  status?: ReportSynthesisStatus;
  requestId?: string;
  limit?: number;
}

export interface ReportSynthesisRequestListResult {
  outcome: "report_synthesis_requests";
  requests: ReportSynthesisRequest[];
}

export interface ReportSynthesisRequestNotFoundResult {
  outcome: "not_found";
  requestId: string;
}

export type ReportSynthesisRequestListQueryResult = ReportSynthesisRequestListResult | SkippedReportResult;

export interface ReportSynthesisRequestCreatedResult {
  outcome: "report_synthesis_request";
  duplicate: boolean;
  request: ReportSynthesisRequest;
}

export type CreateReportSynthesisRequestResult = ReportSynthesisRequestCreatedResult | SkippedReportResult;

export interface ReportSynthesisRequestDetailResult {
  outcome: "report_synthesis_request_detail";
  request: ReportSynthesisRequest;
  summary?: ReportSummary;
}

export type ReportSynthesisRequestLookupResult =
  ReportSynthesisRequestDetailResult | ReportSynthesisRequestNotFoundResult | SkippedReportResult;

export interface ReportSynthesisRequestRetriedResult {
  outcome: "report_synthesis_request_retried";
  previousRequestId: string;
  request: ReportSynthesisRequest;
}

export interface ReportSynthesisRequestCancelledResult {
  outcome: "report_synthesis_request_cancelled";
  duplicate: boolean;
  request: ReportSynthesisRequest;
}

export interface ReportSynthesisRequestCancelRejectedResult {
  outcome: "report_synthesis_cancel_rejected";
  requestId: string;
  status: ReportSynthesisStatus;
  reason: string;
}

export interface ReportSynthesisRequestRetryRejectedResult {
  outcome: "report_synthesis_retry_rejected";
  requestId: string;
  status: ReportSynthesisStatus;
  reason: string;
}

export type RetryReportSynthesisRequestResult =
  | ReportSynthesisRequestRetriedResult
  | ReportSynthesisRequestRetryRejectedResult
  | ReportSynthesisRequestNotFoundResult
  | SkippedReportResult;

export type CancelReportSynthesisRequestResult =
  | ReportSynthesisRequestCancelledResult
  | ReportSynthesisRequestCancelRejectedResult
  | ReportSynthesisRequestNotFoundResult
  | SkippedReportResult;

export interface ReportSynthesisContextHandoff {
  sessionId: string;
  sessionTitle: string;
  projectName?: string;
  sourcePath?: string;
  content: string;
}

export interface ReportSynthesisContextResult {
  outcome: "report_context";
  request: ReportSynthesisRequest;
  report: WorkReport;
  sessions: WorkSessionRecord[];
  handoffSummaries: ReportSynthesisContextHandoff[];
  sourceSessionIds: string[];
  coverage: {
    requestSnapshotAt: string;
    requestedSessions: number;
    eligibleSessions: number;
    unavailableSessions: number;
    selectedSessions: number;
    currentPeriodAsOf: string;
    currentPeriodSessions: number;
    sessionPageInfo: PageInfo;
    evidence: { scope: "selected_sessions"; total: number; returned: number };
  };
  truncation: {
    sessions: boolean;
    evidence: boolean;
    handoffCharacters: boolean;
  };
}

export interface ReportSynthesisRequestNotReadyResult {
  outcome: "report_synthesis_request_not_ready";
  request: ReportSynthesisRequest;
  reason: string;
}

export interface ReportSynthesisContextQuery {
  requestId: string;
  maxSessions?: number;
  sessionPage?: number;
  maxEvidence?: number;
  evidencePage?: number;
  maxHandoffCharacters?: number;
}

export type ReportSynthesisContextQueryResult =
  | ReportSynthesisContextResult
  | ReportSynthesisRequestNotFoundResult
  | ReportSynthesisRequestNotReadyResult
  | SkippedReportResult;

export interface SaveReportSummaryInput {
  requestId: string;
  title: string;
  executiveSummary: string;
  themes?: ReportSummaryBlock[];
  highlights: ReportSummaryBlock[];
  verification?: ReportSummaryBlock[];
  comparison?: ReportSummaryBlock[];
  risks: ReportSummaryBlock[];
  decisions: ReportSummaryBlock[];
  nextSteps: ReportSummaryBlock[];
  sourceSessionIds: string[];
  generatedByAgent: string;
  generatedByModel?: string;
  promptVersion: string;
}

export interface ReportSummarySavedResult {
  outcome: "report_summary_saved";
  duplicate: boolean;
  summary: ReportSummary;
  redactions?: RedactionSummary;
}

export interface ReportSummarySaveNotFoundResult {
  outcome: "not_found";
  requestId: string;
}

export interface ReportSummaryRequestNotReadyResult {
  outcome: "report_summary_request_not_ready";
  requestId: string;
  status: ReportSynthesisStatus;
  reason: string;
}

export type SaveReportSummaryResult =
  ReportSummarySavedResult | ReportSummarySaveNotFoundResult | ReportSummaryRequestNotReadyResult | SkippedReportResult;

export interface ReportSummaryQuery extends ReportSynthesisRequestQuery {
  currentOnly?: boolean;
}

export interface ReportSummaryListResult {
  outcome: "report_summaries";
  summaries: ReportSummary[];
}

export interface ReportSummaryDeletedResult {
  outcome: "report_summary_deleted";
  summaryId: string;
  deleted: true;
}

export interface ReportSummaryDeleteRejectedResult {
  outcome: "report_summary_delete_rejected";
  summaryId: string;
  reason: string;
}

export interface ReportSummaryDeleteNotFoundResult {
  outcome: "not_found";
  summaryId: string;
}

export type ReportSummaryQueryResult = ReportSummaryListResult | SkippedReportResult;

export type DeleteReportSummaryResult =
  | ReportSummaryDeletedResult
  | ReportSummaryDeleteRejectedResult
  | ReportSummaryDeleteNotFoundResult
  | SkippedReportResult;

export interface FinalizeEventInput {
  type: WorkEventType;
  summary: string;
  details?: Record<string, unknown>;
  occurredAt?: string;
}

export interface FinalizeSessionInput {
  projectRoot: string;
  idempotencyKey: string;
  title: string;
  summary: string;
  workSummary?: WorkSummaryInputSections;
  externalSessionId?: string;
  /** Exact model id when the Agent knows it; omitted otherwise, never guessed. */
  agentModel?: string;
  handoffPath?: string;
  handoffContent?: string;
  events?: FinalizeEventInput[];
  changedFiles?: string[];
  baselineChangedFiles?: string[];
  changedFilesProvenance?: ChangedFileProvenance[];
  changedFileChanges?: ChangedFileChange[];
  verification?: VerificationSummary;
  git?: GitSummary;
  /** When the work began (e.g. the first message of the conversation); must not be after completedAt. */
  startedAt?: string;
  completedAt?: string;
  parentSessionId?: string;
  relatedSessionIds?: string[];
  appliedKnowledgeIds?: string[];
  contradictedKnowledgeIds?: string[];
  diagrams?: DiagramContentInput[];
  maintainedKnowledgePages?: string[];
  resolvedOutstandingItemIds?: string[];
  supersededOutstandingItemIds?: string[];
}

export interface UpdateSessionVerificationInput {
  sessionId: string;
  verification: VerificationSummary;
}

export interface PolicyDecision {
  allowed: boolean;
  project?: ProjectRecord;
  projectStatus: PolicyStatus;
  canonicalRoot: string;
  reason?: string;
}

export type TransientNextStepCategory =
  | "uncommitted"
  | "not_pushed"
  | "pending_merge"
  | "ci_running"
  | "phase_not_started"
  | "scope_exclusion"
  | "unverified_platform"
  | "deferred_to_user";

export interface NextStepsWarnings {
  /** 0-based position in the stored nextSteps; item text is never repeated here. */
  items: { index: number; category: TransientNextStepCategory }[];
  message: string;
}

export interface PrivateTagWarnings {
  fields: string[];
  unclosed: number;
  message: string;
}

export interface FinalizedSessionResult {
  outcome: "finalized";
  duplicate: boolean;
  session: WorkSessionRecord;
  startedAtSource?: "reported" | "events" | "server_observed";
  redactions?: RedactionSummary;
  verificationFollowUp?: VerificationFollowUp;
  changedFilesFollowUp?: ChangedFilesFollowUp;
  changedFileChangesFollowUp?: ChangedFileChangesFollowUp;
  changedFileChangesSource?: { serverObservedGit: number };
  workSummaryFollowUp?: WorkSummaryFollowUp;
  linkWarnings?: string[];
  knowledgeWarnings?: string[];
  knowledgeFeedback?: KnowledgeFeedbackCounts;
  unreportedKnowledge?: UnreportedKnowledge;
  timestampWarnings?: string[];
  knowledgePagesAcknowledged?: string[];
  knowledgePageMaintenanceHint?: string;
  resolvedOutstandingItemIds?: string[];
  supersededOutstandingItemIds?: string[];
  relatedOutstandingItems?: RelatedOutstandingItems;
  continuedOutstandingItems?: RelatedOutstandingItems;
  knowledgeToReview?: KnowledgeReviewHint[];
  knowledgeToReviewTruncated?: true;
  outstandingItemWarnings?: {
    unresolvedIds: string[];
    unsupersededIds?: string[];
    message: string;
    reasons: OutstandingItemRejectionReason[];
  };
  privateTagWarnings?: PrivateTagWarnings;
  nextStepsWarnings?: NextStepsWarnings;
}

export interface KnowledgeFeedbackCounts {
  applied: number;
  contradicted: number;
}

export interface UnreportedKnowledge {
  items: { id: string; title: string }[];
  total: number;
}

export interface KnowledgeReviewHint {
  id: string;
  title: string;
  path: string;
  appliesTo?: string;
}

export interface FinalizeIdempotencyConflictResult {
  outcome: "idempotency_conflict";
  idempotencyKey: string;
  sessionId: string;
  existingSummary: string;
  reason: string;
  suggestedTool: "work_update_session_summary";
}

export interface SkippedResult {
  outcome: "skipped";
  projectRoot: string;
  projectStatus: PolicyStatus;
  reason: string;
}

/** Must return the requested project id, not the project root, which is the wrong identifier for registry callers. */
export interface ProjectIdSkippedResult {
  outcome: "skipped";
  projectId: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export type FinalizeRejectionCode =
  "both_lists" | "superseded_without_next_steps" | "knowledge_applied_and_contradicted" | "started_after_completed";

export interface FinalizeRejectedResult {
  outcome: "rejected";
  code: FinalizeRejectionCode;
  field: string;
  ids?: string[];
  reason: string;
  fix: string;
}

export type FinalizeSessionResult =
  FinalizedSessionResult | FinalizeIdempotencyConflictResult | FinalizeRejectedResult | SkippedResult;

export interface VerificationFollowUp {
  required: true;
  sessionId: string;
  message: string;
}

export interface ChangedFilesFollowUp {
  required: true;
  sessionId: string;
  message: string;
}

export interface ChangedFileChangesFollowUp {
  required: true;
  sessionId: string;
  /** The first paths (at most 20) that no change entry covers, as path or previousPath. */
  missingPaths: string[];
  missingCount: number;
  message: string;
}

export interface WorkSummaryFollowUp {
  required: true;
  sessionId: string;
  message: string;
}

export interface UpdatedSessionVerificationResult {
  outcome: "updated";
  session: WorkSessionRecord;
  previous?: VerificationSummary;
  unchanged?: boolean;
  redactions?: RedactionSummary;
}

export interface UpdateSessionMetadataInput {
  sessionId: string;
  changedFiles?: string[];
  changedFilesMode?: ChangedFilesMode;
  changedFilesProvenance?: ChangedFileProvenance[];
  changedFileChanges?: ChangedFileChange[];
  verification?: VerificationSummary;
  git?: GitSummary;
  startedAt?: string;
  completedAt?: string;
  /** The work continued and just finished: the server clock is recorded as completedAt. Exclusive with completedAt. */
  completedAtNow?: true;
  appliedKnowledgeIds?: string[];
  contradictedKnowledgeIds?: string[];
}

export type MetadataBackfillGap = "changed_files" | "verification";

export interface MetadataBackfillItem {
  sessionId: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  title: string;
  completedAt: string;
  changedFilesCount: number;
  changedFilesProvenanceCount: number;
  changedFileChangesCount: number;
  changedFiles: string[];
  changedFilesProvenance: ChangedFileProvenance[];
  changedFileChanges: ChangedFileChange[];
  verificationStatus: ReportVerificationStatus;
  verification?: VerificationSummary;
  rawSnapshotCount: number;
  gaps: MetadataBackfillGap[];
}

export interface MetadataBackfillPreview {
  outcome: "backfill_preview";
  project?: ProjectRecord;
  scannedSessions: number;
  truncated: boolean;
  items: MetadataBackfillItem[];
  totals: {
    needsBackfill: number;
    changedFilesMissing: number;
    verificationMissing: number;
    verificationNotRun: number;
  };
}

export interface MetadataBackfillApplyInput {
  requestId?: string;
  updates: UpdateSessionMetadataInput[];
}

export interface MetadataBackfillRequest {
  id: string;
  idempotencyKey: string;
  scopeType: MetadataBackfillScopeType;
  projectId?: string;
  projectName?: string;
  status: MetadataBackfillRequestStatus;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  sourceSessionIds: string[];
}

export interface CreateMetadataBackfillRequestInput {
  projectId?: string;
  idempotencyKey?: string;
}

export interface MetadataBackfillRequestQuery {
  scopeType?: MetadataBackfillScopeType;
  projectId?: string;
  status?: MetadataBackfillRequestStatus;
  requestId?: string;
  limit?: number;
}

export interface MetadataBackfillRequestCreatedResult {
  outcome: "metadata_backfill_request";
  duplicate: boolean;
  request: MetadataBackfillRequest;
}

export interface MetadataBackfillRequestNotNeededResult {
  outcome: "metadata_backfill_not_needed";
  scannedSessions: number;
  reason: string;
}

export type CreateMetadataBackfillRequestResult =
  | MetadataBackfillRequestCreatedResult
  | MetadataBackfillRequestNotNeededResult
  | SkippedResult
  | ProjectIdSkippedResult;

export interface MetadataBackfillRequestListResult {
  outcome: "metadata_backfill_requests";
  requests: MetadataBackfillRequest[];
}

export interface MetadataBackfillRequestCancelledResult {
  outcome: "metadata_backfill_request_cancelled";
  duplicate: boolean;
  request: MetadataBackfillRequest;
}

export interface MetadataBackfillRequestCancelRejectedResult {
  outcome: "metadata_backfill_cancel_rejected";
  requestId: string;
  status: MetadataBackfillRequestStatus;
  reason: string;
}

export type CancelMetadataBackfillRequestResult =
  | MetadataBackfillRequestCancelledResult
  | MetadataBackfillRequestCancelRejectedResult
  | MetadataBackfillRequestNotFoundResult
  | ProjectIdSkippedResult;

export type MetadataBackfillRequestListQueryResult = MetadataBackfillRequestListResult | ProjectIdSkippedResult;

export interface MetadataBackfillRequestContextQuery {
  requestId: string;
  limit?: number;
}

export interface MetadataBackfillRequestContextResult {
  outcome: "metadata_backfill_context";
  request: MetadataBackfillRequest;
  items: MetadataBackfillItem[];
  resolvedSessionIds: string[];
  sourceSessionIds: string[];
  truncated: boolean;
}

export interface MetadataBackfillRequestNotFoundResult {
  outcome: "not_found";
  requestId: string;
}

export interface MetadataBackfillRequestNotReadyResult {
  outcome: "metadata_backfill_request_not_ready";
  request: MetadataBackfillRequest;
  reason: string;
}

export type MetadataBackfillRequestContextQueryResult =
  | MetadataBackfillRequestContextResult
  | MetadataBackfillRequestNotFoundResult
  | MetadataBackfillRequestNotReadyResult
  | SkippedResult
  | ProjectIdSkippedResult;

export interface MetadataBackfillFailure {
  sessionId: string;
  reason: string;
}

export interface MetadataBackfillSkipped {
  sessionId: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export interface MetadataBackfillResult {
  outcome: "backfill_applied";
  requestedCount: number;
  updated: WorkSessionRecord[];
  skipped: MetadataBackfillSkipped[];
  failures: MetadataBackfillFailure[];
  request?: MetadataBackfillRequest;
  remainingItems?: MetadataBackfillItem[];
}

export type MetadataBackfillPreviewResult = MetadataBackfillPreview | SkippedResult;
export type MetadataBackfillBatchResult = MetadataBackfillResult | MetadataBackfillRequestNotReadyResult;

export const HANDOFF_IMPORT_DECISIONS = ["eligible", "excluded", "already_imported", "error"] as const;
export type HandoffImportDecision = (typeof HANDOFF_IMPORT_DECISIONS)[number];
export type HandoffImportChangedFilesStatus = "detected" | "not_found" | "not_read";
export type HandoffImportReason =
  | "excluded_by_user"
  | "blocked"
  | "pending"
  | "planning_only"
  | "no_explicit_completion"
  | "already_imported"
  | "unreadable"
  | "not_regular_file"
  | "invalid_path"
  | "source_not_found"
  | "import_failed";

export interface HandoffImportOptions {
  projectRoot: string;
  handoffDirectory?: string;
  excludePaths?: string[];
  maxFiles?: number;
}

export interface HandoffImportApplyInput extends HandoffImportOptions {
  sourcePaths: string[];
}

export interface HandoffImportPreviewItem {
  sourcePath: string;
  title: string;
  summaryPreview?: string;
  recordedDate?: string;
  decision: HandoffImportDecision;
  reason?: HandoffImportReason;
  detail?: string;
  verificationStatus?: VerificationStatus;
  changedFiles: string[];
  changedFilesStatus: HandoffImportChangedFilesStatus;
  existingSessionId?: string;
}

export interface HandoffImportPreview {
  outcome: "preview";
  project: ProjectRecord;
  projectStatus: "tracked";
  handoffDirectory: string;
  directoryFound: boolean;
  truncated: boolean;
  items: HandoffImportPreviewItem[];
  totals: {
    discovered: number;
    eligible: number;
    excluded: number;
    alreadyImported: number;
    errors: number;
  };
}

export interface HandoffImportFailure {
  sourcePath: string;
  reason: HandoffImportReason;
  detail: string;
}

export interface HandoffImportResult {
  outcome: "imported";
  project: ProjectRecord;
  selectedCount: number;
  imported: WorkSessionRecord[];
  skipped: HandoffImportPreviewItem[];
  failures: HandoffImportFailure[];
}

export type HandoffImportPreviewResult = HandoffImportPreview | SkippedResult;
export type HandoffImportBatchResult = HandoffImportResult | SkippedResult;

export interface UpdatedSessionMetadataResult {
  outcome: "updated";
  session: WorkSessionRecord;
  redactions?: RedactionSummary;
  timestampWarnings?: string[];
  changedFileChangesFollowUp?: ChangedFileChangesFollowUp;
  knowledgeWarnings?: string[];
  knowledgeFeedback?: KnowledgeFeedbackCounts;
}

export const SESSION_SUMMARY_UPDATE_MODES = ["replace", "append"] as const;
export type SessionSummaryUpdateMode = (typeof SESSION_SUMMARY_UPDATE_MODES)[number];

export interface UpdateSessionSummaryInput {
  sessionId: string;
  idempotencyKey: string;
  summary: string;
  mode?: SessionSummaryUpdateMode;
}

export interface UpdatedSessionSummaryResult {
  outcome: "summary_updated";
  duplicate: boolean;
  session: WorkSessionRecord;
  idempotencyKey: string;
  mode: SessionSummaryUpdateMode;
  previousSummary: string;
  appliedSummary: string;
  redactions?: RedactionSummary;
}

export interface SessionSummaryUpdateIdempotencyConflictResult {
  outcome: "summary_update_idempotency_conflict";
  sessionId: string;
  idempotencyKey: string;
  reason: string;
}

export interface SessionVerificationNotFoundResult {
  outcome: "not_found";
  sessionId: string;
}

export interface SessionVerificationSkippedResult {
  outcome: "skipped";
  sessionId: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export type UpdateSessionVerificationResult =
  UpdatedSessionVerificationResult | SessionVerificationNotFoundResult | SessionVerificationSkippedResult;

export type UpdateSessionMetadataResult =
  UpdatedSessionMetadataResult | SessionVerificationNotFoundResult | SessionVerificationSkippedResult;

export type UpdateSessionSummaryResult =
  | UpdatedSessionSummaryResult
  | SessionSummaryUpdateIdempotencyConflictResult
  | SessionVerificationNotFoundResult
  | SessionVerificationSkippedResult;

export const WORK_SUMMARY_UPDATE_MODES = ["replace", "patch"] as const;
export type WorkSummaryUpdateMode = (typeof WORK_SUMMARY_UPDATE_MODES)[number];

export interface UpdateSessionWorkSummaryInput {
  sessionId: string;
  idempotencyKey: string;
  mode?: WorkSummaryUpdateMode;
  workSummary: WorkSummaryInputSections | Partial<WorkSummaryInputSections>;
}

export interface OutstandingItemSyncSummary {
  created: number;
  retained: number;
  reworded: number;
  closed: number;
}

export interface UpdatedSessionWorkSummaryResult {
  outcome: "work_summary_updated";
  duplicate: boolean;
  session: WorkSessionRecord;
  idempotencyKey: string;
  mode: WorkSummaryUpdateMode;
  previousWorkSummary?: WorkSummarySections;
  appliedWorkSummary: WorkSummarySections;
  redactions?: RedactionSummary;
  outstandingItems?: OutstandingItemSyncSummary;
  nextStepsWarnings?: NextStepsWarnings;
}

export interface SessionWorkSummaryUpdateIdempotencyConflictResult {
  outcome: "work_summary_update_idempotency_conflict";
  sessionId: string;
  idempotencyKey: string;
  reason: string;
}

export type UpdateSessionWorkSummaryResult =
  | UpdatedSessionWorkSummaryResult
  | SessionWorkSummaryUpdateIdempotencyConflictResult
  | SessionVerificationNotFoundResult
  | SessionVerificationSkippedResult;

export interface SessionDigest {
  id: string;
  projectId: string;
  projectName?: string;
  title: string;
  summary: string;
  summaryTruncated?: boolean;
  startedAt?: string;
  completedAt: string;
  updatedAt: string;
  gitBranch?: string;
  verificationStatus: ReportVerificationStatus;
  changedFilesCount: number;
  openItems: string[];
}

export interface KnowledgeDigest {
  id: string;
  projectId: string;
  projectName?: string;
  sessionId?: string;
  kind: KnowledgeKind;
  title: string;
  excerpt: string;
  excerptTruncated?: boolean;
  tags: string[];
  updatedAt: string;
  possiblyStale?: boolean;
  staleReason?: "broad_applies_to";
  broadChangesSince?: number;
  needsReview?: boolean;
}

export interface DecisionDigest {
  sessionId: string;
  sessionTitle: string;
  completedAt: string;
  text: string;
  truncated?: boolean;
}

export type RelevantDecisionDigest = Omit<DecisionDigest, "sessionTitle" | "completedAt"> &
  Partial<Pick<DecisionDigest, "sessionTitle" | "completedAt">>;

export const KNOWLEDGE_CANDIDATE_REQUEST_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type KnowledgeCandidateRequestStatus = (typeof KNOWLEDGE_CANDIDATE_REQUEST_STATUSES)[number];
export type KnowledgeCandidateStatus = "proposed" | "accepted" | "rejected";

export interface KnowledgeCandidateRequest {
  id: string;
  projectId: string;
  projectName?: string;
  status: KnowledgeCandidateRequestStatus;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  sourceSessionIds: string[];
  candidateCount: number;
}

export interface KnowledgeCandidateBacklogCounts {
  uncoveredSessions: number;
  highValueSessions: number;
}

export interface KnowledgeCandidateBacklog extends KnowledgeCandidateBacklogCounts {
  projectId: string;
}

export interface KnowledgeCandidateInput {
  sourceSessionId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags?: string[];
  references?: string[];
  appliesTo?: string[];
  rationale: string;
}

export interface KnowledgeCandidate {
  id: string;
  requestId: string;
  projectId: string;
  projectName?: string;
  sessionId?: string;
  sessionTitle?: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string[];
  references: string[];
  appliesTo: string[];
  rationale: string;
  status: KnowledgeCandidateStatus;
  knowledgeId?: string;
  createdAt: string;
  decidedAt?: string;
  /** Candidates decided before Agent review existed read as "user". */
  reviewedBy?: ReviewActor;
  reviewReason?: string;
  reviewRequestId?: string;
  overlaps?: KnowledgeCandidateOverlap[];
}

export interface KnowledgeCandidateSourceSession {
  id: string;
  title: string;
  summary: string;
  completedAt: string;
  workSummary?: Pick<WorkSummarySections, "outcomes" | "decisions" | "nextSteps">;
  handoff?: string;
  handoffTruncated?: boolean;
}

export interface KnowledgeCandidateContext {
  outcome: "knowledge_candidate_context";
  request: KnowledgeCandidateRequest;
  sessions: KnowledgeCandidateSourceSession[];
  omittedWorkSummarySections: Array<"scope" | "verification">;
  sessionReadWith: "work_get_session";
  existingKnowledge: Array<{
    id: string;
    kind: KnowledgeKind;
    title: string;
    status?: "archived" | "rejected" | "proposed";
  }>;
  existingKnowledgeOmitted?: number;
}

export interface KnowledgeCandidateOverlap {
  relation: "possible_duplicate" | "overlaps_archived" | "overlaps_rejected";
  type: "knowledge" | "candidate";
  id: string;
  title?: string;
  status: "active" | "archived" | "proposed" | "rejected";
  /** Token overlap of title and body, 0–1, rounded to two decimals. */
  score: number;
}

export type KnowledgeCandidateSkippedResult = {
  outcome: "skipped";
  projectRoot?: string;
  projectStatus: PolicyStatus;
  reason: string;
};

export type RequestKnowledgeCandidatesResult =
  | {
      outcome: "knowledge_candidate_request";
      duplicate: boolean;
      request: KnowledgeCandidateRequest;
      remaining?: KnowledgeCandidateBacklogCounts;
    }
  | { outcome: "knowledge_candidates_not_needed"; reason: string }
  | KnowledgeCandidateSkippedResult;

export type CancelKnowledgeCandidateRequestResult =
  | { outcome: "knowledge_candidate_request_cancelled"; request: KnowledgeCandidateRequest; duplicate: boolean }
  | { outcome: "not_found"; requestId: string; reason: string }
  | { outcome: "request_not_open"; request: KnowledgeCandidateRequest; reason: string }
  | KnowledgeCandidateSkippedResult;

export type KnowledgeCandidateContextResult =
  | KnowledgeCandidateContext
  | { outcome: "not_found"; requestId?: string; reason: string }
  | { outcome: "request_not_open"; request: KnowledgeCandidateRequest; reason: string }
  | KnowledgeCandidateSkippedResult;

export type SubmitKnowledgeCandidatesResult =
  | {
      outcome: "knowledge_candidates_submitted";
      duplicate?: true;
      request: KnowledgeCandidateRequest;
      candidates: KnowledgeCandidate[];
      redactions?: RedactionSummary;
      next?: { requestId: string; sourceSessions: number; remaining: KnowledgeCandidateBacklogCounts };
    }
  | { outcome: "not_found"; requestId: string; reason: string }
  | { outcome: "request_not_open"; request: KnowledgeCandidateRequest; reason: string }
  | { outcome: "invalid_candidates"; reason: string }
  | KnowledgeCandidateSkippedResult;

export const KNOWLEDGE_PAGE_DEFAULTS = [
  {
    slug: "architecture",
    title: "架構與慣例",
    question: "這個專案的架構、模組分工與開發慣例是什麼？",
  },
  {
    slug: "in-progress",
    title: "進行中的工作與未結項",
    question: "目前有哪些尚未完成或尚未驗證的事項與已知限制？",
  },
  {
    slug: "pitfalls",
    title: "常見陷阱",
    question: "在這個專案工作時，最常遇到的陷阱、錯誤與注意事項是什麼？",
  },
] as const;

/** The default pages answer the fixed questions every project has, so they cannot be deleted. */
export function isDefaultKnowledgePageSlug(slug: string): boolean {
  return KNOWLEDGE_PAGE_DEFAULTS.some((page) => page.slug === slug);
}
export const KNOWLEDGE_PAGE_AUTHORS = ["agent", "web"] as const;
export type KnowledgePageAuthor = (typeof KNOWLEDGE_PAGE_AUTHORS)[number];
export type KnowledgePageStatus = "empty" | "fresh" | "has_new_data";
export const KNOWLEDGE_PAGE_INSUFFICIENT = "資料不足";
/** A section keeps its newest this many source Sessions; an agent save citing more is trimmed, not rejected. */
export const KNOWLEDGE_PAGE_SECTION_SOURCE_LIMIT = 20;

export interface KnowledgePageSection {
  heading: string;
  content: string;
  sourceSessionIds: string[];
}

export type KnowledgePageReviewReason =
  | "source_updated_after_save"
  | "source_voided_after_save"
  | "source_restored_after_save"
  | "source_missing"
  | "source_state_unknown";

export interface KnowledgePageReviewSource {
  sourceSessionId: string;
  title: string;
  reasons: KnowledgePageReviewReason[];
}

export interface KnowledgePageReviewSection {
  heading: string;
  sources: KnowledgePageReviewSource[];
  omittedSourceCount?: number;
  reasons?: KnowledgePageReviewReason[];
}

export interface KnowledgePageRecord {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  question: string;
  sections: KnowledgePageSection[];
  version: number;
  status: KnowledgePageStatus;
  newSessionCount: number;
  checkedThrough?: { sessionId: string; completedAt: string };
  needsReview?: boolean;
  reviewSections?: KnowledgePageReviewSection[];
  lastAuthor?: KnowledgePageAuthor;
  /** When the page was last written (its content reflects Sessions up to this time). */
  sourcedThrough?: string;
  updateRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgePageVersionRecord {
  id: string;
  pageId: string;
  version: number;
  title: string;
  question: string;
  sections: KnowledgePageSection[];
  author: KnowledgePageAuthor;
  createdAt: string;
}

export interface KnowledgePageListQuery {
  projectRoot?: string;
  projectId?: string;
}

export interface RequestKnowledgePageUpdateInput {
  projectRoot: string;
  slug: string;
  /** Required with question for a page that is not one of the defaults. */
  title?: string;
  question?: string;
}

export interface KnowledgePageContextQuery {
  projectRoot: string;
  slug: string;
  query?: string;
  headings?: string[];
  reviewOnly?: boolean;
}

export interface SaveKnowledgePageInput {
  projectRoot: string;
  slug: string;
  idempotencyKey: string;
  sections?: KnowledgePageSection[];
  upsertSections?: KnowledgePageSection[];
  removeHeadings?: string[];
  /**
   * The reviewToken of the page-context read, passed back unchanged. A changed page is refused with version_conflict;
   * without it, no version check is made.
   */
  reviewToken?: string;
  /** Section update only: also advance the review cursor to this Session, with the markChecked rules. */
  checkedThroughSessionId?: string;
}

export interface MarkKnowledgePageCheckedInput {
  projectRoot: string;
  slug: string;
  throughSessionId: string;
}

export type MarkKnowledgePageCheckedResult =
  | { outcome: "knowledge_page_checked"; page: KnowledgePageRecord }
  | { outcome: "not_found"; slug: string; reason: string }
  | { outcome: "invalid_cursor"; reason: string }
  | KnowledgePageSkippedResult;

export interface UpdateKnowledgePageInput {
  pageId: string;
  title?: string;
  sections: KnowledgePageSection[];
  baseVersion?: number;
}

export interface KnowledgePageContextSession {
  id: string;
  title: string;
  completedAt: string;
  workSummary: Pick<WorkSummarySections, "outcomes" | "decisions" | "nextSteps">;
  truncated?: boolean;
  reasons?: KnowledgePageContextSessionReason[];
}

export type KnowledgePageContextSessionReason = "new" | "source_changed";

export type KnowledgePageSectionReviewReason =
  KnowledgePageReviewReason | "new_session_linked" | "new_session_shared_files";

export interface KnowledgePageContext {
  outcome: "knowledge_page_context";
  page: KnowledgePageRecord;
  mode: "full" | "review";
  sessions: KnowledgePageContextSession[];
  omittedSessionFields: Array<"summary" | "workSummary.scope" | "workSummary.verification">;
  sessionReadWith: "work_get_session";
  truncated: boolean;
  reviewToken: string;
  size?: KnowledgePageSize;
  splitSuggestion?: KnowledgePageSplitSuggestion;
  emptyPageHint?: string;
}

export interface KnowledgePageFocusedContext {
  outcome: "knowledge_page_context";
  focused: true;
  match: "sections" | "none";
  page: Pick<KnowledgePageRecord, "slug" | "title" | "version" | "status" | "newSessionCount" | "updatedAt"> & {
    needsReview?: true;
    updateRequestedAt?: string;
  };
  sections: Array<KnowledgePageSection & { needsReview?: true }>;
  reviewToken: string;
  otherSections: Array<{ heading: string; chars: number }>;
  sessionsOmitted: true;
  readFullWith: string;
  size?: KnowledgePageSize;
  splitSuggestion?: KnowledgePageSplitSuggestion;
  emptyPageHint?: string;
}

export interface KnowledgePageReviewContext {
  outcome: "knowledge_page_context";
  reviewOnly: true;
  review: "sections" | "new_sessions" | "none" | "full_rewrite" | "use_full_read";
  page: KnowledgePageFocusedContext["page"];
  sections: Array<
    KnowledgePageSection & {
      reasons: KnowledgePageSectionReviewReason[];
      changedSources?: Array<Pick<KnowledgePageReviewSource, "sourceSessionId" | "reasons">>;
      newSessionIds?: string[];
    }
  >;
  otherSections: Array<{ heading: string; chars: number }>;
  size: KnowledgePageSize;
  splitSuggestion?: KnowledgePageSplitSuggestion;
  sessions: KnowledgePageContextSession[];
  unmappedSessions: Array<Pick<KnowledgePageContextSession, "id" | "title" | "completedAt">>;
  checkedThroughCandidate?: string;
  omittedSessionFields: KnowledgePageContext["omittedSessionFields"];
  sessionReadWith: "work_get_session";
  truncated: boolean;
  reviewToken: string;
  readFullWith: string;
  emptyPageHint?: string;
}

export type KnowledgePageSkippedResult = {
  outcome: "skipped";
  projectRoot?: string;
  projectStatus: PolicyStatus;
  reason: string;
};

export type KnowledgePageListResult =
  { outcome: "knowledge_pages"; items: KnowledgePageRecord[] } | KnowledgePageSkippedResult;

export type RequestKnowledgePageUpdateResult =
  | { outcome: "knowledge_page_update_requested"; page: KnowledgePageRecord; redactions?: RedactionSummary }
  | { outcome: "invalid_page"; reason: string }
  | KnowledgePageSkippedResult;

export type KnowledgePageNotFoundReasonCode =
  "page_id_as_slug" | "slug_looks_like_id" | "slug_near_match" | "page_not_requested" | "page_unknown";

export interface KnowledgePageNotFoundResult {
  outcome: "not_found";
  slug: string;
  reasonCode: KnowledgePageNotFoundReasonCode;
  reason: string;
  /** The slug to call again with: the page whose id was passed, or the nearest existing or default slug. */
  suggestedSlug?: string;
  existingSlugs: string[];
  existingSlugsOmittedCount?: number;
}

export type KnowledgePageContextResult =
  | KnowledgePageContext
  | KnowledgePageFocusedContext
  | KnowledgePageReviewContext
  | KnowledgePageNotFoundResult
  | KnowledgePageSkippedResult;

/** Sent with a version_conflict so the Agent can reapply only its edits to the current page. */
export interface KnowledgePageRetryMaterial {
  reviewToken: string;
  /** Headings that were replaced, added or removed after the token's version; absent when that version is unknown. */
  changedHeadings?: string[];
}

export interface KnowledgePageVersionConflictResult extends Partial<KnowledgePageRetryMaterial> {
  outcome: "version_conflict";
  reason: string;
  baseVersion: number;
  currentVersion: number;
}

export interface KnowledgePageSectionChanges {
  replaced: string[];
  added: string[];
  removed: string[];
}

export type SaveKnowledgePageResult =
  | {
      outcome: "knowledge_page_saved";
      duplicate: boolean;
      page: KnowledgePageRecord;
      redactions?: RedactionSummary;
      sectionChanges?: KnowledgePageSectionChanges;
      warnings?: string[];
      /** Source Sessions cut from sections that cited more than the limit, oldest first, by section heading. */
      droppedSourceSessionIds?: Array<{ heading: string; sessionIds: string[] }>;
      size?: KnowledgePageSize;
      splitSuggestion?: KnowledgePageSplitSuggestion;
    }
  | { outcome: "not_found"; slug: string; reason: string }
  | { outcome: "invalid_sources"; reason: string; sessionIds: string[] }
  | { outcome: "invalid_review_token"; reason: string; fix?: string }
  | { outcome: "invalid_cursor"; reason: string }
  /** The idempotencyKey already saved different sections for this page; nothing was written. */
  | { outcome: "idempotency_conflict"; reason: string }
  /** removeHeadings the page has no section for, as sent; nothing was written. */
  | { outcome: "section_not_found"; reason: string; headings: string[] }
  /** The merged page would have no sections, more than maxSections, or more than maxContentChars; nothing was written. */
  | {
      outcome: "page_limit_exceeded";
      reason: string;
      sectionCount: number;
      maxSections: number;
      contentChars: number;
      maxContentChars: number;
      splitSuggestion?: KnowledgePageSplitSuggestion;
    }
  | KnowledgePageVersionConflictResult
  | KnowledgePageSkippedResult;

export type UpdateKnowledgePageResult =
  | { outcome: "knowledge_page_updated"; page: KnowledgePageRecord; redactions?: RedactionSummary }
  | { outcome: "not_found"; pageId: string; reason: string }
  | { outcome: "invalid_sources"; reason: string; sessionIds: string[] }
  | KnowledgePageVersionConflictResult
  | KnowledgePageSkippedResult;

export type KnowledgePageVersionsResult =
  | {
      outcome: "knowledge_page_versions";
      page: KnowledgePageRecord;
      versions: KnowledgePageVersionRecord[];
      /** Every stored version of the page; versions lists at most the newest 50. */
      versionCount: number;
      sources: Array<{ id: string; title: string }>;
    }
  | { outcome: "not_found"; pageId: string; reason: string }
  | KnowledgePageSkippedResult;

export interface KnowledgePageDeletionCounts {
  knowledgePageVersions: number;
  attentionPreferences: number;
}

export type DeleteKnowledgePageResult =
  | {
      outcome: "knowledge_page_deleted";
      pageId: string;
      projectId: string;
      slug: string;
      deletedAt: string;
      deletedCounts: KnowledgePageDeletionCounts;
    }
  | KnowledgePageSkippedResult;

export interface KnowledgePageDigest {
  slug: string;
  title: string;
  status: KnowledgePageStatus;
  newSessionCount: number;
  updatedAt: string;
  content: string;
  sourceSessionIds: string[];
  sourceSessionIdsOmittedCount?: number;
  truncated: boolean;
  needsReview?: boolean;
  reviewSections?: KnowledgePageReviewSection[];
}

export interface KnowledgeCandidateListInput {
  projectRoot?: string;
  status?: KnowledgeCandidateStatus;
  reviewedBy?: "agent";
}

export type KnowledgeCandidateListResult =
  | {
      outcome: "knowledge_candidates";
      items: KnowledgeCandidate[];
      openRequests: KnowledgeCandidateRequest[];
      backlog: KnowledgeCandidateBacklog[];
    }
  | KnowledgeCandidateSkippedResult;

export interface DecideKnowledgeCandidateInput {
  candidateId: string;
  decision: "accept" | "reject";
  edits?: Partial<Pick<KnowledgeCandidate, "kind" | "title" | "body" | "tags" | "references" | "appliesTo">>;
}

export type DecideKnowledgeCandidateResult =
  | { outcome: "knowledge_candidate_decided"; candidate: KnowledgeCandidate; knowledge?: KnowledgeRecord }
  | { outcome: "not_found"; candidateId: string }
  | { outcome: "already_decided"; candidate: KnowledgeCandidate }
  | KnowledgeCandidateSkippedResult;

export type ProjectScopedItem<T extends { projectId: string }> = Omit<T, "projectId" | "projectName"> & {
  projectId?: string;
  projectName?: string;
};

export interface ContextResult {
  outcome: "context";
  projectStatus?: "tracked";
  tracked?: true;
  clock: ServerClock;
  project?: ProjectRecord;
  projects: ProjectRecord[];
  recentSessions: ProjectScopedItem<SessionDigest>[];
  recentDecisions: DecisionDigest[];
  recentKnowledge: ProjectScopedItem<KnowledgeDigest>[];
  pendingOutstandingItems: ProjectScopedItem<ContextOutstandingItem>[];
  pendingOutstandingItemsTotal: number;
  pendingOutstandingItemsOmitted: number;
  pendingOutstandingItemsTruncated: number;
  metadataFollowUps: MetadataBackfillPreview["totals"];
  /** Pending or processing Agent requests in this scope, newest first (at most 5 of each kind); Knowledge candidate requests also list failed ones, which block a new request until resumed. */
  pendingRequests: {
    reportSynthesis: Array<ReportSynthesisRequest & { sourceSessionIdsOmittedCount?: number }>;
    metadataBackfill: MetadataBackfillRequest[];
    outstandingCleanup?: OutstandingCleanupRequest[];
    knowledgeCandidates: KnowledgeCandidateRequest[];
    knowledgeBacklog?: {
      uncoveredSessions: number;
      highValueSessions: number;
      requestWith: "work_request_knowledge_candidates";
    };
    agentDecisions: number;
    knowledgePages: Array<{
      slug: string;
      title: string;
      status: KnowledgePageStatus;
      newSessionCount: number;
      updateRequested: boolean;
      needsReview?: boolean;
    }>;
  };
  /** User-confirmed project conventions (at most 5, titles at most 60 characters); never trimmed by the budget. */
  conventions?: {
    readWith: "work_get_knowledge_history";
    items: Array<{ id: string; title: string }>;
  };
  relevant?: RelevantContext;
  knowledgePages: KnowledgePageDigest[];
  omitted?: ContextOmission[];
}

export interface ContextOmission {
  section: string;
  count: number;
  duplicates?: number;
  ids?: string[];
  moreIds?: number;
  reasons?: string[];
  entries?: Array<{
    id: string;
    /** Path-matched Knowledge only: its title, at most 60 characters. */
    title?: string;
    path?: string;
    possiblyStale?: true;
    staleReason?: "broad_applies_to";
    broadChangesSince?: number;
    needsReview?: true;
  }>;
  readWith: string;
}

export interface RelevantKnowledgePageDigest {
  id: string;
  projectId?: string;
  projectName?: string;
  slug: string;
  title: string;
  status: KnowledgePageStatus;
  newSessionCount: number;
  needsReview?: boolean;
  reviewSections?: KnowledgePageReviewSection[];
  sections: Array<{
    heading: string;
    content: string;
    sourceSessionIds: string[];
    sourceSessionIdsOmittedCount?: number;
    truncated: boolean;
    reviewSources?: KnowledgePageReviewSource[];
    reviewOmittedSourceCount?: number;
    reviewReasons?: KnowledgePageReviewReason[];
  }>;
}

export type RecallField =
  | "title"
  | "summary"
  | "workSummary"
  | "changedFiles"
  | "branch"
  | "event"
  | "raw"
  | "body"
  | "tags"
  | "references"
  | "path";

export interface RecallHit {
  type: "session" | "knowledge";
  id: string;
  projectId: string;
  projectName?: string;
  title: string;
  kind?: KnowledgeKind;
  date: string;
  matchedIn: RecallField[];
  matchedVia?: "synonym";
  section?: string;
  excerpt: string;
  truncated?: boolean;
  matchedPaths?: string[];
  score: number;
  possiblyStale?: boolean;
  staleReason?: "broad_applies_to";
  broadChangesSince?: number;
  needsReview?: boolean;
  evidence?: { confirmed: number; contradicted: number };
  related?: Array<{ id: string; title: string; relation: SessionLinkDirection }>;
}

export type ContextSupplementReason =
  | { kind: "related_session"; sourceSessionId: string; relation: "parent" | "related" }
  | { kind: "applied_knowledge"; sourceSessionId: string }
  | { kind: "inferred_path"; path: string; sourceSessionIds: string[] };

export type ContextSupplementIndicator =
  | {
      type: "session";
      id: string;
      title: string;
      includedBecause: Extract<ContextSupplementReason, { kind: "related_session" }>;
    }
  | {
      type: "knowledge";
      id: string;
      title: string;
      includedBecause: Extract<ContextSupplementReason, { kind: "applied_knowledge" | "inferred_path" }>;
      possiblyStale?: boolean;
      staleReason?: "broad_applies_to";
      broadChangesSince?: number;
      needsReview?: boolean;
    };

export interface RecallTermHits {
  term: string;
  count: number;
}

export type RecallConfidence = "none" | "low" | "high";

export interface RecallResult {
  outcome: "recall";
  project?: ProjectRecord;
  hits: RecallHit[];
  confidence: RecallConfidence;
  knowledgeConfidence: RecallConfidence;
  termHits?: RecallTermHits[];
  termHitsTruncated?: true;
  warnings?: string[];
}

export type RecallQueryResult = RecallResult | SkippedContextResult;

/** Inclusive calendar dates (YYYY-MM-DD) in the server's time zone. */
export interface DateRange {
  from?: string;
  to?: string;
}

export interface RecallInput extends DateRange {
  q?: string;
  paths?: string[];
  projectRoot?: string;
  limit?: number;
}

export const OUTSTANDING_CLEANUP_REQUEST_STATUSES = ["pending", "awaiting_review", "completed", "cancelled"] as const;
export type OutstandingCleanupRequestStatus = (typeof OUTSTANDING_CLEANUP_REQUEST_STATUSES)[number];
export const OUTSTANDING_CLEANUP_PROPOSAL_STATUSES = ["pending", "accepted", "rejected"] as const;
export type OutstandingCleanupProposalStatus = (typeof OUTSTANDING_CLEANUP_PROPOSAL_STATUSES)[number];
export const OUTSTANDING_CLEANUP_PROPOSAL_KINDS = ["resolution", "acknowledged"] as const;
export type OutstandingCleanupProposalKind = (typeof OUTSTANDING_CLEANUP_PROPOSAL_KINDS)[number];
export const OUTSTANDING_CLEANUP_VERDICT_STATUSES = ["completed", "not_needed", "acknowledged"] as const;
export type OutstandingCleanupVerdictStatus = (typeof OUTSTANDING_CLEANUP_VERDICT_STATUSES)[number];

export interface OutstandingCleanupRequest {
  id: string;
  projectId: string;
  projectName: string;
  projectNameTruncated?: boolean;
  status: OutstandingCleanupRequestStatus;
  requestedAt: string;
  completedAt?: string;
  itemCount: number;
  examinedCount: number;
  proposalCount: number;
}

export interface CreateOutstandingCleanupRequestInput {
  projectId: string;
  idempotencyKey: string;
}

export interface OutstandingCleanupRequestQuery {
  projectId?: string;
  status?: OutstandingCleanupRequestStatus;
  page?: number;
  pageSize?: number;
}

export interface OutstandingCleanupContextQuery {
  requestId?: string;
  projectRoot?: string;
  itemPage?: number;
  sessionPage?: number;
  itemPageSize?: number;
  sessionPageSize?: number;
}

export interface OutstandingCleanupItem {
  id: string;
  sourceSessionId: string;
  sourceSessionTitle: string;
  sourceSessionCompletedAt: string;
  text: string;
  textTruncated?: boolean;
  sourceSessionTitleTruncated?: boolean;
  examined: boolean;
  stale: boolean;
}

export interface OutstandingCleanupSession {
  id: string;
  title: string;
  titleTruncated?: boolean;
  summary: string;
  summaryTruncated?: boolean;
  completedAt: string;
  outcomes: string[];
  outcomesOmitted: number;
  outcomesTruncated: boolean;
  verificationStatus: VerificationStatus | "not_supplied";
  branch?: string;
  branchTruncated?: boolean;
  commitSha?: string;
  commitShaTruncated?: boolean;
  pullRequests: string[];
  pullRequestsOmitted: number;
}

export interface OutstandingCleanupProposal {
  id: string;
  requestId: string;
  itemId: string;
  sourceSessionId: string;
  itemText: string;
  status: "completed" | "not_needed";
  kind: OutstandingCleanupProposalKind;
  reason: string;
  evidenceSessionIds: string[];
  reviewStatus: OutstandingCleanupProposalStatus;
  itemStatus: OutstandingItemStatus;
  createdAt: string;
  decidedAt?: string;
}

export interface SubmitOutstandingCleanupProposalsInput {
  requestId: string;
  idempotencyKey: string;
  examinedItemIds: string[];
  proposals: Array<{
    itemId: string;
    status: OutstandingCleanupVerdictStatus;
    reason: string;
    evidenceSessionIds: string[];
  }>;
}

export interface OutstandingCleanupProposalQuery {
  requestId: string;
  reviewStatus?: OutstandingCleanupProposalStatus;
  page?: number;
  pageSize?: number;
}

export interface OutstandingCleanupRejectedResult {
  outcome: "rejected";
  reason:
    | "invalid_items"
    | "invalid_proposals"
    | "invalid_evidence"
    | "stale_proposal"
    | "already_examined"
    | "idempotency_conflict"
    | "request_closed"
    | "active_request_exists"
    | "too_many_items"
    | "context_too_large";
  itemIds?: string[];
  requestId?: string;
  hint?: string;
}

export type OutstandingCleanupFailure =
  OutstandingCleanupRejectedResult | ProjectIdSkippedResult | { outcome: "not_found"; requestId: string };
export type CreateOutstandingCleanupRequestResult =
  | { outcome: "outstanding_cleanup_request_created"; request: OutstandingCleanupRequest; duplicate: boolean }
  | { outcome: "not_needed"; projectId: string }
  | OutstandingCleanupRejectedResult
  | ProjectIdSkippedResult;
export type RequestOutstandingCleanupResult =
  | Extract<CreateOutstandingCleanupRequestResult, { outcome: "outstanding_cleanup_request_created" | "not_needed" }>
  | { outcome: "outstanding_cleanup_request_active"; request: OutstandingCleanupRequest }
  | OutstandingCleanupRejectedResult
  | KnowledgeCandidateSkippedResult;
export type OutstandingCleanupRequestListResult =
  | { outcome: "outstanding_cleanup_requests"; requests: OutstandingCleanupRequest[]; pageInfo: PageInfo }
  | ProjectIdSkippedResult;
export type OutstandingCleanupContextResult =
  | {
      outcome: "outstanding_cleanup_context";
      request: OutstandingCleanupRequest;
      items: OutstandingCleanupItem[];
      itemPageInfo: PageInfo;
      sessions: OutstandingCleanupSession[];
      sessionPageInfo: PageInfo;
      hint: string;
      truncated: boolean;
    }
  | { outcome: "no_open_request"; projectId: string }
  | KnowledgeCandidateSkippedResult
  | OutstandingCleanupFailure;
export type SubmitOutstandingCleanupProposalsResult =
  | {
      outcome: "outstanding_cleanup_proposals_submitted";
      request: OutstandingCleanupRequest;
      examinedItemIds: string[];
      proposalIds: string[];
      duplicate: boolean;
    }
  | OutstandingCleanupFailure;
export type OutstandingCleanupProposalListResult =
  | {
      outcome: "outstanding_cleanup_proposals";
      request: OutstandingCleanupRequest;
      proposals: OutstandingCleanupProposal[];
      pageInfo: PageInfo;
    }
  | OutstandingCleanupFailure;
export type CancelOutstandingCleanupRequestResult =
  | { outcome: "outstanding_cleanup_request_cancelled"; request: OutstandingCleanupRequest; duplicate: boolean }
  | OutstandingCleanupFailure;

export const AGENT_REVIEW_REQUEST_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"] as const;
export type AgentReviewRequestStatus = (typeof AGENT_REVIEW_REQUEST_STATUSES)[number];
export type AgentReviewItemKind = "decision" | "candidate" | "knowledge";
export type AgentReviewVerdictKind = "confirm" | "reject" | "promote" | "accept" | "archive" | "supersede";
export type AgentReviewItemOutcome = "applied" | "skipped_stale" | "skipped_reviewed";
export type AgentReviewItemState = "open" | "applied" | "skipped" | "stale" | "reviewed";

export interface AgentReviewRequest {
  id: string;
  projectId: string;
  projectName?: string;
  status: AgentReviewRequestStatus;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  itemCount: number;
  omittedCount: number;
  decisionCount: number;
  candidateCount: number;
  knowledgeCount: number;
  appliedCount: number;
  skippedCount: number;
  openCount: number;
  /** Only the Web list of completed requests carries this; MCP results never do. */
  knowledgePages?: AgentReviewRequestPage[];
}

export interface AgentReviewRequestQuery {
  projectId?: string;
  status?: AgentReviewRequestStatus;
  page?: number;
  pageSize?: number;
}

export interface CreateAgentReviewRequestInput {
  projectId: string;
  idempotencyKey: string;
}

export interface RequestAgentReviewInput {
  projectRoot: string;
  idempotencyKey: string;
}

export interface AgentReviewContextQuery {
  requestId?: string;
  projectRoot?: string;
  page?: number;
  pageSize?: number;
}

export interface AgentReviewKnowledgeDraft {
  kind?: KnowledgeKind;
  title: string;
  body: string;
  tags?: string[];
  references?: string[];
  appliesTo?: string[];
}

export type AgentReviewVerdict =
  | {
      itemKind: "decision";
      itemId: string;
      verdict: "confirm" | "reject" | "promote";
      reason: string;
      knowledge?: AgentReviewKnowledgeDraft;
    }
  | {
      itemKind: "candidate";
      itemId: string;
      verdict: "accept" | "reject";
      reason: string;
      edits?: Partial<Pick<KnowledgeCandidate, "kind" | "title" | "body" | "tags" | "references" | "appliesTo">>;
    }
  | {
      itemKind: "knowledge";
      itemId: string;
      verdict: "confirm" | "archive" | "supersede";
      reason: string;
      knowledge?: Partial<Pick<AgentReviewKnowledgeDraft, "kind" | "tags" | "references" | "appliesTo">> &
        Pick<AgentReviewKnowledgeDraft, "title" | "body">;
    };

export interface SubmitAgentReviewVerdictsInput {
  requestId: string;
  idempotencyKey: string;
  verdicts: AgentReviewVerdict[];
  complete?: boolean;
}

export interface AgentReviewSessionContext {
  id: string;
  title: string;
  titleTruncated?: boolean;
  completedAt: string;
  outcomes: string[];
  outcomesTruncated?: boolean;
  otherDecisions: string[];
  otherDecisionsTruncated?: boolean;
}

export interface AgentReviewLaterSession {
  id: string;
  title: string;
  completedAt: string;
  paths: string[];
}

export interface AgentReviewKnowledgeDoubt {
  possiblyStale?: Pick<KnowledgeStaleness, "reason" | "sessionCount">;
  contradicted?: { sessionId?: string; sessionTitle?: string; at: string };
}

export interface AgentReviewContextItem {
  itemKind: AgentReviewItemKind;
  id: string;
  state: AgentReviewItemState;
  sourceSession?: AgentReviewSessionContext;
  text?: string;
  textTruncated?: boolean;
  kind?: KnowledgeKind;
  title?: string;
  body?: string;
  rationale?: string;
  tags?: string[];
  references?: string[];
  appliesTo?: string[];
  bodyTruncated?: boolean;
  rationaleTruncated?: boolean;
  titleTruncated?: boolean;
  doubt?: AgentReviewKnowledgeDoubt;
  createdAt?: string;
  lastConfirmedAt?: string;
  laterSessions?: AgentReviewLaterSession[];
  laterSessionsOmitted?: number;
  overlaps: KnowledgeCandidateOverlap[];
}

export interface AgentReviewContext {
  outcome: "agent_review_context";
  request: AgentReviewRequest;
  items: AgentReviewContextItem[];
  pageInfo: PageInfo;
  existingKnowledge?: Array<{ id: string; kind: KnowledgeKind; title: string; status?: "archived" | "rejected" }>;
  existingKnowledgeOmitted?: number;
  truncated: boolean;
  hint: string;
}

export type AgentReviewRejectedReason =
  "idempotency_conflict" | "request_not_open" | "request_closed" | "not_agent_reviewed" | "context_too_large";

export type AgentReviewSkippedResult = KnowledgeCandidateSkippedResult | ProjectIdSkippedResult;

export type AgentReviewFailure =
  | AgentReviewSkippedResult
  | { outcome: "rejected"; reason: AgentReviewRejectedReason; requestId?: string }
  | { outcome: "not_found"; requestId?: string; itemId?: string };

export type CreateAgentReviewRequestResult =
  | {
      outcome: "agent_review_request";
      request: AgentReviewRequest;
      duplicate: boolean;
      remaining?: number;
    }
  | { outcome: "agent_review_not_needed"; projectId: string; reason: string }
  | AgentReviewFailure;

export type RequestAgentReviewResult = CreateAgentReviewRequestResult;

export type AgentReviewRequestListResult =
  { outcome: "agent_review_requests"; requests: AgentReviewRequest[]; pageInfo: PageInfo } | AgentReviewSkippedResult;

export interface AgentReviewPendingProject {
  projectId: string;
  projectName: string;
  decisionCount: number;
  candidateCount: number;
  knowledgeCount: number;
}

export type AgentReviewPendingListResult = { outcome: "agent_review_pending"; projects: AgentReviewPendingProject[] };

export type AgentReviewContextResult =
  | AgentReviewContext
  | { outcome: "request_not_open"; request: AgentReviewRequest; reason: string }
  | AgentReviewFailure;

export interface AgentReviewVerdictResult {
  itemKind: AgentReviewItemKind;
  itemId: string;
  outcome: AgentReviewItemOutcome | "not_in_request" | "knowledge_rejected";
  knowledgeId?: string;
  knowledgeOutcome?: string;
  knowledgeReason?: string;
  conventionWithdrawn?: true;
}

export interface AgentReviewKnowledgePage {
  slug: string;
  title: string;
  reasons: Array<"cites_reviewed_session" | "queued_for_update">;
}

export type AgentReviewPageState = "pending" | "updated" | "checked" | "unchanged";

export interface AgentReviewRequestPage extends AgentReviewKnowledgePage {
  state: AgentReviewPageState;
}

export type SubmitAgentReviewVerdictsResult =
  | {
      outcome: "agent_review_verdicts_submitted";
      request: AgentReviewRequest;
      results: AgentReviewVerdictResult[];
      duplicate: boolean;
      redactions?: RedactionSummary;
      warnings?: string[];
      completion?: { knowledgePages: AgentReviewKnowledgePage[] };
    }
  | AgentReviewFailure;

export type CancelAgentReviewRequestResult =
  { outcome: "agent_review_request_cancelled"; request: AgentReviewRequest; duplicate: boolean } | AgentReviewFailure;

export interface OverturnAgentReviewInput {
  projectRoot: string;
  itemKind: AgentReviewItemKind;
  itemId: string;
}

export type OverturnAgentReviewResult =
  | {
      outcome: "agent_review_overturned";
      itemKind: AgentReviewItemKind;
      decision?: SessionDecisionRecord;
      candidate?: KnowledgeCandidate;
      reviewedKnowledge?: {
        knowledge: KnowledgeRecord;
        action: "confirmation_withdrawn" | "restored" | "unchanged";
      };
      knowledge?: {
        id?: string;
        action: "archived" | "unchanged" | "missing";
        status?: KnowledgeStatus;
      };
    }
  | AgentReviewFailure;

export interface AgentReviewedKnowledgeQuery {
  projectRoot?: string;
}

export interface AgentReviewedKnowledge {
  knowledge: KnowledgeRecord;
  verdict: "confirm" | "archive" | "supersede";
  reason: string;
  reviewedAt: string;
  requestId: string;
  successor?: { id: string; title: string; status: KnowledgeStatus };
}

export type AgentReviewedKnowledgeListResult =
  { outcome: "agent_reviewed_knowledge"; items: AgentReviewedKnowledge[] } | AgentReviewSkippedResult;

export interface RelatedOutstandingItems {
  items: Array<{
    id: string;
    sourceSessionId: string;
    sourceSessionTitle: string;
    sourceSessionCompletedAt: string;
    text: string;
    textTruncated?: boolean;
    sourceSessionTitleTruncated?: boolean;
    /** The item names an issue or version that this Session's own title, summary or outcomes also name. */
    possiblyDone?: true;
    /** Index in this Session's nextSteps of an entry that names an issue this pending item also names. */
    possibleDuplicateOf?: number;
  }>;
  total: number;
  omitted: number;
  truncated?: true;
  hint?: string;
}

export interface ContextRelatedOutstandingItems extends Omit<RelatedOutstandingItems, "items"> {
  items: Array<{ id: string; sourceSessionId: string; text: string; textTruncated?: boolean }>;
}

export interface RelevantContext {
  task?: string;
  paths?: string[];
  confidence: RecallConfidence;
  knowledgeConfidence: RecallConfidence;
  knowledgeHint?: string;
  knowledge: ProjectScopedItem<RecallHit>[];
  decisions: RelevantDecisionDigest[];
  outstandingItems?: ContextRelatedOutstandingItems;
  /** Pending items of the Sessions passed as linkedSessionIds (same project, at most 10); not repeated in outstandingItems. */
  continuedOutstandingItems?: ContextRelatedOutstandingItems;
  sessions: Array<ProjectScopedItem<RecallHit> & { openItems: string[] }>;
  supplements?: ContextSupplementIndicator[];
  knowledgePages?: RelevantKnowledgePageDigest[];
  termHits?: RecallTermHits[];
  termHitsTruncated?: true;
  hotspots?: HotspotHint[];
  fileHistoryReadWith?: "work_get_file_history";
}

export interface TimelineQuery extends DateRange {
  projectRoot?: string;
  projectId?: string;
}

export interface TimelineSession {
  id: string;
  projectId: string;
  title: string;
  startedAt?: string;
  completedAt: string;
  verificationStatus: ReportVerificationStatus;
}

export const TIMELINE_KNOWLEDGE_EVENTS = ["created", "confirmed", "contradicted", "superseded"] as const;
export type TimelineKnowledgeEventKind = (typeof TIMELINE_KNOWLEDGE_EVENTS)[number];

export interface TimelineKnowledgeEvent {
  knowledgeId: string;
  projectId: string;
  title: string;
  kind: TimelineKnowledgeEventKind;
  at: string;
  sessionId?: string;
  supersededById?: string;
}

export interface TimelineLink {
  sessionId: string;
  relatedSessionId: string;
  relation: "continues" | "related";
}

export type TimelineResult =
  | {
      outcome: "timeline";
      from: string;
      to: string;
      projects: Array<{ id: string; name: string }>;
      sessions: TimelineSession[];
      knowledgeEvents: TimelineKnowledgeEvent[];
      links: TimelineLink[];
      truncated: boolean;
    }
  | SkippedContextResult;

export interface ActivityQuery {
  projectRoot?: string;
  projectId?: string;
  /** Inclusive calendar dates (YYYY-MM-DD) in the server time zone; both are required, at most 400 days apart. */
  from: string;
  to: string;
}

export interface ActivityDay {
  date: string;
  sessions: number;
}

export type ActivityResult =
  { outcome: "activity"; from: string; to: string; days: ActivityDay[] } | SkippedContextResult;

export const HOTSPOT_GROUPS = ["file", "directory"] as const;
export type HotspotGroup = (typeof HOTSPOT_GROUPS)[number];

export interface HotspotQuery extends DateRange {
  projectRoot?: string;
  projectId?: string;
  /** Default 20, at most 100. */
  limit?: number;
  /** Aggregate by file (default) or by the directory that contains it. */
  groupBy?: HotspotGroup;
}

export interface HotspotSession {
  id: string;
  title: string;
  completedAt: string;
  verificationStatus: ReportVerificationStatus;
}

export interface Hotspot {
  projectId: string;
  projectName: string;
  path: string;
  sessionCount: number;
  failedCount: number;
  notRunCount: number;
  lastChangedAt: string;
  recentSessions: HotspotSession[];
}

export type HotspotResult =
  { outcome: "hotspots"; groupBy: HotspotGroup; from?: string; to?: string; items: Hotspot[] } | SkippedContextResult;

export interface HotspotHint {
  path: string;
  days: number;
  sessionCount: number;
  failedCount: number;
  notRunCount: number;
  totalSessions: number;
}

export interface SearchResult {
  session: SessionDigest;
  matchedIn?: RecallField;
  matchedVia?: "synonym";
  section?: string;
  excerpt: string;
}

export interface SearchQueryResult {
  outcome: "search";
  hits: SearchResult[];
  confidence: RecallConfidence;
  termHits?: RecallTermHits[];
  termHitsTruncated?: true;
  warnings?: string[];
}

export interface SkippedContextResult {
  outcome: "skipped";
  projectRoot: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export interface SkippedProjectContextResult extends SkippedContextResult {
  tracked: false;
}

export type ContextQueryResult = ContextResult | SkippedProjectContextResult;

export interface ProjectReader {
  getProjectByRootPath(rootPath: string): ProjectRecord | undefined;
}

export * from "./insights.js";

export interface ServerClock {
  serverTime: string;
  /** IANA time zone of the machine running Work Intelligence, e.g. `Asia/Taipei`. */
  timeZone: string;
  utcOffset: string;
}

export interface ProjectStatusResult {
  outcome: "project_status";
  clock: ServerClock;
  projectRoot: string;
  projectStatus: PolicyStatus;
  tracked: boolean;
  project?: ProjectRecord;
  reason?: string;
}

export type RawSnapshotSummary = Omit<RawSnapshotRecord, "content"> & { contentLength: number };

export interface SessionDetailResult extends Omit<SessionDetail, "session" | "rawSnapshots"> {
  outcome: "session_detail";
  session: WorkSessionRecord & AgentSessionRevision;
  rawSnapshots: Array<RawSnapshotRecord | RawSnapshotSummary>;
}

/** These values never become client-controlled SQL identifiers. */
export const SESSION_READ_FIELDS = [
  "session.summary",
  "session.workSummary.outcomes",
  "session.workSummary.scope",
  "session.workSummary.decisions",
  "session.workSummary.verification",
  "session.workSummary.nextSteps",
  "session.verification",
  "session.changedFiles",
  "session.files",
  "session.git",
  "decisions",
  "links",
  "verificationHistory",
  "voidHistory",
  "events",
  "evidence",
  "knowledge",
  "diagrams",
  "rawSnapshots",
] as const;
export type SessionReadField = (typeof SESSION_READ_FIELDS)[number];
export type SessionReadView = "completion" | "handoff";
export interface SessionAgentReadQuery {
  sessionId: string;
  includeRawSnapshots?: boolean;
  view?: SessionReadView;
  select?: SessionReadField[];
  knownRevision?: string;
}
export interface AgentSessionRevision {
  revision: string;
}
export interface SessionProjectionResult {
  outcome: "session_detail";
  projection: {
    version: 1;
    view?: SessionReadView;
    includedFields: SessionReadField[];
    unavailableFields: SessionReadField[];
  };
  session: Pick<WorkSessionRecord, "id" | "projectId" | "title" | "status" | "executionStatus" | "completedAt"> &
    AgentSessionRevision &
    Partial<
      Pick<
        WorkSessionRecord,
        | "updatedAt"
        | "voided"
        | "summary"
        | "verification"
        | "changedFiles"
        | "changedFilesProvenance"
        | "changedFileChanges"
        | "commitSha"
        | "gitBranch"
      >
    > & { workSummary?: Partial<WorkSummarySections>; files?: SessionFileEntry[] };
  decisions?: SessionDecisionRecord[];
  links?: SessionLinkRecord[];
  verificationHistory?: VerificationUpdateRecord[];
  voidHistory?: VoidAuditRecord[];
  events?: WorkEventRecord[];
  evidence?: EvidenceRecord[];
  knowledge?: KnowledgeRecord[];
  diagrams?: SessionDiagramRecord[];
  rawSnapshots?: Array<RawSnapshotRecord | RawSnapshotSummary>;
}
export interface SessionUnchangedResult {
  outcome: "session_unchanged";
  session: Pick<WorkSessionRecord, "id" | "projectId" | "title" | "voided"> & AgentSessionRevision;
}
export type SessionAgentReadResult = SessionDetailQueryResult | SessionProjectionResult | SessionUnchangedResult;

export interface SessionNotFoundResult {
  outcome: "not_found";
  sessionId: string;
  reason: string;
}

export type SessionDetailQueryResult = SessionDetailResult | SessionVerificationSkippedResult | SessionNotFoundResult;

export interface AmbiguousCommitShaResult {
  outcome: "ambiguous_commit_sha";
  commitSha: string;
  reason: string;
}

export type SessionListQueryResult =
  SessionListResult | SkippedResult | ProjectIdSkippedResult | AmbiguousCommitShaResult;

export type DatabaseBackupKind =
  "automatic" | "manual" | "migration" | "deletion" | "session_deletion" | "maintenance" | "import";

export interface DatabaseBackup {
  kind: DatabaseBackupKind;
  fileName: string;
  createdAt: string;
  bytes: number;
}

export interface DatabaseBackupListData {
  keep: number;
  automaticKeep: number;
  backups: DatabaseBackup[];
}

/** File names only: the API never exposes filesystem paths. */
export interface DatabaseBackupList extends DatabaseBackupListData {
  outcome: "database_backups";
}

export interface DatabaseBackupCreated extends DatabaseBackupList {
  created: DatabaseBackup;
}

export interface DatabaseBackupDeleted extends DatabaseBackupListData {
  outcome: "backup_deleted";
  deleted: DatabaseBackup;
}

export type DatabaseBackupDeleteResult =
  | DatabaseBackupDeleted
  | { outcome: "backup_not_found" }
  | { outcome: "invalid_backup_file_name" }
  | { outcome: "backup_unavailable"; reason: string };

export interface DatabaseBackupUnavailable {
  outcome: "backup_unavailable";
  reason: string;
}

export type DatabaseInspectionState = "missing" | "ok" | "unhealthy" | "unreadable";
export type DatabaseMaintenanceStatus = "running" | "completed" | "failed";
export type DatabaseMaintenanceFailureCode = "DATABASE_INTEGRITY_FAILED" | "DATABASE_MAINTENANCE_FAILED";

export interface DatabaseMaintenanceRecord {
  startedAt: string;
  completedAt: string | null;
  status: DatabaseMaintenanceStatus;
  backupFileName: string;
  indexedSessions: number;
  indexedKnowledge: number;
  indexedChunks: number;
  indexedPaths: number;
  failureCode: DatabaseMaintenanceFailureCode | null;
}

export type AgentSkillCopyState = "current" | "missing" | "stale" | "unreadable";

export type AgentHookInstallState = "installed" | "stale" | "missing" | "disabled" | "unknown";

export type AgentMcpRegistrationState = "registered" | "direct" | "other" | "missing" | "unknown";

export type AgentRegistrationSource = "app" | "checkout" | "plugin";

export type AgentHookStaleReason = "script-missing" | "shim-differs" | "matcher-outdated";

export interface AgentHookEventStatus {
  event: string;
  matcher: string | null;
  required: boolean;
  state: AgentHookInstallState;
  source: AgentRegistrationSource | null;
  reason?: AgentHookStaleReason;
}

export type AgentObservationState = "current" | "stale" | "none";

export interface SystemAgentConnections {
  codex: {
    observation?: AgentObservationState;
    mcpRegistered: AgentMcpRegistrationState;
    mcpSource?: AgentRegistrationSource | null;
    canonicalSkill: AgentSkillCopyState;
    legacySkill: AgentSkillCopyState;
    hook: AgentHookInstallState;
    hookSource?: AgentRegistrationSource | null;
    hookEvents?: AgentHookEventStatus[];
  };
  claudeCode: {
    observation?: AgentObservationState;
    mcpRegistered: AgentMcpRegistrationState;
    mcpSource?: AgentRegistrationSource | null;
    skill: AgentSkillCopyState;
    hook: AgentHookInstallState;
    hookSource?: AgentRegistrationSource | null;
    hookEvents?: AgentHookEventStatus[];
  };
}

export type UserServiceState = "running" | "stopped" | "not_installed" | "unavailable" | "unsupported";
export type UserServiceManager = "LaunchAgent" | "Task Scheduler" | "systemd --user";

export interface UserServiceStatus {
  supported: boolean;
  state: UserServiceState;
  manager: UserServiceManager | null;
  enabled: boolean | null;
  running: boolean | null;
  configPath: string | null;
  databasePath: string;
  backupDirectory: string;
  logPath: string;
}

export interface SqliteRuntimeStatus {
  version: string;
  walResetFixed: boolean;
  fixedIn?: string;
}

export interface SystemDesktopStatus {
  managed: true;
  legacyService?: {
    running: "running" | "stopped" | "unknown";
  };
  activePort?: number;
  loginItem?: {
    supported: boolean;
    desired: boolean;
    system: "enabled" | "disabled" | "needs-approval" | "unknown";
  };
  backupDirectory?: string;
  storageRisk?: {
    risk: "network" | "removable" | "cloud-sync" | "hard-link" | "unknown";
    migrationBlocked: boolean;
  };
  language?: {
    preference: "system" | "zh-TW" | "en";
    locale: "zh-TW" | "en";
  };
}

export interface SystemStatus {
  version: string;
  schemaVersion: number;
  database: {
    path: string;
    bytes: number | null;
    state: DatabaseInspectionState;
    schemaVersion: number | null;
    reclaimableBytes?: number;
    reclaimSuggested?: boolean;
  };
  backups: {
    available: boolean;
    latestAutomatic: DatabaseBackup | null;
    count: number;
    totalBytes: number;
  };
  maintenance: DatabaseMaintenanceRecord | null;
  userService: UserServiceStatus;
  desktop?: SystemDesktopStatus;
  mcp: {
    restartRequired: boolean;
    monitoringAvailable: boolean;
    activeProcesses: number;
    outdatedProcesses: number;
    updateAvailableProcesses: number;
    updateAvailable?: boolean;
    message?: string;
    agentObservedWithoutLease?: boolean;
    leaseDiagnosis?: {
      cause: "lease_unreported" | "directory_unwritable" | "scope_mismatch" | "agent_disconnected";
      backendScopeId: string;
      observedScopeId?: string;
      directoryWritable?: boolean;
    };
  };
  agents: SystemAgentConnections;
  sseConnections: number;
  sqlite: SqliteRuntimeStatus;
}

export const PROJECT_DATA_TABLES = [
  "projects",
  "sessions",
  "work_events",
  "raw_snapshots",
  "evidence",
  "void_audit",
  "session_verification_updates",
  "session_links",
  "knowledge",
  "session_decisions",
  "knowledge_pages",
  "knowledge_page_versions",
  "session_diagrams",
  "knowledge_audit",
  "knowledge_feedback",
  "knowledge_candidate_requests",
  "knowledge_candidates",
  "report_synthesis_requests",
  "report_summaries",
  "report_presentations",
  "attention_preferences",
  "metadata_backfill_requests",
  "session_summary_updates",
  "session_work_summary_updates",
  "outstanding_items",
  "outstanding_item_events",
  "outstanding_cleanup_requests",
  "outstanding_cleanup_submissions",
  "outstanding_cleanup_request_items",
  "outstanding_cleanup_proposals",
  "outstanding_cleanup_proposal_evidence",
  "agent_review_requests",
  "agent_review_submissions",
  "agent_review_request_items",
] as const;

export type ProjectDataTable = (typeof PROJECT_DATA_TABLES)[number];
export type ProjectDataValue = string | number | null;

export type ProjectDataRow = Record<string, ProjectDataValue>;

export type ProjectDataExportScope = { type: "all" } | { type: "project"; projectId: string };

export interface ProjectDataExport {
  format: "work-intelligence-export";
  formatVersion: 1;
  schemaVersion: number;
  exportedAt: string;
  scope: ProjectDataExportScope;
  tables: Record<ProjectDataTable, ProjectDataRow[]>;
}

export interface ProjectPathRemap {
  from: string;
  to: string;
}

/**
 * `merge` adds new rows only; `newer-wins` also replaces a mutable row when the imported copy is newer. A newer local
 * row is always kept.
 */
export const PROJECT_DATA_IMPORT_STRATEGIES = ["merge", "newer-wins"] as const;
export type ProjectDataImportStrategy = (typeof PROJECT_DATA_IMPORT_STRATEGIES)[number];

export interface ProjectDataImportInput {
  bundle: ProjectDataExport;
  projectId?: string;
  remap?: ProjectPathRemap[];
  strategy?: ProjectDataImportStrategy;
}

export type ProjectDataCounts = Partial<Record<ProjectDataTable, number>>;

export type ProjectDataImportConflictCategory =
  "path" | "newer_content" | "content" | "unique" | "dependency" | "missing_parent" | "deleted";

export interface ProjectDataImportConflict {
  table: ProjectDataTable;
  id: string;
  reason: string;
  category?: ProjectDataImportConflictCategory;
}

export interface ProjectDataImportConflictGroup {
  category: ProjectDataImportConflictCategory;
  table: ProjectDataTable;
  reason: string;
  count: number;
  sampleIds: string[];
}

export interface ProjectDataAutoRemap {
  projectId: string;
  from: string;
  to: string;
  snapshots: number;
}

export interface ProjectDataPathRemapCount {
  projects: number;
  snapshots: number;
}

export interface ProjectDataImportPreview {
  outcome: "project_data_import_preview";
  strategy: ProjectDataImportStrategy;
  additions: ProjectDataCounts;
  skipped: ProjectDataCounts;
  conflicts: ProjectDataCounts;
  updates: ProjectDataCounts;
  keptLocal: ProjectDataCounts;
  renumbered: ProjectDataCounts;
  /** Local rows deleted because a Session's decisions are replaced as a set by the imported copy. */
  replacedLocal: ProjectDataCounts;
  /** Whether applying this plan would write anything; false means the import changes nothing. */
  writesData: boolean;
  selectedProjects: Array<{
    id: string;
    name: string;
    sourceRootPath: string;
    rootPath: string;
    resolution: "existing" | "new" | "conflict";
    folderStatus?: ProjectFolderStatus;
  }>;
  remappedPaths: ProjectDataPathRemapCount[];
  autoRemaps: ProjectDataAutoRemap[];
  conflictDetails: ProjectDataImportConflict[];
  conflictDetailsTruncated: boolean;
  conflictGroups: ProjectDataImportConflictGroup[];
  /** Knowledge copies that arrive as project conventions beyond this machine's limit of 5 per project; they import as plain Knowledge. */
  conventionsWithdrawn?: number;
}

export interface ProjectDataImportStagedHeader {
  schemaVersion: number;
  exportedAt: string;
  scope: ProjectDataExportScope;
  projects: Array<{ id: string; name: string }>;
}

export interface ProjectDataImportStaged {
  stagingId: string;
  expiresAt: string;
  header: ProjectDataImportStagedHeader;
  /** The preview with the default choices (the strategy the request named), from the same pass that validated it. */
  preview: ProjectDataImportPreview;
}

export type ProjectDataStagedImportOptions = Omit<ProjectDataImportInput, "bundle">;

export interface ProjectDataImportResult extends Omit<ProjectDataImportPreview, "outcome"> {
  outcome: "project_data_imported";
  importedAt: string;
  changed: boolean;
  redactions?: RedactionSummary;
  backupFileName?: string;
}

export type FolderPickResult =
  | { outcome: "folder_picked"; path: string; name: string }
  | { outcome: "folder_pick_cancelled" }
  | { outcome: "folder_pick_busy" }
  | { outcome: "folder_pick_unavailable"; reason: string };
