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
  "database_busy",
  "PROJECT_NOT_FOUND",
  "PROJECT_NAME_MISMATCH",
  "PROJECT_BACKUP_FAILED",
  "PROJECT_DELETE_FAILED",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type PolicyStatus = ProjectStatus | "unregistered";

export const WORK_EVENT_TYPES = ["planning", "execution", "verification", "closing", "note", "finalized"] as const;

export type WorkEventType = (typeof WORK_EVENT_TYPES)[number];
export type VerificationStatus = "passed" | "failed" | "not_run";
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
] as const;
export type SensitiveDataKind = (typeof SENSITIVE_DATA_KINDS)[number];

/** Counts only: never contains the matched value or any token fragment. */
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
  /** The current path, or the deleted path when status is deleted. */
  path: string;
  status: ChangedFileChangeStatus;
  /** The old path for a rename. */
  previousPath?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  lastIngestedAt?: string;
  /** https URL of the project's repository, set by the user; used for commit links. */
  repositoryUrl?: string;
}

/**
 * A repository link the Web UI may open: an https URL with a host and no embedded credentials (a token in
 * `https://token@host/...` would be stored and shown in plain text).
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
  metadataBackfillRequests: number;
  sessionSummaryUpdates: number;
  sessionWorkSummaryUpdates: number;
  sessionDecisions: number;
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

/**
 * Stable, human-readable sections for an Agent's completed work record.
 * Empty arrays are valid when a section has nothing to report.
 */
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
  sessionTitle?: string;
  sessionCompletedAt?: string;
}

export interface ListSessionDecisionsInput {
  projectRoot?: string;
  status?: "pending" | "all";
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
  /** Number of sensitive values removed from this Session's persisted text. */
  redactionCount?: number;
  status: "finalized";
  executionStatus: ExecutionStatus;
  /** When the work began, if the Agent reported it or an event predates completion; never guessed. */
  startedAt?: string;
  completedAt: string;
  createdAt: string;
  /** Last change to the record after finalize (summary, workSummary, verification, metadata, void, evidence, links). */
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

/** Soft-delete marker kept with the record; every change is also written to the void audit. */
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

export interface SessionDetail {
  session: WorkSessionRecord;
  project: ProjectRecord;
  events: WorkEventRecord[];
  rawSnapshots: RawSnapshotRecord[];
  evidence: EvidenceRecord[];
  knowledge: KnowledgeRecord[];
  decisions: SessionDecisionRecord[];
  /** Void and restore history of this Session and its evidence, newest first. */
  voidHistory: VoidAuditRecord[];
  /** Verification corrections after finalize, newest first. */
  verificationHistory: VerificationUpdateRecord[];
  /** Sessions linked to this one (planning ↔ implementation, follow-ups), oldest first. */
  links: SessionLinkRecord[];
  /** Diagrams an Agent attached, oldest first; voided ones stay listed with their reason. */
  diagrams: SessionDiagramRecord[];
}

export const SESSION_DIAGRAM_KINDS = ["mermaid"] as const;
export type SessionDiagramKind = (typeof SESSION_DIAGRAM_KINDS)[number];

/** A diagram (Mermaid source) attached to a Session; it can be voided but never deleted. */
export interface SessionDiagramRecord {
  id: string;
  sessionId: string;
  projectId: string;
  title: string;
  kind: SessionDiagramKind;
  source: string;
  createdAt: string;
  voided?: VoidState;
}

export interface AttachDiagramInput {
  sessionId: string;
  idempotencyKey: string;
  title: string;
  source: string;
  kind?: SessionDiagramKind;
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
  | { outcome: "diagram_void_updated"; diagram: SessionDiagramRecord }
  | { outcome: "not_found"; diagramId: string }
  | SkippedResult;

/** Stored relation: `continues` means the Session continues the other one's work (e.g. implements its plan). */
export type SessionLinkRelation = "continues" | "related";

/** A link as seen from one Session: it continues the other, is continued by it, or is related. */
export type SessionLinkDirection = "continues" | "continued_by" | "related";

export interface SessionLinkRecord {
  sessionId: string;
  title: string;
  projectName?: string;
  completedAt: string;
  relation: SessionLinkDirection;
  /** The linked Session was voided; it stays listed here but leaves recall. */
  voided?: boolean;
}

export interface LinkSessionsInput {
  sessionId: string;
  relatedSessionId: string;
  relation: SessionLinkRelation;
  /** false removes any link between the two Sessions. */
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
  /** Absent when the Session had no reported verification (historical not_supplied). */
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
  /** Set when the evidence was marked wrong; it stays visible in Session detail but leaves reports and the graph. */
  voided?: VoidState;
}

export type VoidTargetType = "session" | "evidence";

/** Session list filter: voided Sessions are excluded unless asked for. */
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
  /** true voids the Session, false restores it. */
  voided: boolean;
  /** Required when voiding. */
  reason?: string;
}

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
  /** Paths or globs (relative to the project) this Knowledge is about; drives possiblyStale. */
  appliesTo: string[];
  /** When a Session last confirmed it still holds (finalize appliedKnowledgeIds or a manual confirm). */
  lastConfirmedAt?: string;
  lastConfirmedSessionId?: string;
  /** The older Knowledge this one replaced; the older one is archived when this is recorded. */
  supersedesId?: string;
  /** Set when a Session reported contradicting it; cleared when it is confirmed again. */
  review?: KnowledgeReview;
  /**
   * Computed on read, never stored: a later Session changed files matching appliesTo after the last
   * confirmation (or creation), so the Knowledge may no longer hold.
   */
  possiblyStale?: KnowledgeStaleness;
  /** Computed on read from knowledge_feedback; absent when no Session or person has confirmed or contradicted it. */
  evidence?: KnowledgeEvidence;
}

