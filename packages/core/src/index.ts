export const PROJECT_STATUSES = ["unregistered", "tracked", "paused", "ignored"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type PolicyStatus = ProjectStatus | "unregistered";

export const WORK_EVENT_TYPES = [
  "planning",
  "execution",
  "verification",
  "closing",
  "note",
  "finalized"
] as const;

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

export interface WorkSessionRecord {
  id: string;
  projectId: string;
  projectName?: string;
  externalSessionId?: string;
  idempotencyKey: string;
  title: string;
  summary: string;
  status: "finalized";
  executionStatus: ExecutionStatus;
  completedAt: string;
  createdAt: string;
  commitRequired: false;
  commitSha?: string;
  gitBranch?: string;
  changedFiles: string[];
  changedFilesProvenance: ChangedFileProvenance[];
  changedFileChanges: ChangedFileChange[];
  verification?: VerificationSummary;
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
}

export interface EvidenceRecord {
  id: string;
  sessionId: string;
  projectId: string;
  kind: string;
  reference: string;
  summary?: string;
  capturedAt: string;
}

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
}

export interface RecordedKnowledgeResult {
  outcome: "knowledge_recorded";
  duplicate: boolean;
  knowledge: KnowledgeRecord;
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
  | KnowledgeHistoryQueryResult
  | KnowledgeHistoryNotFoundResult
  | KnowledgeHistorySkippedResult;

export const GRAPH_NODE_KINDS = ["project", "session", "knowledge", "evidence", "file"] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];
export const GRAPH_EDGE_KINDS = ["contains", "changed_file", "has_knowledge", "has_evidence"] as const;
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
export type ReportTrendGranularity = "day" | "month";
export const REPORT_EXPORT_FORMATS = ["json", "markdown"] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];
export const REPORT_SYNTHESIS_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"] as const;
export type ReportSynthesisStatus = (typeof REPORT_SYNTHESIS_STATUSES)[number];
export const REPORT_SYNTHESIS_SCOPE_TYPES = ["all", "project"] as const;
export type ReportSynthesisScopeType = (typeof REPORT_SYNTHESIS_SCOPE_TYPES)[number];
export const METADATA_BACKFILL_REQUEST_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"] as const;
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
  period: ReportPeriod;
  range: ReportRange;
  previousRange: ReportRange;
  timezone: "UTC";
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

export type ReportSynthesisRequestLookupResult = ReportSynthesisRequestDetailResult | ReportSynthesisRequestNotFoundResult | SkippedReportResult;

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
  | ReportSummarySavedResult
  | ReportSummarySaveNotFoundResult
  | ReportSummaryRequestNotReadyResult
  | SkippedReportResult;

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
  externalSessionId?: string;
  handoffPath?: string;
  handoffContent?: string;
  events?: FinalizeEventInput[];
  changedFiles?: string[];
  changedFilesProvenance?: ChangedFileProvenance[];
  changedFileChanges?: ChangedFileChange[];
  verification?: VerificationSummary;
  git?: GitSummary;
  completedAt?: string;
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

export interface UpdatedSessionVerificationResult {
  outcome: "updated";
  session: WorkSessionRecord;
  previous?: VerificationSummary;
}

export interface UpdateSessionMetadataInput {
  sessionId: string;
  changedFiles: string[];
  changedFilesMode?: ChangedFilesMode;
  changedFilesProvenance?: ChangedFileProvenance[];
  changedFileChanges?: ChangedFileChange[];
  verification?: VerificationSummary;
  git?: GitSummary;
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
  | UpdatedSessionVerificationResult
  | SessionVerificationNotFoundResult
  | SessionVerificationSkippedResult;

export type UpdateSessionMetadataResult =
  | UpdatedSessionMetadataResult
  | SessionVerificationNotFoundResult
  | SessionVerificationSkippedResult;

export type UpdateSessionSummaryResult =
  | UpdatedSessionSummaryResult
  | SessionSummaryUpdateIdempotencyConflictResult
  | SessionVerificationNotFoundResult
  | SessionVerificationSkippedResult;

export interface ContextResult {
  outcome: "context";
  project?: ProjectRecord;
  projects: ProjectRecord[];
  recentSessions: WorkSessionRecord[];
  recentDecisions: string[];
  recentKnowledge: KnowledgeRecord[];
  metadataFollowUps: MetadataBackfillItem[];
}

export interface SearchResult {
  session: WorkSessionRecord;
  matchedIn: "title" | "summary" | "event";
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

export * from "./modules.js";
