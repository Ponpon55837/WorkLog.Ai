import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NoopInsightProvider } from "@work-intelligence/core";
import type {
  ReportPresentation,
  ReportPresentationExport,
  ReportPresentationState,
  AttachEvidenceInput,
  RedactionSummary,
  AttachEvidenceResult,
  ContextQueryResult,
  DecideKnowledgeCandidateInput,
  DecideKnowledgeCandidateResult,
  KnowledgeCandidateContextResult,
  KnowledgeCandidateInput,
  KnowledgeCandidateListResult,
  KnowledgeCandidateStatus,
  RequestKnowledgeCandidatesResult,
  SubmitKnowledgeCandidatesResult,
  LinkSessionsInput,
  LinkSessionsResult,
  SessionLinkRecord,
  SessionLinkRelation,
  SetEvidenceVoidInput,
  SetEvidenceVoidResult,
  SetSessionVoidInput,
  SetSessionVoidResult,
  SessionVoidedFilter,
  VerificationUpdateSource,
  DateRange,
  RecallInput,
  RecallQueryResult,
  CancelMetadataBackfillRequestResult,
  CancelOutstandingCleanupRequestResult,
  CreateOutstandingCleanupRequestInput,
  CreateOutstandingCleanupRequestResult,
  OutstandingCleanupRequestQuery,
  OutstandingCleanupRequestListResult,
  OutstandingCleanupContextQuery,
  OutstandingCleanupContextResult,
  SubmitOutstandingCleanupProposalsInput,
  SubmitOutstandingCleanupProposalsResult,
  OutstandingCleanupProposalQuery,
  OutstandingCleanupProposalListResult,
  DecideOutstandingCleanupProposalsInput,
  DecideOutstandingCleanupProposalsResult,
  CancelReportSynthesisRequestResult,
  CreateMetadataBackfillRequestInput,
  CreateMetadataBackfillRequestResult,
  UpdateAttentionPreference,
  AttentionPreferenceResult,
  AttentionQuery,
  AttentionResult,
  DashboardSummary,
  EvidenceRecord,
  GraphQuery,
  AttachDiagramInput,
  AttachDiagramResult,
  SetDiagramVoidInput,
  SetDiagramVoidResult,
  GraphPathQuery,
  GraphPathResult,
  GraphQueryResult,
  ActivityQuery,
  ActivityResult,
  HotspotQuery,
  TimelineQuery,
  TimelineResult,
  HotspotResult,
  HandoffImportApplyInput,
  HandoffImportBatchResult,
  HandoffImportOptions,
  HandoffImportPreview,
  HandoffImportPreviewItem,
  HandoffImportPreviewResult,
  HandoffImportFailure,
  InsightProvider,
  KnowledgeHistoryQuery,
  KnowledgeHistoryResult,
  KnowledgeQuery,
  KnowledgeQueryResult,
  AgentKnowledgeQueryResult,
  KnowledgeRecord,
  KnowledgeSkippedResult,
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
  RecordKnowledgeInput,
  RecordKnowledgeResult,
  ReportExportFormat,
  ReportExportResult,
  ReportPeriod,
  ReportEvidenceKind,
  ReportInsight,
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
  DeleteSessionResult,
  ProjectDeletionAuditRecord,
  ReportSynthesisRequestLookupResult,
  SearchQueryResult,
  SearchResult,
  SessionListResult,
  SessionDetail,
  ListSessionDecisionsInput,
  SessionDecisionListQueryResult,
  ReviewSessionDecisionInput,
  ReviewSessionDecisionResult,
  OutstandingItem,
  BatchUpdateOutstandingItemStatusInput,
  BatchUpdateOutstandingItemStatusResult,
  ListOutstandingItemsInput,
  OutstandingItemEventSource,
  OutstandingItemListQueryResult,
  OutstandingItemStatus,
  UpdateOutstandingItemStatusResult,
  KnowledgePageContextQuery,
  KnowledgePageContextResult,
  KnowledgePageListQuery,
  KnowledgePageListResult,
  KnowledgePageVersionsResult,
  MarkKnowledgePageCheckedInput,
  MarkKnowledgePageCheckedResult,
  RequestKnowledgePageUpdateInput,
  RequestKnowledgePageUpdateResult,
  SaveKnowledgePageInput,
  SaveKnowledgePageResult,
  UpdateKnowledgePageInput,
  UpdateKnowledgePageResult,
  SkippedResult,
  UpdateSessionMetadataInput,
  UpdateSessionMetadataResult,
  UpdateSessionSummaryInput,
  UpdateSessionSummaryResult,
  UpdateSessionTitleInput,
  UpdateSessionTitleResult,
  UpdateSessionWorkSummaryInput,
  UpdateSessionWorkSummaryResult,
  UpdateSessionVerificationResult,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult,
  VerificationSummary,
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
  SessionAgentReadQuery,
  SessionAgentReadResult,
  SessionListQueryResult,
  SessionNotFoundResult,
} from "@work-intelligence/core";
import { nowIso, serverClock, toLocalCalendarDate, truncateText } from "@work-intelligence/shared";
import { createProjectPathResolver, ProjectPolicyGate, safeProjectPath } from "@work-intelligence/project-policy";
import { sessionDetailQuerySchema } from "@work-intelligence/schema";
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
import { segmentLengthWarnings, startedAfterCompletedWarning, suppliedCompletedAtWarnings } from "./work-timestamps.js";
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
import { registerListSearchFunctions } from "./list-search-scan.js";
import { ProjectRepository, type ProjectUpdate } from "./project-repository.js";
import { ProjectLocationService } from "./project-location-service.js";
import { MetadataBackfillService } from "./metadata-backfill-service.js";
import { MetadataBackfillRepository } from "./metadata-backfill-repository.js";
import { ReportReadService } from "./report-service.js";
import { ReportSynthesisService } from "./report-synthesis-service.js";
import { ReportSynthesisRequestRepository } from "./report-synthesis-request-repository.js";
import { SessionRepository, type SessionListOptions, type SessionRow } from "./session-repository.js";
import {
  assertDatabaseSchemaVersion,
  configureWorkIntelligenceDatabaseConnection,
  initializeWorkIntelligenceDatabase,
} from "./database-initialization.js";
import {
  runAfterImmediateTransaction,
  runImmediateTransaction as runImmediateSqlTransaction,
  runReadTransaction,
} from "./sqlite-transaction.js";
import { KnowledgeCandidateService } from "./knowledge-candidates.js";
import { DiagramService } from "./diagram-service.js";
import { ActivityRepository } from "./activity-repository.js";
import { HotspotRepository } from "./hotspot-repository.js";
import { TimelineRepository } from "./timeline-repository.js";
import { SearchRepository } from "./search-repository.js";
import { ContextRecallService, type ContextFocus } from "./context-recall-service.js";
import { ProjectDataTransferService, ValidatedProjectDataImport } from "./project-data-transfer.js";
import {
  SessionAgentReadService,
  sameSessionRevision,
  sessionUnchanged,
  toAgentSessionDetail,
} from "./session-agent-read-service.js";
import { SessionRecordService } from "./session-record-service.js";
import { SessionDecisionService } from "./session-decision-service.js";
import { OutstandingItemService } from "./outstanding-item-service.js";
import { OutstandingCleanupService } from "./outstanding-cleanup-service.js";
import { ReportPresentationService } from "./report-presentation-service.js";
import { RelatedWorkService } from "./related-work-service.js";
import type { FileHistoryQuery, FileHistoryResult, RelatedWorkResult } from "@work-intelligence/core";
import { AttentionService } from "./attention-service.js";
import { KnowledgePageService } from "./knowledge-page-service.js";
import { findKnowledgeToReview } from "./knowledge-review-hint.js";
import { KnowledgeSearchService } from "./knowledge-search-service.js";
import { FileHistoryService } from "./file-history-service.js";
import { KnowledgeService } from "./knowledge-service.js";
import { AgentReadAuditService } from "./agent-read-audit-service.js";
import type {
  AgentReadAuditPage,
  AgentReadRecordType,
  AgentReadReferences,
  AgentReadStats,
  ListAgentReadsOptions,
  RecordAgentReadInput,
  SummarizeAgentReadsOptions,
} from "./agent-read-audit-service.js";
import { ProjectDeletionService } from "./project-deletion-service.js";
import { SessionDeletionService } from "./session-deletion-service.js";
import { combineRedactionSummaries, redactPrivateBlocksText, redactText, redactValue } from "./secret-redaction.js";
import type { EvidenceRow, KnowledgeRow } from "./session-record-codecs.js";
import {
  normalizeWorkSummarySections,
  normalizeWorkSummaryDecisions,
  changedFileIdentity,
  normalizeChangedFileChanges,
  changedFilePathsFromChanges,
  normalizeChangedFiles,
  excludeBaselineChangedFiles,
  excludeBaselineChangedFileChanges,
  toSession,
  toEvidence,
  resolveStartedAt,
  toKnowledge,
  getVerificationFollowUp,
  getChangedFilesFollowUp,
  getWorkSummaryFollowUp,
  normalizeCommitSha,
} from "./session-record-codecs.js";
import { replaceSessionDecisions, type SessionDecisionDraft } from "./session-decision-service.js";

