import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NoopInsightProvider } from "@work-intelligence/core";
import type {
  AttachEvidenceInput,
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
  KnowledgeHistoryQuery,
  KnowledgeHistoryResult,
  KnowledgeQuery,
  KnowledgeQueryResult,
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
import { initializeWorkIntelligenceDatabase } from "./database-initialization.js";
import { runImmediateTransaction as runImmediateSqlTransaction } from "./sqlite-transaction.js";
import { KnowledgeCandidateService } from "./knowledge-candidates.js";
import { SearchRepository } from "./search-repository.js";
import { ContextRecallService, type ContextFocus } from "./context-recall-service.js";
import { ProjectDataTransferService } from "./project-data-transfer.js";
import { SessionRecordService } from "./session-record-service.js";
import { KnowledgeService } from "./knowledge-service.js";
import { ProjectDeletionService } from "./project-deletion-service.js";
import type { EvidenceRow, KnowledgeRow } from "./session-record-codecs.js";
import {
  normalizeWorkSummarySections,
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
} from "./session-record-codecs.js";

export type { ContextFocus } from "./context-recall-service.js";

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
}

export class WorkIntelligenceStore {
  private readonly db: DatabaseSync;
  private readonly backupOptions: BackupRetentionOptions;
  private readonly projects: ProjectRepository;
  private readonly sessions: SessionRepository;
  private readonly sessionRecords: SessionRecordService;
  private readonly knowledge: KnowledgeRepository;
  private readonly knowledgeService: KnowledgeService;
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
    this.sessionRecords = new SessionRecordService(this.db, {
      checkProjectById: (projectId) => this.checkProjectById(projectId),
      getSessionById: (sessionId) => this.getSessionById(sessionId),
      getProjectById: (projectId) => this.getProjectById(projectId),
      withKnowledgeTrust: (knowledge) => this.withKnowledgeTrust(knowledge),
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
  private withKnowledgeTrust(knowledge: KnowledgeRecord): KnowledgeRecord {
    return this.knowledgeService.withKnowledgeTrust(knowledge);
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

  public updateSessionWorkSummary(input: UpdateSessionWorkSummaryInput): UpdateSessionWorkSummaryResult {
    return this.sessionRecords.updateSessionWorkSummary(input);
  }

  public getSessionDetail(sessionId: string): SessionDetail | undefined {
    return this.sessionRecords.getSessionDetail(sessionId);
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
}