export const KNOWLEDGE_FEEDBACK_KINDS = ["applied", "contradicted", "manual_confirm"] as const;
export type KnowledgeFeedbackKind = (typeof KNOWLEDGE_FEEDBACK_KINDS)[number];

/** How often recorded work backed or contradicted a Knowledge item. */
export interface KnowledgeEvidence {
  /** Sessions that applied it successfully plus manual confirmations. */
  confirmed: number;
  contradicted: number;
  lastConfirmedAt?: string;
  lastContradictedAt?: string;
}

export interface KnowledgeFeedbackRecord {
  id: string;
  kind: KnowledgeFeedbackKind;
  /** Absent for a manual confirmation in the Web UI. */
  sessionId?: string;
  sessionTitle?: string;
  occurredAt: string;
}

export interface KnowledgeReview {
  reason: "contradicted";
  sessionId?: string;
  at: string;
}

export interface KnowledgeStaleness {
  /** The earliest later Session that touched a matching path. */
  sessionId: string;
  sessionTitle: string;
  completedAt: string;
  paths: string[];
  /** How many later Sessions touched matching paths. */
  sessionCount: number;
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
  /** An older active Knowledge of the same project that this one replaces; it gets archived. */
  supersedesId?: string;
}

export interface RecordedKnowledgeResult {
  outcome: "knowledge_recorded";
  duplicate: boolean;
  knowledge: KnowledgeRecord;
  /** Problems that did not block recording, e.g. an unknown supersedesId. */
  warnings?: string[];
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
  /** true records that the Knowledge was checked and still holds: sets lastConfirmedAt, clears review. */
  confirm?: boolean;
}

export interface UpdatedKnowledgeResult {
  outcome: "knowledge_updated";
  knowledge: KnowledgeRecord;
  redactions?: RedactionSummary;
}

export interface KnowledgeUpdateNotFoundResult {
  outcome: "not_found";
  knowledgeId: string;
}

export type UpdateKnowledgeResult = UpdatedKnowledgeResult | KnowledgeUpdateNotFoundResult | KnowledgeSkippedResult;

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
}

export interface KnowledgeQueryResult {
  outcome: "knowledge";
  project?: ProjectRecord;
  projects: ProjectRecord[];
  items: KnowledgeRecord[];
  pageInfo: PageInfo;
}

export type KnowledgeSearchResult = KnowledgeQueryResult | KnowledgeSkippedResult;

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