export type { ContextFocus } from "./context-recall-service.js";

/** Server-side facts about a finalize call that the caller never supplies through the public input. */
export type FinalizeSessionContext = { agentClient?: string };

/** Optional Agent scope: a workspace root, a registry id, or both when they name the same project. */
export type TrackedScopeInput = { projectRoot?: string; projectId?: string };

type HandoffImportPlan = {
  project: ProjectRecord;
  discovery: HandoffDiscoveryResult;
  candidates: HandoffImportCandidate[];
  items: HandoffImportPreviewItem[];
  preview: HandoffImportPreview;
};

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
  /**
   * `read-only` opens an already initialized database without write access. `existing` opens one for writing but,
   * like `read-only`, never migrates it: the background worker imports through it while the API owns the schema.
   */
  mode?: "initialize" | "read-only" | "existing";
  /** Required with read-only and existing modes; the database must already have this exact schema version. */
  expectedSchemaVersion?: number;
}

/** A report lists at most five changed-often files with its risks, each changed by at least two Sessions. */
const REPORT_HOTSPOT_LIMIT = 5;
const REPORT_HOTSPOT_MIN_SESSIONS = 2;
const TIMELINE_DEFAULT_DAYS = 30;

export class WorkIntelligenceStore {
  private readonly db: DatabaseSync;
  private readonly backupOptions: BackupRetentionOptions;
  private readonly projects: ProjectRepository;
  private readonly sessions: SessionRepository;
  private readonly sessionRecords: SessionRecordService;
  private readonly sessionAgentReads: SessionAgentReadService;
  private readonly diagrams: DiagramService;
  private readonly sessionDecisions: SessionDecisionService;
  private readonly outstandingItems: OutstandingItemService;
  private readonly outstandingCleanup: OutstandingCleanupService;
  private readonly knowledgePages: KnowledgePageService;
  private readonly attention: AttentionService;
  private readonly knowledge: KnowledgeRepository;
  private readonly knowledgeService: KnowledgeService;
  private readonly knowledgeSearch: KnowledgeSearchService;
  private readonly graphBuilder: GraphBuilder;
  private readonly handoffImportService = new HandoffImportService();
  private readonly projectDataTransfer: ProjectDataTransferService;
  private readonly reportReader: ReportReadService;
  private readonly reportSynthesis: ReportSynthesisService;
  private readonly metadataBackfillService: MetadataBackfillService;
  private readonly contextRecallService: ContextRecallService;
  private readonly searchIndex: SearchRepository;
  private readonly hotspots: HotspotRepository;
  private readonly fileHistory: FileHistoryService;
  private readonly timelines: TimelineRepository;
  private readonly activity: ActivityRepository;
  private readonly projectDeletionService: ProjectDeletionService;
  private readonly sessionDeletionService: SessionDeletionService;
  private readonly agentReadAudit: AgentReadAuditService;
  private readonly projectLocationService: ProjectLocationService;
  private readonly knowledgeCandidates: KnowledgeCandidateService;
  private readonly policyGate: ProjectPolicyGate;
  public readonly insightProvider: InsightProvider;

