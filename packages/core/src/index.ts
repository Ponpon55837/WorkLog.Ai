export const PROJECT_STATUSES = ["unregistered", "tracked", "paused", "ignored"] as const;

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

export interface WorkSessionRecord {
  id: string;
  projectId: string;
  projectName?: string;
  externalSessionId?: string;
  idempotencyKey: string;
  title: string;
  summary: string;
  workSummary?: WorkSummarySections;
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
  /** Void and restore history of this Session and its evidence, newest first. */
  voidHistory: VoidAuditRecord[];
  /** Verification corrections after finalize, newest first. */
  verificationHistory: VerificationUpdateRecord[];
  /** Sessions linked to this one (planning ↔ implementation, follow-ups), oldest first. */
  links: SessionLinkRecord[];
}

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
  | { outcome: "session_void_updated"; duplicate: boolean; session: WorkSessionRecord }
  | { outcome: "not_found"; sessionId: string }
  | { outcome: "skipped"; sessionId: string; projectStatus: PolicyStatus; reason: string };

export type SetEvidenceVoidResult =
  | { outcome: "evidence_void_updated"; duplicate: boolean; evidence: EvidenceRecord }
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
export const GRAPH_EDGE_KINDS = ["contains", "changed_file", "has_knowledge", "has_evidence", "session_link"] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  projectId?: string;
  sessionId?: string;
  metadata: Record<string, string | number | boolean>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
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
}

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
export type WorkReportPeriod = ReportPeriod | "custom";
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

export type ReportInsightKind = "verification" | "metadata" | "event";

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
  completedWork: WorkSessionRecord[];
  projects: ReportProjectSummary[];
  totals: {
    sessions: number;
    events: number;
    changedFiles: number;
    verification: Record<ReportVerificationStatus, number>;
  };
  comparison: ReportComparison;
  risks: ReportInsight[];
  decisions: ReportDecision[];
  trendGranularity: ReportTrendGranularity;
  trends: ReportTrendPoint[];
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
  period: ReportPeriod;
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
  period: ReportPeriod;
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
  period: ReportPeriod;
  date?: string;
  projectId?: string;
  idempotencyKey?: string;
}

export interface ReportSynthesisRequestQuery {
  period?: ReportPeriod;
  date?: string;
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
  workSummary?: WorkSummarySections;
  externalSessionId?: string;
  handoffPath?: string;
  handoffContent?: string;
  events?: FinalizeEventInput[];
  changedFiles?: string[];
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
  verificationFollowUp?: VerificationFollowUp;
  changedFilesFollowUp?: ChangedFilesFollowUp;
  workSummaryFollowUp?: WorkSummaryFollowUp;
  /** Requested links that were not created (unknown, non-tracked, or same Session). */
  linkWarnings?: string[];
  /** applied/contradicted Knowledge ids that were not found in this project. */
  knowledgeWarnings?: string[];
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
}

export interface UpdateSessionMetadataInput {
  sessionId: string;
  changedFiles: string[];
  changedFilesMode?: ChangedFilesMode;
  changedFilesProvenance?: ChangedFileProvenance[];
  changedFileChanges?: ChangedFileChange[];
  verification?: VerificationSummary;
  git?: GitSummary;
  /** Confirmed start of the work; ignored when after completedAt. */
  startedAt?: string;
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
  workSummary: WorkSummarySections | Partial<WorkSummarySections>;
}

export interface UpdatedSessionWorkSummaryResult {
  outcome: "work_summary_updated";
  duplicate: boolean;
  session: WorkSessionRecord;
  idempotencyKey: string;
  mode: WorkSummaryUpdateMode;
  previousWorkSummary?: WorkSummarySections;
  appliedWorkSummary: WorkSummarySections;
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
  | { outcome: "knowledge_candidates_submitted"; request: KnowledgeCandidateRequest; candidates: KnowledgeCandidate[] }
  | { outcome: "not_found"; requestId: string; reason: string }
  | { outcome: "request_not_open"; request: KnowledgeCandidateRequest; reason: string }
  | { outcome: "invalid_candidates"; reason: string }
  | KnowledgeCandidateSkippedResult;

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
  };
  /** Present when the context query named a task or paths: records ranked for that work. */
  relevant?: RelevantContext;
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
export interface ProjectStatusResult {
  outcome: "project_status";
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

/** One SQLite snapshot written beside the database; `createdAt` comes from its UTC file name. */
export interface DatabaseBackup {
  fileName: string;
  createdAt: string;
  bytes: number;
}

/** Backups of the database. File names only: the API never exposes filesystem paths. */
export interface DatabaseBackupList {
  outcome: "database_backups";
  keep: number;
  backups: DatabaseBackup[];
}

export interface DatabaseBackupCreated extends DatabaseBackupList {
  created: DatabaseBackup;
}

export interface DatabaseBackupUnavailable {
  outcome: "backup_unavailable";
  reason: string;
}

/** The folder chosen in the native dialog the API server shows when adding a project. */
export type FolderPickResult =
  | { outcome: "folder_picked"; path: string; name: string }
  | { outcome: "folder_pick_cancelled" }
  | { outcome: "folder_pick_busy" }
  | { outcome: "folder_pick_unavailable"; reason: string };