/** recorded: stored in a record (a Session changed a file, a link someone made); derived: computed from records. */
export type GraphEdgeProvenance = "recorded" | "derived";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  provenance: GraphEdgeProvenance;
  /** Why a derived edge exists, e.g. how many Sessions changed both files. */
  reason?: string;
}

export type GraphNodeTotals = Record<GraphNodeKind, number>;

export interface GraphQuery {
  projectRoot?: string;
  projectId?: string;
  limit?: number;
  maxNodes?: number;
  maxEdges?: number;
  /** Enables bounded server-side graph pages when supplied. */
  pageSize?: number;
  /** Opaque cursor returned by a previous graph page. */
  cursor?: string;
  /** Adds derived co_changed edges between loaded files (hidden by default). */
  includeDerived?: boolean;
  /** Sessions two files must share to get a co_changed edge (default 3). */
  coChangeMinSessions?: number;
}

export interface GraphPathQuery {
  projectRoot?: string;
  projectId?: string;
  /** Graph node ids, e.g. "session:<id>" or "file:<projectId>:<path>". */
  from: string;
  to: string;
  includeDerived?: boolean;
}

export interface GraphPathStep {
  from: GraphNode;
  to: GraphNode;
  edge: GraphEdge;
  /** Plain-language reason for this step. */
  reason: string;
}

export type GraphPathResult =
  | {
      outcome: "graph_path";
      found: boolean;
      /** Shortest path in steps (breadth-first over the bounded graph); empty when not found. */
      steps: GraphPathStep[];
      /** Nodes the bounded graph held; a path through records beyond it is not searched. */
      searchedNodes: number;
      reason?: string;
    }
  | GraphSkippedResult;