  public constructor(
    public readonly databasePath: string,
    options: WorkIntelligenceStoreOptions = {},
  ) {
    this.insightProvider = options.insightProvider ?? new NoopInsightProvider();
    this.backupOptions = options.backup ?? {};
    const readOnly = options.mode === "read-only";
    const existingOnly = readOnly || options.mode === "existing";
    if (
      existingOnly &&
      (!Number.isSafeInteger(options.expectedSchemaVersion) || (options.expectedSchemaVersion ?? 0) < 1)
    ) {
      throw new Error("A read-only or existing-database WorkIntelligenceStore requires an expected schema version.");
    }
    // Opening a missing file for writing would create an empty database the schema check then rejects.
    if (existingOnly && (databasePath === ":memory:" || (!readOnly && !existsSync(databasePath)))) {
      throw new Error("A read-only or existing-database WorkIntelligenceStore requires an existing database file.");
    }
    if (!existingOnly && databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.db = new DatabaseSync(databasePath, readOnly ? { readOnly: true } : {});
    try {
      if (existingOnly) {
        configureWorkIntelligenceDatabaseConnection(this.db);
        assertDatabaseSchemaVersion(this.db, options.expectedSchemaVersion!);
      } else {
        initializeWorkIntelligenceDatabase(this.db, databasePath, this.backupOptions);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
    // Before any statement runs: SQLite refuses to define a function while a statement is active.
    registerListSearchFunctions(this.db);
    this.projectDataTransfer = new ProjectDataTransferService(this.db, databasePath, this.backupOptions);
    this.projects = new ProjectRepository(this.db);
    this.projectLocationService = new ProjectLocationService(this.db, this.projects);
    this.sessions = new SessionRepository(this.db, toSession, createPageInfo);
    this.diagrams = new DiagramService(this.db, {
      checkProjectById: (projectId) => this.checkProjectById(projectId),
    });
    this.outstandingItems = new OutstandingItemService(this.db, {
      checkProjectById: (projectId) => this.checkProjectById(projectId),
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
    });
    this.outstandingCleanup = new OutstandingCleanupService(this.db, {
      checkProjectById: (projectId) => this.checkProjectById(projectId),
    });
    this.sessionRecords = new SessionRecordService(this.db, {
      checkProjectById: (projectId) => this.checkProjectById(projectId),
      getSessionById: (sessionId) => this.getSessionById(sessionId),
      getProjectById: (projectId) => this.getProjectById(projectId),
      withKnowledgeTrustMany: (knowledge) => this.knowledgeService.withKnowledgeTrustMany(knowledge),
      listDiagrams: (sessionId) => this.diagrams.listForSession(sessionId),
      syncOutstandingItems: (sessionId, projectId, nextSteps, source, actorSessionId, updatedAt) =>
        this.outstandingItems.syncForSessionInTransaction(
          sessionId,
          projectId,
          nextSteps,
          source,
          actorSessionId,
          updatedAt,
        ),
    });
    this.sessionAgentReads = new SessionAgentReadService(this.db, {
      checkProjectById: (projectId) => this.checkProjectById(projectId),
      withKnowledgeTrustMany: (knowledge) => this.knowledgeService.withKnowledgeTrustMany(knowledge),
      listDiagrams: (sessionId) => this.diagrams.listForSession(sessionId),
      getSessionLinks: (sessionId) => this.sessionRecords.getSessionLinks(sessionId),
      agentSessionDetail: (sessionId) => {
        const detail = this.getSessionDetail(sessionId);
        return detail ? toAgentSessionDetail(detail) : undefined;
      },
    });
    this.reportReader = new ReportReadService(this.db, this);
    this.knowledge = new KnowledgeRepository(this.db, toKnowledge, createPageInfo, {
      listTrackedProjects: () => this.listProjects().filter((project) => project.status === "tracked"),
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      checkProjectById: (projectId) => this.checkProjectById(projectId),
    });
    this.knowledgeService = new KnowledgeService(this.db, {
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      getProjectById: (projectId) => this.getProjectById(projectId),
      searchKnowledge: (query) => this.knowledge.search(query),
    });
    this.sessionDecisions = new SessionDecisionService(this.db, {
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
    });
    this.knowledgePages = new KnowledgePageService(this.db, {
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      checkProjectById: (projectId) => this.checkProjectById(projectId),
    });
    this.graphBuilder = new GraphBuilder(this.db, {
      listProjects: () => this.listProjects(),
      getProjectById: (projectId) => this.getProjectById(projectId),
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      checkProjectById: (projectId) => this.checkProjectById(projectId),
      toKnowledge,
    });
    this.reportSynthesis = new ReportSynthesisService(
      this.db,
      {
        getProjectById: (projectId) => this.getProjectById(projectId),
        checkProjectById: (projectId) => this.checkProjectById(projectId),
        getReport: (options) => this.getReport(options),
        listReportIds: (options) => this.sessions.listReportIds(options),
        listReportSources: (ids, options) => this.sessions.listReportSources(ids, options),
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
    this.knowledgeSearch = new KnowledgeSearchService({
      searchKnowledge: (query) => this.searchKnowledge(query),
      countKnowledge: (query) => this.knowledge.count(query),
      rankKnowledge: (options) => this.searchIndex.rankKnowledge(options),
      getKnowledgeWithTrustMany: (knowledgeIds) => this.trackedKnowledgeWithTrust(knowledgeIds),
    });
    this.agentReadAudit = new AgentReadAuditService(this.db);
    this.hotspots = new HotspotRepository(this.db);
    this.fileHistory = new FileHistoryService(this.db, {
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      syncIndex: () => this.searchIndex.syncIndex(),
    });
    this.timelines = new TimelineRepository(this.db);
    this.activity = new ActivityRepository(this.db);
    this.projectDeletionService = new ProjectDeletionService(
      this.db,
      this.databasePath,
      this.backupOptions,
      this.searchIndex,
    );
    this.sessionDeletionService = new SessionDeletionService(
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
    this.attention = new AttentionService(this.db, {
      checkProjectById: (id) => this.checkProjectById(id),
      refreshRequests: (kind) => {
        if (kind === "synthesis") this.reportSynthesis.listReportSynthesisRequests({ limit: 1 });
        else this.metadataBackfillService.listMetadataBackfillRequests({ limit: 1 });
      },
      knowledge: (projectId) => this.searchKnowledge({ projectId, pageSize: 200 }),
      pages: (projectId) => this.knowledgePages.attentionPages(projectId),
    });
    this.contextRecallService = new ContextRecallService(this.db, this.searchIndex, {
      checkProjectRoot: (projectRoot) => this.checkProjectRoot(projectRoot),
      listProjects: () => this.listProjects(),
      listSessions: (sessionOptions) => this.listSessions(sessionOptions),
      getSessionById: (sessionId) => this.getSessionById(sessionId),
      getProjectById: (projectId) => this.getProjectById(projectId),
      getSessionLinks: (sessionId) => this.getSessionLinks(sessionId),
      appliedKnowledgeIdsBySessions: (sessionIds) => this.knowledgeService.appliedKnowledgeIdsBySessions(sessionIds),
      getKnowledgeWithTrustMany: (knowledgeIds) => {
        if (knowledgeIds.length === 0) return new Map();
        const rows = this.db
          .prepare("SELECT k.*, NULL AS project_name FROM knowledge k WHERE k.id IN (SELECT value FROM json_each(?))")
          .all(JSON.stringify([...new Set(knowledgeIds)])) as unknown as KnowledgeRow[];
        const trusted = this.knowledgeService.withKnowledgeTrustMany(rows.map(toKnowledge));
        return new Map(trusted.map((knowledge) => [knowledge.id, knowledge]));
      },
      searchKnowledge: (query) => this.searchKnowledge(query),
      listReportSynthesisRequests: (query) => this.listReportSynthesisRequests(query),
      listMetadataBackfillRequests: (query) => this.listMetadataBackfillRequests(query),
      previewMetadataBackfill: (previewOptions) => this.previewMetadataBackfill(previewOptions),
      countMetadataBackfillFollowUps: (countOptions) => this.countMetadataBackfillFollowUps(countOptions),
      openKnowledgeCandidateRequests: (projectId) => this.knowledgeCandidates.openRequests(projectId),
      knowledgeCandidateBacklog: (projectId) => this.knowledgeCandidates.contextBacklog(projectId),
      countPendingAgentDecisions: (projectId) => this.sessionDecisions.countPending(projectId),
      listOutstandingItems: (input) => this.outstandingItems.list(input),
      listOutstandingCleanupRequests: (input) => this.outstandingCleanup.listRequests(input),
      pendingOutstandingItemsForSessions: (sessionIds) => this.outstandingItems.pendingForSessions(sessionIds),
      hasPendingOutstandingItems: (projectId, excluded) => this.outstandingItems.hasPending(projectId, excluded),
      relatedPendingOutstandingItems: (input) => this.outstandingItems.relatedPending(input),
      knowledgePageDigests: (projectId) => this.knowledgePages.digestsForProject(projectId),
      knowledgePagesForContext: (projectId) => {
        const result = this.knowledgePages.listPages(projectId ? { projectId } : {});
        return result.outcome === "knowledge_pages" ? result.items.filter((page) => page.version > 0) : [];
      },
      pendingKnowledgePages: (projectId) => this.knowledgePages.pendingForProject(projectId),
      hotspotHints: (projectId, paths) => {
        this.searchIndex.syncIndex();
        return this.hotspots.hints(projectId, paths);
      },
      withSharedReads: (read) => this.knowledgePages.withSharedReads(read),
    });
  }

  private checkProjectRoot(projectRoot: string): PolicyDecision {
    return checkTrackedProjectByRoot(this.policyGate, projectRoot);
  }

  private checkProjectById(projectId: string): PolicyDecision {
    return checkTrackedProjectById(this.policyGate, this, projectId);
  }

  /** Returns content-free revisions for project data and Agent read audits across SQLite connections. */
  public getChangeToken(): { databaseId: string; dataRevision: number; auditRevision: number } {
    const row = this.db
      .prepare(
        `SELECT database_id AS databaseId, data_revision AS dataRevision, audit_revision AS auditRevision
         FROM change_revisions WHERE singleton = 1`,
      )
      .get() as { databaseId?: string; dataRevision?: number; auditRevision?: number } | undefined;
    if (!row?.databaseId) {
      throw new Error("The database change revision row is missing.");
    }
    return {
      databaseId: row.databaseId,
      dataRevision: Number(row.dataRevision ?? 0),
      auditRevision: Number(row.auditRevision ?? 0),
    };
  }

  /** Prevents a stale MCP writer from using an externally migrated database, within the same write lock. */
  public withCompatibleSchema<T>(schemaVersion: number, operation: () => T): T {
    return runImmediateSqlTransaction(this.db, () => {
      const row = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
      if (row?.version !== schemaVersion) {
        throw Object.assign(new Error("資料庫 schema 已更新，請重新連線 Work Intelligence MCP。"), {
          code: "MCP_RESTART_REQUIRED",
        });
      }
      return operation();
    });
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

  /** Counts additions, duplicates, and conflicts without writing anything, not even a backup. */
  public previewProjectDataImport(
    input: ProjectDataImportInput | ValidatedProjectDataImport,
  ): ProjectDataImportPreview {
    return this.projectDataTransfer.preview(ValidatedProjectDataImport.from(input));
  }

  /**
   * Writes a checked pre-import snapshot (refusing to import without one), then merges portable project data inside
   * one transaction while this store remains open. The search index is brought up to date right after the commit,
   * so the first read after a large import does not re-index thousands of documents inline.
   */
  public importProjectData(input: ProjectDataImportInput | ValidatedProjectDataImport): ProjectDataImportResult {
    const result = this.projectDataTransfer.import(ValidatedProjectDataImport.from(input));
    runAfterImmediateTransaction(this.db, () => {
      try {
        this.searchIndex.syncIndex();
      } catch {
        // The import is committed; documents still marked dirty are re-indexed by the next read, as before.
      }
    });
    return result;
  }

  /** Re-indexes every document a bulk change marked dirty (db:restore calls it), so no later read inherits them. */
  public syncSearchIndex(): void {
    this.searchIndex.syncIndex();
  }

  /** Writes one automatic backup per local calendar day, independently of manual backups. */
  public backupIfDue(now = new Date()): DatabaseBackupCreated | null {
    if (this.backupUnavailable() || !isBackupDue(this.databasePath, this.backupOptions.directory, now)) {
      return null;
    }
    return backupDatabase(this.db, this.databasePath, { ...this.backupOptions, kind: "automatic", now });
  }

  /** Periodic maintenance: empties old work-summary replay payloads. Never runs VACUUM. Returns rows pruned. */
  public pruneWorkSummaryUpdateHistory(now = new Date()): number {
    return this.sessionRecords.pruneWorkSummaryUpdateHistory(now);
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

  public updateProject(projectId: string, update: ProjectUpdate): ProjectRecord | undefined {
    return this.projects.update(projectId, update);
  }

  public updateProjectLocation(projectId: string, rootPath: string, confirmedTrackedScope = false): ProjectRecord {
    return this.projectLocationService.updateLocation(projectId, rootPath, confirmedTrackedScope);
  }

  /** Deletes a project and its local data after a checked full-database safety snapshot. */
  /** Passive audit of an MCP read; ids and counts only, and it never throws. */
  public recordAgentRead(input: RecordAgentReadInput): void {
    this.agentReadAudit.record(input);
  }

  public listAgentReads(options: ListAgentReadsOptions = {}): AgentReadAuditPage {
    return this.agentReadAudit.listRecent(options);
  }

  public summarizeAgentReads(options: SummarizeAgentReadsOptions = {}): AgentReadStats {
    return this.agentReadAudit.summarize(options);
  }

  public getAgentReadsForRecord(type: AgentReadRecordType, recordId: string, limit?: number): AgentReadReferences {
    return this.agentReadAudit.forRecord(type, recordId, limit);
  }

  public deleteProject(projectId: string, confirmationName: string): DeleteProjectResult {
    return this.projectDeletionService.deleteProject(projectId, confirmationName);
  }

  /** Web/REST only: permanently deletes one voided Session after a checked snapshot. MCP never calls this. */
  public deleteSession(sessionId: string): DeleteSessionResult {
    return this.sessionDeletionService.deleteSession(sessionId);
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

  public countMetadataBackfillFollowUps(
    options: { projectRoot?: string } = {},
  ): ReturnType<MetadataBackfillService["countMetadataBackfillFollowUps"]> {
    return this.metadataBackfillService.countMetadataBackfillFollowUps(options);
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

  public getReportPresentation(summaryId: string): ReportPresentation {
    return new ReportPresentationService(this.db, (id) => this.reportSynthesis.getReportSummaryById(id)).get(summaryId);
  }

  public exportReportPresentation(input: {
    summaryId: string;
    revision: number;
    locale: "zh-TW" | "en-US";
  }): ReportPresentationExport {
    return new ReportPresentationService(this.db, (id) => this.reportSynthesis.getReportSummaryById(id)).export(input);
  }

  public updateReportPresentation(input: {
    summaryId: string;
    expectedRevision: number;
    state: ReportPresentationState;
  }): ReportPresentation {
    return new ReportPresentationService(this.db, (id) => this.reportSynthesis.getReportSummaryById(id)).update(input);
  }

  public getRelatedWork(sessionId: string): RelatedWorkResult {
    return new RelatedWorkService(this.db).get(sessionId);
  }

  public updateAttentionPreference(input: UpdateAttentionPreference): AttentionPreferenceResult {
    return this.attention.updatePreference(input);
  }

  public getAttention(query: AttentionQuery = {}): AttentionResult {
    return this.attention.list(query);
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
    // sessions.id is unique, so the events whose Session is eligible are exactly the rows of the former three-way join.
    // The eligible ids are read once in table order instead of one Session lookup per event, which avoids most random
    // page reads; those grew faster than the data once the database outgrew the page cache.
    const recordedEvents = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM work_events e
         WHERE e.session_id IN (
           SELECT s.id FROM sessions s CROSS JOIN projects p ON p.id = s.project_id
           WHERE p.status = 'tracked' AND s.voided_at IS NULL
         )`,
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
    const report = this.reportReader.getReport(options);
    if (report.outcome !== "report") {
      return report;
    }
    this.searchIndex.syncIndex();
    const hotspotRisks = this.hotspots
      .hotspots({
        projectId: report.project?.id,
        from: report.range.from,
        to: report.range.to,
        limit: REPORT_HOTSPOT_LIMIT,
        groupBy: "file",
      })
      .filter((hotspot) => hotspot.sessionCount >= REPORT_HOTSPOT_MIN_SESSIONS)
      .map((hotspot): ReportInsight => ({
        kind: "hotspot",
        label: `熱點：${hotspot.path}`,
        detail:
          `本期 ${hotspot.sessionCount} 筆 Session 修改` +
          (hotspot.failedCount > 0 ? `，其中 ${hotspot.failedCount} 筆驗證失敗` : "") +
          (hotspot.notRunCount > 0 ? `，${hotspot.notRunCount} 筆未執行驗證` : "") +
          "。",
        sourceSessionIds: hotspot.recentSessions.map((session) => session.id),
      }));
    return hotspotRisks.length > 0 ? { ...report, risks: [...report.risks, ...hotspotRisks] } : report;
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

  public listSessionAgentClients(): string[] {
    return this.sessions.listAgentClients();
  }

  public pendingOutstandingItemsForSessions(sessionIds: readonly string[]): OutstandingItem[] {
    return this.outstandingItems.pendingForSessions(sessionIds);
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
    return this.sessionRecords.updateSessionVerification(sessionId, verification, source);
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
    return this.knowledgeService.applyKnowledgeFeedback(projectId, sessionId, completedAt, input);
  }

  /** Adds the computed possiblyStale marker (see KnowledgeRecord.possiblyStale). */
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
    return this.sessionRecords.linkSessions(input, source);
  }

  /** Both Sessions must exist in tracked projects and differ; returns why a link is not allowed. */
  private linkProblem(sessionId: string, relatedSessionId: string): string | undefined {
    return this.sessionRecords.linkProblem(sessionId, relatedSessionId);
  }

  private writeSessionLink(
    sessionId: string,
    relatedSessionId: string,
    relation: SessionLinkRelation,
    source: VerificationUpdateSource,
    createdAt: string,
  ): void {
    this.sessionRecords.writeSessionLink(sessionId, relatedSessionId, relation, source, createdAt);
  }

  /** Links of one Session as seen from it, limited to tracked projects, oldest linked Session first. */
  private getSessionLinks(sessionId: string): SessionLinkRecord[] {
    return this.sessionRecords.getSessionLinks(sessionId);
  }

  private touchSession(sessionId: string, at: string): void {
    this.sessionRecords.touchSession(sessionId, at);
  }

  private hasConfirmedChangedFilesForSession(sessionId: string): boolean {
    return this.sessionRecords.hasConfirmedChangedFilesForSession(sessionId);
  }

  public updateSessionMetadata(input: UpdateSessionMetadataInput): UpdateSessionMetadataResult {
    return this.sessionRecords.updateSessionMetadata(input);
  }

  public updateSessionSummary(input: UpdateSessionSummaryInput): UpdateSessionSummaryResult {
    return this.sessionRecords.updateSessionSummary(input);
  }

  public updateSessionTitle(input: UpdateSessionTitleInput): UpdateSessionTitleResult {
    return this.sessionRecords.updateSessionTitle(input);
  }

  public updateSessionWorkSummary(
    input: UpdateSessionWorkSummaryInput,
    source: Exclude<OutstandingItemEventSource, "migration"> = "web",
  ): UpdateSessionWorkSummaryResult {
    return this.sessionRecords.updateSessionWorkSummary(input, source);
  }

  public getSessionDetail(sessionId: string): SessionDetail | undefined {
    return this.sessionRecords.getSessionDetail(sessionId);
  }

  public listSessionDecisions(input: ListSessionDecisionsInput = {}): SessionDecisionListQueryResult {
    return this.sessionDecisions.list(input);
  }

  public reviewSessionDecision(input: ReviewSessionDecisionInput): ReviewSessionDecisionResult {
    return this.sessionDecisions.review(input);
  }

  public listOutstandingCleanupRequests(
    input: OutstandingCleanupRequestQuery = {},
  ): OutstandingCleanupRequestListResult {
    return this.outstandingCleanup.listRequests(input);
  }

  public getOutstandingCleanupContext(input: OutstandingCleanupContextQuery): OutstandingCleanupContextResult {
    return this.outstandingCleanup.context(input);
  }

  public listOutstandingCleanupProposals(input: OutstandingCleanupProposalQuery): OutstandingCleanupProposalListResult {
    return this.outstandingCleanup.listProposals(input);
  }

  public createOutstandingCleanupRequest(
    input: CreateOutstandingCleanupRequestInput,
  ): CreateOutstandingCleanupRequestResult {
    return this.outstandingCleanup.create(input);
  }

  public submitOutstandingCleanupProposals(
    input: SubmitOutstandingCleanupProposalsInput,
  ): SubmitOutstandingCleanupProposalsResult {
    return this.outstandingCleanup.submit(input);
  }

  public decideOutstandingCleanupProposals(
    input: DecideOutstandingCleanupProposalsInput,
  ): DecideOutstandingCleanupProposalsResult {
    return this.outstandingCleanup.decide(input);
  }

  public cancelOutstandingCleanupRequest(requestId: string): CancelOutstandingCleanupRequestResult {
    return this.outstandingCleanup.cancel(requestId);
  }

  public listOutstandingItems(input: ListOutstandingItemsInput = {}): OutstandingItemListQueryResult {
    return this.outstandingItems.list(input);
  }

  public batchUpdateOutstandingItemStatus(
    input: BatchUpdateOutstandingItemStatusInput,
  ): BatchUpdateOutstandingItemStatusResult {
    return this.outstandingItems.batchUpdateStatus(input);
  }

  public updateOutstandingItemStatus(
    itemId: string,
    status: OutstandingItemStatus,
    source: Exclude<OutstandingItemEventSource, "migration"> = "web",
  ): UpdateOutstandingItemStatusResult {
    return this.outstandingItems.updateStatus(itemId, status, source);
  }

  public listKnowledgePages(query: KnowledgePageListQuery = {}): KnowledgePageListResult {
    return this.knowledgePages.listPages(query);
  }

  public requestKnowledgePageUpdate(input: RequestKnowledgePageUpdateInput): RequestKnowledgePageUpdateResult {
    return this.knowledgePages.requestUpdate(input);
  }

  public getKnowledgePageContext(query: KnowledgePageContextQuery): KnowledgePageContextResult {
    return this.knowledgePages.getContext(query);
  }

  public saveKnowledgePage(input: SaveKnowledgePageInput): SaveKnowledgePageResult {
    return this.knowledgePages.savePage(input);
  }

  public markKnowledgePageChecked(input: MarkKnowledgePageCheckedInput): MarkKnowledgePageCheckedResult {
    return this.knowledgePages.markChecked(input);
  }

  public updateKnowledgePage(input: UpdateKnowledgePageInput): UpdateKnowledgePageResult {
    return this.knowledgePages.updatePage(input);
  }

  public listKnowledgePageVersions(pageId: string): KnowledgePageVersionsResult {
    return this.knowledgePages.listVersions(pageId);
  }

  /** Voids or restores a Session. Voided Sessions leave lists, reports, the graph, context, and recall. */
  public setSessionVoid(input: SetSessionVoidInput): SetSessionVoidResult {
    return this.sessionRecords.setSessionVoid(input);
  }

  /** Marks evidence as wrong (or restores it); it stays in Session detail but leaves reports and the graph. */
  public setEvidenceVoid(input: SetEvidenceVoidInput): SetEvidenceVoidResult {
    return this.sessionRecords.setEvidenceVoid(input);
  }

  public recordKnowledge(input: RecordKnowledgeInput): RecordKnowledgeResult {
    return this.knowledgeService.recordKnowledge(input);
  }

  public updateKnowledge(input: UpdateKnowledgeInput): UpdateKnowledgeResult {
    return this.knowledgeService.updateKnowledge(input);
  }

  public getKnowledgeHistory(input: KnowledgeHistoryQuery): KnowledgeHistoryResult {
    return this.knowledgeService.getKnowledgeHistory(input);
  }

  public searchKnowledge(options: KnowledgeQuery = {}): KnowledgeQueryResult | KnowledgeSkippedResult {
    return this.knowledgeService.searchKnowledge(options);
  }

  /** The Agent Knowledge search: the strict list result, or a labelled relaxed fallback when it is empty. */
  public searchKnowledgeForAgent(options: KnowledgeQuery = {}): AgentKnowledgeQueryResult | KnowledgeSkippedResult {
    return this.knowledgeSearch.search(options);
  }

  /** Full Knowledge records with trust signals, for ids of tracked projects only, read in one batch. */
  private trackedKnowledgeWithTrust(knowledgeIds: string[]): Map<string, KnowledgeRecord> {
    if (knowledgeIds.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name FROM knowledge k JOIN projects p ON p.id = k.project_id
         WHERE p.status = 'tracked' AND k.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify([...new Set(knowledgeIds)])) as unknown as KnowledgeRow[];
    const trusted = this.knowledgeService.withKnowledgeTrustMany(rows.map(toKnowledge));
    return new Map(trusted.map((knowledge) => [knowledge.id, knowledge]));
  }

  public getGraph(options: GraphQuery = {}): GraphQueryResult {
    return this.graphBuilder.build(options);
  }

  public attachDiagram(input: AttachDiagramInput): AttachDiagramResult {
    return this.diagrams.attach(input);
  }

  public setDiagramVoid(input: SetDiagramVoidInput): SetDiagramVoidResult {
    return this.diagrams.setVoid(input);
  }

  public getGraphPath(query: GraphPathQuery): GraphPathResult {
    return this.graphBuilder.findPath(query);
  }

  /** Sessions, Knowledge events, and Session links of tracked projects over a date range (default: 30 days). */
  public getTimeline(query: TimelineQuery = {}): TimelineResult {
    let projects = this.listProjects().filter((project) => project.status === "tracked");
    if (query.projectRoot || query.projectId) {
      const decision = query.projectRoot
        ? this.checkProjectRoot(query.projectRoot)
        : this.checkProjectById(query.projectId!);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      projects = [decision.project];
    }
    const to = query.to ?? toLocalCalendarDate();
    const from =
      query.from ??
      toLocalCalendarDate(new Date(Date.parse(`${to}T12:00:00`) - (TIMELINE_DEFAULT_DAYS - 1) * 86_400_000));
    const rows = this.timelines.timeline({ projectIds: projects.map((project) => project.id), from, to });
    return {
      outcome: "timeline",
      from,
      to,
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
      ...rows,
    };
  }

  /** Sessions completed per local calendar day over a date range, tracked projects only (for the Dashboard heatmap). */
  public getActivity(query: ActivityQuery): ActivityResult {
    let projects = this.listProjects().filter((project) => project.status === "tracked");
    if (query.projectRoot || query.projectId) {
      const decision = query.projectRoot
        ? this.checkProjectRoot(query.projectRoot)
        : this.checkProjectById(query.projectId!);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      projects = [decision.project];
    }
    const days = this.activity.dailySessions({
      projectIds: projects.map((project) => project.id),
      from: query.from,
      to: query.to,
    });
    return { outcome: "activity", from: query.from, to: query.to, days };
  }

  /** Most changed files or directories of tracked projects, from the search path index (kept in sync first). */
  public getHotspots(query: HotspotQuery = {}): HotspotResult {
    let projectId: string | undefined;
    if (query.projectRoot || query.projectId) {
      const decision = query.projectRoot
        ? this.checkProjectRoot(query.projectRoot)
        : this.checkProjectById(query.projectId!);
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
    this.searchIndex.syncIndex();
    const groupBy = query.groupBy ?? "file";
    return {
      outcome: "hotspots",
      groupBy,
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      items: this.hotspots.hotspots({
        projectId,
        from: query.from,
        to: query.to,
        limit: Math.min(Math.max(query.limit ?? 20, 1), 100),
        groupBy,
      }),
    };
  }

  /** Whole-history totals and bounded digests of the Sessions that recorded a file of a tracked project. */
  public getFileHistory(query: FileHistoryQuery): FileHistoryResult | SkippedResult {
    return this.fileHistory.get(query);
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
    const kindResult = redactText(input.kind.trim());
    const referenceResult = redactText(input.reference.trim());
    const summaryResult = input.summary?.trim() ? redactText(input.summary.trim()) : undefined;
    const redactions = combineRedactionSummaries(
      kindResult.redactions,
      referenceResult.redactions,
      summaryResult?.redactions ?? { total: 0, byKind: {} },
    );
    const kind = kindResult.value;
    const reference = referenceResult.value;
    return runImmediateSqlTransaction(this.db, () => {
      const existing = this.db
        .prepare("SELECT * FROM evidence WHERE session_id = ? AND kind = ? AND reference = ?")
        .get(input.sessionId, kind, reference) as EvidenceRow | undefined;
      if (existing) {
        return { outcome: "evidence_attached", duplicate: true, evidence: toEvidence(existing), redactions };
      }

      const evidence: EvidenceRecord = {
        id: randomUUID(),
        sessionId: input.sessionId,
        projectId: project.id,
        kind,
        reference,
        summary: summaryResult?.value || undefined,
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
      this.db
        .prepare("UPDATE sessions SET redaction_count = redaction_count + ? WHERE id = ?")
        .run(redactions.total, evidence.sessionId);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(evidence.capturedAt, project.id);

      return { outcome: "evidence_attached", duplicate: false, evidence, redactions };
    });
  }

  public finalizeSession(input: FinalizeSessionInput, context: FinalizeSessionContext = {}): FinalizeSessionResult {
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
    const normalizedDecisionInputs = normalizeWorkSummaryDecisions(input.workSummary?.decisions);
    const normalizedWorkSummary = normalizeWorkSummarySections(input.workSummary);
    const sanitizedTitle = redactText(input.title);
    const sanitizedSummary = redactText(input.summary);
    const sanitizedWorkSummary = redactValue(normalizedWorkSummary ?? {});
    const sanitizedVerification = input.verification ? redactValue(input.verification) : undefined;
    const sanitizedEvents = redactValue(input.events ?? []);
    const capturedHandoff = this.captureHandoff(project.rootPath, input);
    const sanitizedHandoff = capturedHandoff ? redactText(capturedHandoff.content) : undefined;
    const redactions = combineRedactionSummaries(
      sanitizedTitle.redactions,
      sanitizedSummary.redactions,
      sanitizedWorkSummary.redactions,
      sanitizedVerification?.redactions ?? { total: 0, byKind: {} },
      sanitizedEvents.redactions,
      sanitizedHandoff?.redactions ?? { total: 0, byKind: {} },
      capturedHandoff?.redactions ?? { total: 0, byKind: {} },
    );
    const git = input.git ?? this.readGitMetadata(project.rootPath);
    const sessionId = randomUUID();
    const createdAt = nowIso();
    const completedAt = input.completedAt ?? createdAt;
    const startedAt = resolveStartedAt(input.startedAt, input.events, completedAt);
    const timestampWarnings = [
      ...suppliedCompletedAtWarnings(input.completedAt),
      ...(input.startedAt && input.startedAt > completedAt
        ? [startedAfterCompletedWarning(input.startedAt, completedAt)]
        : []),
      ...segmentLengthWarnings(startedAt, completedAt),
    ];
    const events = [
      ...sanitizedEvents.value,
      {
        type: "finalized" as const,
        summary: "Session finalized after closing handoff.",
      },
    ];

    const result = runImmediateSqlTransaction<FinalizeSessionResult>(this.db, () => {
      const existing = this.getSessionByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const incomingSummary = sanitizedSummary.value.trim();
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
          redactions,
          verificationFollowUp: getVerificationFollowUp(existing),
          ...(this.hasConfirmedChangedFilesForSession(existing.id)
            ? {}
            : { changedFilesFollowUp: getChangedFilesFollowUp(existing) }),
          workSummaryFollowUp: getWorkSummaryFollowUp(existing),
          resolvedOutstandingItemIds: this.outstandingItems.resolvedByActorSession(existing.id),
          supersededOutstandingItemIds: this.outstandingItems.transitionedByActorSession(existing.id, "not_needed"),
        };
      }

      this.db
        .prepare(
          `INSERT INTO sessions (
             id, project_id, external_session_id, idempotency_key, title, summary,
             work_summary_json, status, execution_status, completed_at, created_at, commit_sha, git_branch,
             changed_files_json, changed_files_confirmed, changed_files_provenance_json, changed_file_changes_json, verification_json,
             started_at, updated_at, redaction_count, agent_client, agent_model
           ) VALUES (
             @id, @projectId, @externalSessionId, @idempotencyKey, @title, @summary,
             @workSummary, 'finalized', 'completed', @completedAt, @createdAt, @commitSha, @gitBranch,
             @changedFiles, @changedFilesConfirmed, @changedFilesProvenance, @changedFileChanges, @verification,
             @startedAt, @createdAt, @redactionCount, @agentClient, @agentModel
           )`,
        )
        .run({
          id: sessionId,
          projectId: project.id,
          externalSessionId: input.externalSessionId ?? null,
          idempotencyKey: input.idempotencyKey,
          title: sanitizedTitle.value,
          summary: sanitizedSummary.value,
          workSummary: JSON.stringify(sanitizedWorkSummary.value),
          completedAt,
          createdAt,
          commitSha: normalizeCommitSha(git?.commitSha) ?? null,
          gitBranch: git?.branch ?? null,
          changedFiles: JSON.stringify(normalizedChangedFiles.files),
          changedFilesConfirmed: input.changedFiles !== undefined || normalizedChangedFiles.files.length > 0 ? 1 : 0,
          changedFilesProvenance: JSON.stringify(normalizedChangedFiles.provenance),
          changedFileChanges: JSON.stringify(normalizedChangedFileChanges),
          verification: sanitizedVerification ? JSON.stringify(sanitizedVerification.value) : null,
          startedAt: startedAt ?? null,
          redactionCount: redactions.total,
          agentClient: context.agentClient?.trim().slice(0, 100) || null,
          agentModel: input.agentModel ?? null,
        });

      const sanitizedDecisionTexts = normalizedWorkSummary
        ? (sanitizedWorkSummary.value as typeof normalizedWorkSummary).decisions
        : [];
      const persistedDecisions: SessionDecisionDraft[] = sanitizedDecisionTexts.map((text, position) => ({
        text,
        origin: normalizedDecisionInputs[position]?.origin ?? "unspecified",
      }));
      replaceSessionDecisions(this.db, sessionId, project.id, persistedDecisions);
      const sanitizedNextSteps = normalizedWorkSummary
        ? (sanitizedWorkSummary.value as typeof normalizedWorkSummary).nextSteps
        : [];
      this.outstandingItems.syncForSessionInTransaction(
        sessionId,
        project.id,
        sanitizedNextSteps,
        "agent",
        sessionId,
        completedAt,
      );
      const resolvedRequested = input.resolvedOutstandingItemIds ?? [];
      const supersededRequested = input.supersededOutstandingItemIds ?? [];
      const supersededSet = new Set(supersededRequested);
      const ambiguous = new Set(resolvedRequested.filter((id) => supersededSet.has(id)));
      const resolution = this.outstandingItems.resolvePendingInTransaction(
        resolvedRequested.filter((id) => !ambiguous.has(id)),
        project.id,
        sessionId,
        completedAt,
      );

      const supersession = this.outstandingItems.supersedePendingInTransaction(
        sanitizedNextSteps.length ? supersededRequested.filter((id) => !ambiguous.has(id)) : [],
        project.id,
        sessionId,
        completedAt,
      );
      const unresolvedIds = [...new Set([...resolution.unresolvedIds, ...ambiguous])];
      const unsupersededIds = [
        ...new Set([
          ...supersession.unresolvedIds,
          ...ambiguous,
          ...(sanitizedNextSteps.length ? [] : supersededRequested),
        ]),
      ];

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

      if (capturedHandoff && sanitizedHandoff) {
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
            content: sanitizedHandoff.value,
            capturedAt: createdAt,
          });
      }

      this.db
        .prepare("UPDATE projects SET last_ingested_at = ?, updated_at = ? WHERE id = ?")
        .run(createdAt, createdAt, project.id);

      // Like work_link_sessions, a new link changes the other Session too; each one is touched once.
      const linkedSessionIds = new Set<string>();
      const linkWarnings = [
        ...(input.parentSessionId ? [{ id: input.parentSessionId, relation: "continues" as const }] : []),
        ...(input.relatedSessionIds ?? []).map((id) => ({ id, relation: "related" as const })),
      ].flatMap(({ id, relation }) => {
        const problem = this.linkProblem(sessionId, id);
        if (problem) {
          return [`${id}: ${problem}`];
        }
        this.writeSessionLink(sessionId, id, relation, "agent", createdAt);
        linkedSessionIds.add(id);
        return [];
      });
      for (const linkedSessionId of linkedSessionIds) {
        this.touchSession(linkedSessionId, createdAt);
      }

      const knowledgeWarnings = this.applyKnowledgeFeedback(project.id, sessionId, completedAt, input);
      const diagramRedactions = input.diagrams?.length
        ? this.diagrams.attachWithFinalize(sessionId, project.id, input.idempotencyKey, input.diagrams, createdAt)
        : undefined;

      const knowledgePagesAcknowledged = input.maintainedKnowledgePages?.length
        ? this.knowledgePages.acknowledgeMaintenance(project.id, sessionId, input.maintainedKnowledgePages)
        : [];
      const session = this.getSessionByIdempotencyKey(input.idempotencyKey);
      if (!session) {
        throw new Error("Session was inserted but could not be loaded.");
      }

      return {
        outcome: "finalized",
        duplicate: false,
        session,
        redactions: diagramRedactions ? combineRedactionSummaries(redactions, diagramRedactions) : redactions,
        verificationFollowUp: getVerificationFollowUp(session),
        changedFilesFollowUp: input.changedFiles === undefined ? getChangedFilesFollowUp(session) : undefined,
        workSummaryFollowUp: getWorkSummaryFollowUp(session),
        ...(linkWarnings.length > 0 ? { linkWarnings } : {}),
        ...(knowledgeWarnings.length > 0 ? { knowledgeWarnings } : {}),
        ...(timestampWarnings.length > 0 ? { timestampWarnings } : {}),
        ...(knowledgePagesAcknowledged.length > 0 ? { knowledgePagesAcknowledged } : {}),
        resolvedOutstandingItemIds: resolution.resolvedIds,
        supersededOutstandingItemIds: supersession.resolvedIds,
        ...(unresolvedIds.length > 0 || unsupersededIds.length > 0
          ? {
              outstandingItemWarnings: {
                unresolvedIds,
                unsupersededIds,
                message:
                  "部分指定項目無效、已處理、跨專案、正在整理待審、未提供取代項目或同時指定完成與取代，因此未標記完成或不再需要，維持原狀。",
              },
            }
          : {}),
      };
    });
    if (result.outcome === "finalized") {
      const { session } = result;
      // The Session is already committed, so these read-only reminders do not hold the write lock; a failed lookup
      // only omits its reminder.
      runAfterImmediateTransaction(this.db, () => {
        try {
          const knowledgePageMaintenanceHint = this.knowledgePages.maintenanceHintForProject(session.projectId);
          if (knowledgePageMaintenanceHint) result.knowledgePageMaintenanceHint = knowledgePageMaintenanceHint;
        } catch {
          delete result.knowledgePageMaintenanceHint;
        }
        try {
          result.relatedOutstandingItems = this.contextRecallService.relatedOutstandingItems(
            session.projectId,
            {
              task: `${session.title} ${session.summary}`.slice(0, 2_000),
              paths: session.changedFiles,
            },
            session.id,
          );
        } catch {
          delete result.relatedOutstandingItems;
        }
        try {
          const project = this.getProjectById(session.projectId);
          const knowledgeToReview = project
            ? findKnowledgeToReview(this.db, {
                projectId: project.id,
                sessionId: session.id,
                completedAt: session.completedAt,
                changedFiles: session.changedFiles,
                project: { name: project.name, rootPath: project.rootPath },
              })
            : { hints: [], truncated: false };
          if (knowledgeToReview.hints.length > 0) result.knowledgeToReview = knowledgeToReview.hints;
          if (knowledgeToReview.truncated) result.knowledgeToReviewTruncated = true;
        } catch {
          delete result.knowledgeToReview;
          delete result.knowledgeToReviewTruncated;
        }
      });
    }
    return result;
  }

  public getContext(projectRoot?: string, focus: ContextFocus = {}): ContextQueryResult {
    return this.contextRecallService.getContext(projectRoot, focus);
  }

  /**
   * Ranked retrieval across Sessions (including raw handoff sections) and active Knowledge of tracked
   * projects. Returns compact hits; read full records with getSessionDetailForAgent or searchKnowledge.
   */
  public recall(input: RecallInput): RecallQueryResult {
    return this.contextRecallService.recall(input);
  }

  /** `range` limits results to Sessions completed within inclusive calendar dates (server time zone). */
  public search(query: string, projectRoot?: string, range: DateRange = {}): SearchResult[] | SkippedResult {
    return this.contextRecallService.search(query, projectRoot, range);
  }

  /** Ranked, confidence-bearing Session search for Agent tools; REST search retains its current array result. */
  public searchForAgent(query: string, projectRoot?: string, range: DateRange = {}): SearchQueryResult | SkippedResult {
    return this.contextRecallService.searchForAgent(query, projectRoot, range);
  }

  /** Read-only recording state of a workspace root, so an Agent can skip preparing an untracked finalize. */
  public getProjectStatus(projectRoot: string): ProjectStatusResult {
    const decision = this.checkProjectRoot(projectRoot);
    const project = decision.project ?? this.getProjectByRootPath(decision.canonicalRoot);
    return {
      outcome: "project_status",
      clock: serverClock(),
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
    view?: never;
    select?: never;
    knownRevision?: never;
  }): SessionDetailQueryResult;
  public getSessionDetailForAgent(query: SessionAgentReadQuery): SessionAgentReadResult;
  public getSessionDetailForAgent(query: SessionAgentReadQuery): SessionAgentReadResult {
    if (query.view !== undefined || query.select !== undefined) return this.sessionAgentReads.read(query);
    if (query.knownRevision !== undefined) sessionDetailQuerySchema.parse(query);
    return runReadTransaction(this.db, () => this.readFullSessionForAgent(query));
  }

  /** Paged tracked-only Session list for Agents, scoped by projectRoot or projectId. */
  public listSessionsForAgent(
    input: {
      q?: string;
      from?: string;
      to?: string;
      voided?: SessionVoidedFilter;
      commitSha?: string;
      page?: number;
      pageSize?: number;
    } & TrackedScopeInput,
  ): SessionListQueryResult {
    const scope = this.resolveTrackedScope(input);
    if ("outcome" in scope) {
      return scope;
    }
    const options: SessionListOptions = {
      query: input.q || undefined,
      from: input.from,
      to: input.to,
      voided: input.voided,
      commitSha: input.commitSha?.toLowerCase(),
      page: input.page,
      pageSize: input.pageSize,
      projectId: scope.projectId,
      trackedOnly: true,
    };
    // The prefix is ambiguous only among the Sessions this scope and these filters can return.
    if (options.commitSha && this.sessions.distinctCommitShas(options, 2).length > 1) {
      return {
        outcome: "ambiguous_commit_sha",
        commitSha: options.commitSha,
        reason: "The commitSha prefix matches Sessions of more than one commit; give more characters.",
      };
    }
    return this.listSessionsPage(options);
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

  /** Full Agent read (no view/select) inside one read snapshot, so the body and its revision match. */
  private readFullSessionForAgent(query: SessionAgentReadQuery): SessionAgentReadResult {
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
    const result = toAgentSessionDetail(detail);
    const { revision } = result.session;
    if (sameSessionRevision(query.knownRevision, revision)) return sessionUnchanged(result.session, revision);
    return query.includeRawSnapshots ? { ...result, rawSnapshots: detail.rawSnapshots } : result;
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
  ): { content: string; sourcePath?: string; redactions?: RedactionSummary } | undefined {
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
      // Remove private blocks before the length cut so a block straddling it cannot lose its closing tag.
      const withoutPrivate = redactPrivateBlocksText(readFileSync(handoffPath, "utf8"));
      return {
        content: withoutPrivate.value.slice(0, 200_000),
        sourcePath: input.handoffPath,
        redactions: withoutPrivate.redactions,
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
}