export interface GraphPageInfo {
  unit: "sessions";
  /** Current opaque-cursor traversal phase. */
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
/** A report covers a calendar period, or "custom" for an explicit from/to range (e.g. a sprint). */
export const WORK_REPORT_PERIODS = [...REPORT_PERIODS, "custom"] as const;
export type WorkReportPeriod = (typeof WORK_REPORT_PERIODS)[number];
/** Longest custom report range, in days, inclusive of both ends. */
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

/** A compact Session reference for the report's cross-period lists. */
export interface ReportSpanningSession {
  id: string;
  title: string;
  projectName?: string;
  startedAt?: string;
  completedAt: string;
  updatedAt: string;
}

export interface ReportSpanningSessions {
  /** Completed in the period, started before it. */
  startedEarlier: ReportSpanningSession[];
  /** Started in the period, completed after it. */
  continuedLater: ReportSpanningSession[];
  /** Completed before the period, changed during it. */
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
  /** Whether the current or comparison period contains more sessions than the report's 200-session limit. */
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
  /**
   * Work that crosses the period boundary. Totals still count a Session once, in the period it was
   * completed; these lists only show where else it belongs (at most 20 each).
   */
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
  /** "all" limits results to all-project reports, so a single project's synthesis never stands in for them. */
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
  maxEvidence?: number;
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
  handoffPath?: string;
  handoffContent?: string;
  events?: FinalizeEventInput[];
  changedFiles?: string[];
  /** Paths already changed before this work started; they are excluded from this Session's changed files. */
  baselineChangedFiles?: string[];
  changedFilesProvenance?: ChangedFileProvenance[];
  changedFileChanges?: ChangedFileChange[];
  verification?: VerificationSummary;
  git?: GitSummary;
  /** When the work began (e.g. the first message of the conversation); must not be after completedAt. */
  startedAt?: string;
  completedAt?: string;
  /** An earlier Session this one continues (e.g. the planning Session it implements). */
  parentSessionId?: string;
  relatedSessionIds?: string[];
  /** Knowledge this work relied on and found still valid; their confirmation time moves to this Session. */
  appliedKnowledgeIds?: string[];
  /** Knowledge this work found no longer true; they are flagged for review. */
  contradictedKnowledgeIds?: string[];
  /** Optional Mermaid diagrams that explain the work, masked and stored with the Session. */
  diagrams?: Array<{ title: string; source: string }>;
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

export interface FinalizedSessionResult {
  outcome: "finalized";
  duplicate: boolean;
  session: WorkSessionRecord;
  redactions?: RedactionSummary;
  verificationFollowUp?: VerificationFollowUp;
  changedFilesFollowUp?: ChangedFilesFollowUp;
  workSummaryFollowUp?: WorkSummaryFollowUp;
  /** Requested links that were not created (unknown, non-tracked, or same Session). */
  linkWarnings?: string[];
  /** applied/contradicted Knowledge ids that were not found in this project. */
  knowledgeWarnings?: string[];
  /** Supplied timestamps that were stored but look estimated, or that could not apply. */
  timestampWarnings?: string[];
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

/**
 * Policy-gated operations scoped by a project id must return the id that was
 * requested. A project root is unavailable for an unknown id and is the
 * wrong identifier for callers that already operate on the registry id.
 */
export interface ProjectIdSkippedResult {
  outcome: "skipped";
  projectId: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export type FinalizeSessionResult = FinalizedSessionResult | FinalizeIdempotencyConflictResult | SkippedResult;

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

export interface WorkSummaryFollowUp {
  required: true;
  sessionId: string;
  message: string;
}

export interface UpdatedSessionVerificationResult {
  outcome: "updated";
  session: WorkSessionRecord;
  previous?: VerificationSummary;
  /** true when the submitted verification equals the stored one; nothing was written. */
  unchanged?: boolean;
  redactions?: RedactionSummary;
}

export interface UpdateSessionMetadataInput {
  sessionId: string;
  changedFiles: string[];
  changedFilesMode?: ChangedFilesMode;
  changedFilesProvenance?: ChangedFileProvenance[];
  changedFileChanges?: ChangedFileChange[];
  verification?: VerificationSummary;
  git?: GitSummary;
  /** Confirmed start of the work; not applied (and reported in timestampWarnings) when after completedAt. */
  startedAt?: string;
  /** Corrected completion time from evidence; not applied when before startedAt. Kept as a note event. */
  completedAt?: string;
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
  /** Timestamp corrections that were not applied, or that look estimated. */
  timestampWarnings?: string[];
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

export interface UpdatedSessionWorkSummaryResult {
  outcome: "work_summary_updated";
  duplicate: boolean;
  session: WorkSessionRecord;
  idempotencyKey: string;
  mode: WorkSummaryUpdateMode;
  previousWorkSummary?: WorkSummarySections;
  appliedWorkSummary: WorkSummarySections;
  redactions?: RedactionSummary;
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

/**
 * Compact Session view for Agent context and search results, sized to stay within an Agent's
 * tool-result budget. Changed-file lists, provenance and events are left out; read the full
 * record with work_get_session.
 */
export interface SessionDigest {
  id: string;
  projectId: string;
  projectName?: string;
  title: string;
  /** Truncated with a trailing "…" when longer than the digest limit. */
  summary: string;
  startedAt?: string;
  completedAt: string;
  updatedAt: string;
  gitBranch?: string;
  verificationStatus: ReportVerificationStatus;
  changedFilesCount: number;
  /** Leading items of workSummary.nextSteps (known limits and unfinished work), each truncated. */
  openItems: string[];
}

/** Compact Knowledge view; the full body is available through work_search_knowledge. */
export interface KnowledgeDigest {
  id: string;
  projectId: string;
  projectName?: string;
  sessionId?: string;
  kind: KnowledgeKind;
  title: string;
  /** Body truncated with a trailing "…" when longer than the digest limit. */
  excerpt: string;
  tags: string[];
  updatedAt: string;
  possiblyStale?: boolean;
  needsReview?: boolean;
}

/** A confirmed decision from a Session's workSummary.decisions, with its source for citation. */
export interface DecisionDigest {
  sessionId: string;
  sessionTitle: string;
  completedAt: string;
  text: string;
}

export const KNOWLEDGE_CANDIDATE_REQUEST_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type KnowledgeCandidateRequestStatus = (typeof KNOWLEDGE_CANDIDATE_REQUEST_STATUSES)[number];
export type KnowledgeCandidateStatus = "proposed" | "accepted" | "rejected";

/** An Agent request to propose Knowledge from a project's recorded Sessions; nothing is written as Knowledge until a person accepts it. */
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

export interface KnowledgeCandidateInput {
  /** The Session whose record supports this candidate; must be one of the request's sources. */
  sourceSessionId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags?: string[];
  references?: string[];
  appliesTo?: string[];
  /** Why this is reusable, quoting or pointing to the supporting part of the Session record. */
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
  /** The Knowledge created when the candidate was accepted. */
  knowledgeId?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface KnowledgeCandidateSourceSession {
  id: string;
  title: string;
  summary: string;
  completedAt: string;
  workSummary?: WorkSummarySections;
  /** Raw handoff text, truncated to the request's character budget. */
  handoff?: string;
  handoffTruncated?: boolean;
}

export interface KnowledgeCandidateContext {
  outcome: "knowledge_candidate_context";
  request: KnowledgeCandidateRequest;
  sessions: KnowledgeCandidateSourceSession[];
  /** Active Knowledge of the project, so proposals do not repeat it. */
  existingKnowledge: Array<{ id: string; kind: KnowledgeKind; title: string }>;
}

export type KnowledgeCandidateSkippedResult = {
  outcome: "skipped";
  projectRoot?: string;
  projectStatus: PolicyStatus;
  reason: string;
};

export type RequestKnowledgeCandidatesResult =
  | { outcome: "knowledge_candidate_request"; duplicate: boolean; request: KnowledgeCandidateRequest }
  | { outcome: "knowledge_candidates_not_needed"; reason: string }
  | KnowledgeCandidateSkippedResult;

export type KnowledgeCandidateContextResult =
  | KnowledgeCandidateContext
  | { outcome: "not_found"; requestId?: string; reason: string }
  | { outcome: "request_not_open"; request: KnowledgeCandidateRequest; reason: string }
  | KnowledgeCandidateSkippedResult;

export type SubmitKnowledgeCandidatesResult =
  | {
      outcome: "knowledge_candidates_submitted";
      request: KnowledgeCandidateRequest;
      candidates: KnowledgeCandidate[];
      redactions?: RedactionSummary;
    }
  | { outcome: "not_found"; requestId: string; reason: string }
  | { outcome: "request_not_open"; request: KnowledgeCandidateRequest; reason: string }
  | { outcome: "invalid_candidates"; reason: string }
  | KnowledgeCandidateSkippedResult;

/** Standing Knowledge pages: an Agent-maintained answer to a fixed question about a project. */
export const KNOWLEDGE_PAGE_DEFAULTS = [
  {
    slug: "architecture",
    title: "架構與慣例",
    question: "這個專案的架構、模組分工與開發慣例是什麼？",
  },
  {
    slug: "in-progress",
    title: "進行中的工作與未結項",
    question: "目前進行中的工作、尚未完成的事項與已知限制有哪些？",
  },
  {
    slug: "pitfalls",
    title: "常見陷阱",
    question: "在這個專案工作時，最常遇到的陷阱、錯誤與注意事項是什麼？",
  },
] as const;
export const KNOWLEDGE_PAGE_AUTHORS = ["agent", "web"] as const;
export type KnowledgePageAuthor = (typeof KNOWLEDGE_PAGE_AUTHORS)[number];
/** `empty` until first written; `needs_update` once newer Sessions exist than the page was written from. */
export type KnowledgePageStatus = "empty" | "fresh" | "needs_update";
/** The literal a section uses when its sources do not answer the question; only such a section may cite nothing. */
export const KNOWLEDGE_PAGE_INSUFFICIENT = "資料不足";

export interface KnowledgePageSection {
  heading: string;
  content: string;
  sourceSessionIds: string[];
}

export interface KnowledgePageRecord {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  question: string;
  sections: KnowledgePageSection[];
  /** 0 until the first version is saved. */
  version: number;
  status: KnowledgePageStatus;
  /** Non-voided Sessions completed after the page was last written. */
  newSessionCount: number;
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
}

export interface SaveKnowledgePageInput {
  projectRoot: string;
  slug: string;
  idempotencyKey: string;
  sections: KnowledgePageSection[];
}

export interface UpdateKnowledgePageInput {
  pageId: string;
  title?: string;
  sections: KnowledgePageSection[];
}

/** A Session as an Agent sees it while writing a Knowledge page. */
export interface KnowledgePageContextSession {
  id: string;
  title: string;
  completedAt: string;
  summary: string;
  workSummary: WorkSummarySections;
}

export interface KnowledgePageContext {
  outcome: "knowledge_page_context";
  page: KnowledgePageRecord;
  instructions: string;
  sessions: KnowledgePageContextSession[];
  /** True when older Sessions or long text were left out to stay within the size limit. */
  truncated: boolean;
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
  | { outcome: "knowledge_page_update_requested"; page: KnowledgePageRecord }
  | { outcome: "invalid_page"; reason: string }
  | KnowledgePageSkippedResult;

export type KnowledgePageContextResult =
  KnowledgePageContext | { outcome: "not_found"; slug: string; reason: string } | KnowledgePageSkippedResult;

export type SaveKnowledgePageResult =
  | { outcome: "knowledge_page_saved"; duplicate: boolean; page: KnowledgePageRecord; redactions?: RedactionSummary }
  | { outcome: "not_found"; slug: string; reason: string }
  | { outcome: "invalid_sources"; reason: string; sessionIds: string[] }
  | KnowledgePageSkippedResult;

export type UpdateKnowledgePageResult =
  | { outcome: "knowledge_page_updated"; page: KnowledgePageRecord; redactions?: RedactionSummary }
  | { outcome: "not_found"; pageId: string; reason: string }
  | { outcome: "invalid_sources"; reason: string; sessionIds: string[] }
  | KnowledgePageSkippedResult;

export type KnowledgePageVersionsResult =
  | {
      outcome: "knowledge_page_versions";
      page: KnowledgePageRecord;
      versions: KnowledgePageVersionRecord[];
      /** Titles of the Sessions cited by the page and the listed versions; a voided or missing Session is absent. */
      sources: Array<{ id: string; title: string }>;
    }
  | { outcome: "not_found"; pageId: string; reason: string }
  | KnowledgePageSkippedResult;

/** A bounded page for work_get_context: the rendered answer, cut to a fixed length. */
export interface KnowledgePageDigest {
  slug: string;
  title: string;
  status: KnowledgePageStatus;
  updatedAt: string;
  content: string;
  truncated: boolean;
}

export type KnowledgeCandidateListResult =
  | { outcome: "knowledge_candidates"; items: KnowledgeCandidate[]; openRequests: KnowledgeCandidateRequest[] }
  | KnowledgeCandidateSkippedResult;

export interface DecideKnowledgeCandidateInput {
  candidateId: string;
  decision: "accept" | "reject";
  /** Edits applied before accepting; omitted fields keep the proposal. */
  edits?: Partial<Pick<KnowledgeCandidate, "kind" | "title" | "body" | "tags" | "references" | "appliesTo">>;
}

export type DecideKnowledgeCandidateResult =
  | { outcome: "knowledge_candidate_decided"; candidate: KnowledgeCandidate; knowledge?: KnowledgeRecord }
  | { outcome: "not_found"; candidateId: string }
  | { outcome: "already_decided"; candidate: KnowledgeCandidate }
  | KnowledgeCandidateSkippedResult;

export interface ContextResult {
  outcome: "context";
  clock: ServerClock;
  project?: ProjectRecord;
  projects: ProjectRecord[];
  recentSessions: SessionDigest[];
  recentDecisions: DecisionDigest[];
  recentKnowledge: KnowledgeDigest[];
  /** Counts only; list the affected Sessions with work_preview_metadata_backfill. */
  metadataFollowUps: MetadataBackfillPreview["totals"];
  /** Pending or processing Agent requests in this scope, newest first (at most 5 of each kind). */
  pendingRequests: {
    reportSynthesis: ReportSynthesisRequest[];
    metadataBackfill: MetadataBackfillRequest[];
    knowledgeCandidates: KnowledgeCandidateRequest[];
    /** Number only; decision content is reviewed in the Web UI. */
    agentDecisions: number;
    /** Knowledge pages to (re)write: an update was requested or newer Sessions exist. */
    knowledgePages: Array<{ slug: string; title: string; status: KnowledgePageStatus; updateRequested: boolean }>;
  };
  /** Present when the context query named a task or paths: records ranked for that work. */
  relevant?: RelevantContext;
  /** Standing answers about the project, bounded in size; read these before searching. */
  knowledgePages: KnowledgePageDigest[];
}

/** Where a recall hit matched; `raw` is a section of the imported handoff snapshot. */
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
  /** Knowledge kind; absent on Sessions. */
  kind?: KnowledgeKind;
  /** Session completedAt or Knowledge updatedAt. */
  date: string;
  matchedIn: RecallField[];
  /** Heading of the matched raw handoff section. */
  section?: string;
  excerpt: string;
  /** Stored paths that matched the queried paths. */
  matchedPaths?: string[];
  score: number;
  /** Knowledge only: a later Session changed its appliesTo paths, or a Session contradicted it. */
  possiblyStale?: boolean;
  needsReview?: boolean;
  /** Knowledge only: how many Sessions or people confirmed and contradicted it (ranking uses this). */
  evidence?: { confirmed: number; contradicted: number };
  /** Linked, non-voided Sessions (planning ↔ implementation), so one hit leads to the other. */
  related?: Array<{ id: string; title: string; relation: SessionLinkDirection }>;
}

/** Per query word: how many in-scope records contain all of its terms. */
export interface RecallTermHits {
  term: string;
  count: number;
}

export interface RecallResult {
  outcome: "recall";
  project?: ProjectRecord;
  hits: RecallHit[];
  /** Present when some query word matched nothing, so the Agent can reshape the query. */
  termHits?: RecallTermHits[];
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

export interface RelevantContext {
  task?: string;
  paths?: string[];
  /** Knowledge (gotchas, patterns, decisions, …) ranked for the task and paths. */
  knowledge: RecallHit[];
  /** workSummary.decisions of the relevant Sessions, each citing its Session. */
  decisions: DecisionDigest[];
  /** Relevant Sessions, including those that changed the same paths, with their open items. */
  sessions: Array<RecallHit & { openItems: string[] }>;
  termHits?: RecallTermHits[];
  /** Paths from the request that recent Sessions changed often (only with paths). */
  hotspots?: HotspotHint[];
}

export interface TimelineQuery extends DateRange {
  projectRoot?: string;
  projectId?: string;
}

export interface TimelineSession {
  id: string;
  projectId: string;
  title: string;
  /** Absent when the start is unknown; the Session is then drawn as a point at completedAt. */
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
  /** The Session behind a confirmation or contradiction, or the Knowledge that replaced this one. */
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
      /** True when the range held more Sessions than one response carries (newest are kept). */
      truncated: boolean;
    }
  | SkippedContextResult;

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

/** A file or directory that many Sessions changed, with how often their verification failed or was not run. */
export interface Hotspot {
  projectId: string;
  projectName: string;
  /** Project-relative path of the file or directory ("." for files at the project root). */
  path: string;
  sessionCount: number;
  failedCount: number;
  notRunCount: number;
  lastChangedAt: string;
  /** The newest five Sessions, newest first. */
  recentSessions: HotspotSession[];
}

export type HotspotResult =
  { outcome: "hotspots"; groupBy: HotspotGroup; from?: string; to?: string; items: Hotspot[] } | SkippedContextResult;

/** A path an Agent is about to change that recent Sessions changed often. */
export interface HotspotHint {
  path: string;
  days: number;
  sessionCount: number;
  failedCount: number;
  notRunCount: number;
}

export interface SearchResult {
  session: SessionDigest;
  matchedIn: RecallField;
  /** Heading of the matched raw handoff section. */
  section?: string;
  excerpt: string;
}

export interface SkippedContextResult {
  outcome: "skipped";
  projectRoot: string;
  projectStatus: PolicyStatus;
  reason: string;
}

export type ContextQueryResult = ContextResult | SkippedContextResult;

export interface ProjectReader {
  getProjectByRootPath(rootPath: string): ProjectRecord | undefined;
}

export * from "./insights.js";

/** Read-only recording state for one workspace root; never grants or changes tracking. */
/** The server's clock, so an Agent can take the current time from it instead of estimating. */
export interface ServerClock {
  /** Current time, UTC ISO. */
  serverTime: string;
  /** IANA time zone of the machine running Work Intelligence, e.g. `Asia/Taipei`. */
  timeZone: string;
  /** Its current UTC offset, e.g. `+08:00`. */
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

/** Raw handoff snapshot metadata without its content, for bounded Agent payloads. */
export type RawSnapshotSummary = Omit<RawSnapshotRecord, "content"> & { contentLength: number };

export interface SessionDetailResult extends Omit<SessionDetail, "rawSnapshots"> {
  outcome: "session_detail";
  rawSnapshots: Array<RawSnapshotRecord | RawSnapshotSummary>;
}

export interface SessionNotFoundResult {
  outcome: "not_found";
  sessionId: string;
  reason: string;
}

export type SessionDetailQueryResult = SessionDetailResult | SessionVerificationSkippedResult | SessionNotFoundResult;

export type SessionListQueryResult = SessionListResult | SkippedResult | ProjectIdSkippedResult;

export type DatabaseBackupKind = "automatic" | "manual" | "migration" | "deletion" | "maintenance";

/** One SQLite snapshot written beside the database; `createdAt` comes from its UTC file name. */
export interface DatabaseBackup {
  kind: DatabaseBackupKind;
  fileName: string;
  createdAt: string;
  bytes: number;
}

export interface DatabaseBackupListData {
  /** Maximum retained non-automatic copies, including manual and safety snapshots. */
  keep: number;
  automaticKeep: number;
  backups: DatabaseBackup[];
}

/** Backups of the database. File names only: the API never exposes filesystem paths. */
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

/** Read-only system diagnostics returned by GET /api/system/status. */
export interface SystemStatus {
  version: string;
  /** The latest schema version supported by this application build. */
  schemaVersion: number;
  database: {
    path: string;
    bytes: number | null;
    state: DatabaseInspectionState;
    schemaVersion: number | null;
  };
  backups: {
    available: boolean;
    latestAutomatic: DatabaseBackup | null;
    count: number;
    totalBytes: number;
  };
  maintenance: DatabaseMaintenanceRecord | null;
  sseConnections: number;
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
  "metadata_backfill_requests",
  "session_summary_updates",
  "session_work_summary_updates",
] as const;

export type ProjectDataTable = (typeof PROJECT_DATA_TABLES)[number];
export type ProjectDataValue = string | number | null;

/** One validated SQLite row in a portable project export. */
export type ProjectDataRow = Record<string, ProjectDataValue>;

export type ProjectDataExportScope = { type: "all" } | { type: "project"; projectId: string };

/** Portable project data; derived search indexes are rebuilt after import. */
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

export interface ProjectDataImportInput {
  bundle: ProjectDataExport;
  projectId?: string;
  remap?: ProjectPathRemap[];
}

export type ProjectDataCounts = Partial<Record<ProjectDataTable, number>>;

export interface ProjectDataImportConflict {
  table: ProjectDataTable;
  id: string;
  reason: string;
}

export interface ProjectDataPathRemapCount {
  projects: number;
  snapshots: number;
}

export interface ProjectDataImportPreview {
  outcome: "project_data_import_preview";
  additions: ProjectDataCounts;
  skipped: ProjectDataCounts;
  conflicts: ProjectDataCounts;
  selectedProjects: Array<{
    id: string;
    name: string;
    /** Root path from the source export before any remap is applied. */
    sourceRootPath: string;
    rootPath: string;
    resolution: "existing" | "new" | "conflict";
    /** Added by the local API after checking only the effective root path with stat. */
    folderStatus?: ProjectFolderStatus;
  }>;
  remappedPaths: ProjectDataPathRemapCount[];
  conflictDetails: ProjectDataImportConflict[];
  conflictDetailsTruncated: boolean;
}

export interface ProjectDataImportResult extends Omit<ProjectDataImportPreview, "outcome"> {
  outcome: "project_data_imported";
  importedAt: string;
  redactions?: RedactionSummary;
}

/** The folder chosen in the native dialog the API server shows when adding a project. */
export type FolderPickResult =
  | { outcome: "folder_picked"; path: string; name: string }
  | { outcome: "folder_pick_cancelled" }
  | { outcome: "folder_pick_busy" }
  | { outcome: "folder_pick_unavailable"; reason: string };
