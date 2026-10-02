import type {
  ChangedFileChangeStatus,
  ChangedFileSource,
  DatabaseBackupKind,
  GraphNode,
  KnowledgeAuditAction,
  OutstandingItemStatus,
  ProjectDeletionCounts,
  ProjectStatus,
  ReportEvidence,
  ReportInsightKind,
  SessionLinkDirection,
  SessionVoidedFilter,
  WorkReportPeriod,
  WorkSummarySections,
} from "@work-intelligence/core";
import {
  knowledgeKindVisual,
  knowledgeStatusVisual,
  outstandingItemStatusVisual,
  trackingStatus,
  type StatusVisual,
} from "./status";
import { translatedOptions, translatedRecord } from "../i18n";

function labelsOf<K extends string>(visuals: Record<K, StatusVisual>): Record<K, string> {
  const labels = {} as Record<K, string>;
  for (const key of Object.keys(visuals) as K[]) {
    // A getter, so the label follows the locale like the StatusVisual it reads.
    Object.defineProperty(labels, key, { enumerable: true, get: () => visuals[key].label });
  }
  return labels;
}

/** Label-only views of the status maps in utils/status.ts (single source of truth). */
export const statusLabels = labelsOf(trackingStatus);
export const knowledgeKindLabels = labelsOf(knowledgeKindVisual);
export const knowledgeStatusLabels = labelsOf(knowledgeStatusVisual);
export const outstandingItemStatusLabels: Record<OutstandingItemStatus, string> = labelsOf(outstandingItemStatusVisual);

export const databaseBackupKindLabels: Record<DatabaseBackupKind, string> = translatedRecord({
  automatic: "labels.dailyAutomatic",
  manual: "labels.manual",
  migration: "labels.beforeDatabaseMigration",
  deletion: "labels.beforeProjectDeletion",
  maintenance: "labels.beforeDataMaintenance",
});

export const projectDeletionCountLabels: Record<keyof ProjectDeletionCounts, string> = translatedRecord({
  projects: "common.project",
  sessions: "labels.sessions",
  workEvents: "labels.workEvents",
  rawSnapshots: "labels.rawSnapshots",
  evidence: "labels.evidenceTerm",
  knowledge: "labels.knowledge",
  knowledgeAudit: "labels.knowledgeAuditRecords",
  voidAudit: "labels.voidAuditRecords",
  sessionVerificationUpdates: "labels.verificationUpdates",
  sessionLinks: "labels.sessionLinks",
  knowledgeCandidateRequests: "labels.knowledgeCandidateRequests",
  knowledgeCandidates: "common.knowledgeCandidates",
  reportSynthesisRequests: "labels.reportSynthesisRequests",
  reportSummaries: "labels.reportSummaries",
  metadataBackfillRequests: "labels.metadataBackfillRequests",
  sessionSummaryUpdates: "labels.sessionSummaryUpdates",
  sessionWorkSummaryUpdates: "labels.worksummaryUpdates",
  sessionDecisions: "labels.sessionDecisions",
  outstandingItems: "common.openItems",
  outstandingCleanupRequests: "common.cleanupRequests",
  outstandingCleanupRequestItems: "labels.cleanupItemSnapshots",
  outstandingCleanupSubmissions: "labels.cleanupSubmissions",
  outstandingCleanupProposals: "common.suggestions",
  outstandingCleanupProposalEvidence: "labels.suggestionEvidence",
  outstandingItemEvents: "labels.openItemStatusAuditRecords",
  knowledgePages: "common.knowledgePages",
  knowledgePageVersions: "labels.knowledgePageVersions",
  knowledgeFeedback: "labels.knowledgeConfirmationAndContradictionRecords",
  sessionDiagrams: "labels.sessionDiagrams",
  searchChunks: "labels.searchIndexChunks",
  searchFts: "labels.fullTextSearchIndex",
  searchPaths: "labels.searchPaths",
  searchDirty: "labels.pendingSearchIndexItems",
});

export const listPageSizeOptions = [
  { value: 10, label: "10" },
  { value: 20, label: "20" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: "all", label: "All" },
] as const;
export type ListPageSize = (typeof listPageSizeOptions)[number]["value"];

export const sessionLinkDirectionLabels: Record<SessionLinkDirection, string> = translatedRecord({
  continues: "labels.continues",
  continued_by: "labels.continuedBy",
  related: "labels.relatedOption",
});

/** Link choices from the open Session's point of view; `reverse` stores the link on the other Session. */
export const sessionLinkOptions = translatedOptions(
  [
    { value: "continues", label: "labels.thisSessionContinuesTheSelected" },
    { value: "continued_by", label: "labels.theSelectedSessionContinuesThis" },
    { value: "related", label: "labels.related" },
  ] as const satisfies ReadonlyArray<{ value: SessionLinkDirection; label: string }>,
  "label",
);

export const voidedFilterOptions: Array<{ value: SessionVoidedFilter; label: string }> = translatedOptions(
  [
    { value: "exclude", label: "labels.excludeVoided" },
    { value: "include", label: "labels.includeVoided" },
    { value: "only", label: "labels.voidedOnly" },
  ],
  "label",
);

export function pageSizeToQuery(value: ListPageSize): number {
  return value === "all" ? 0 : value;
}

export type ReportTab = "overview" | "work" | "trend" | "risks" | "raw" | "evidence";
export const reportTabOptions: Array<{ id: ReportTab; label: string; shortLabel: string }> = translatedOptions(
  [
    { id: "overview", label: "labels.reportOverview", shortLabel: "common.overview" },
    { id: "work", label: "labels.outcomesAndVerification", shortLabel: "labels.work" },
    { id: "trend", label: "labels.trendsAndProjects", shortLabel: "labels.trend" },
    { id: "risks", label: "labels.risksAndDecisions", shortLabel: "labels.risks" },
    { id: "raw", label: "common.rawWorkRecords", shortLabel: "labels.rawRecords" },
    { id: "evidence", label: "common.sourceEvidence", shortLabel: "labels.evidence" },
  ],
  "label",
  "shortLabel",
);

export const workSummarySectionLabels: Array<{ key: keyof WorkSummarySections; label: string }> = translatedOptions(
  [
    { key: "outcomes", label: "labels.outcomes" },
    { key: "scope", label: "labels.scope" },
    { key: "decisions", label: "common.decisions" },
    { key: "verification", label: "common.verification" },
    { key: "nextSteps", label: "common.statusOpenItems" },
  ],
  "label",
);

export const statusDescriptions: Record<ProjectStatus, string> = translatedRecord({
  unregistered: "labels.notAuthorizedEveryIngestIs",
  tracked: "labels.explicitlyAuthorizedHandoffsCanBe",
  paused: "labels.trackingPausedExistingDataIs",
  ignored: "labels.explicitlyExcludedNoNewWork",
});

export const changedFileSourceLabels: Record<ChangedFileSource, string> = translatedRecord({
  agent: "labels.agent",
  handoff: "labels.handoff",
  git: "labels.git",
  worktree: "labels.worktree",
});

export const changedFileChangeStatusLabels: Record<ChangedFileChangeStatus, string> = translatedRecord({
  added: "common.added",
  modified: "labels.modified",
  deleted: "labels.delete",
  renamed: "labels.renamed",
});

export const reportPeriodLabels: Record<WorkReportPeriod, string> = translatedRecord({
  day: "labels.today",
  week: "labels.thisWeek",
  month: "common.thisMonth",
  quarter: "labels.thisQuarter",
  year: "labels.thisYear",
  custom: "common.customRange",
});

export const insightKindLabels: Record<ReportInsightKind, string> = translatedRecord({
  verification: "labels.verification",
  metadata: "labels.metadata",
  event: "labels.event",
  hotspot: "common.hotspots",
});

export const evidenceKindLabels: Record<ReportEvidence["kind"], string> = translatedRecord({
  handoff: "labels.handoff",
  verification: "labels.verification",
  "changed-files": "labels.changedFilesTerm",
  event: "labels.event",
  attached: "labels.attachedEvidenceTerm",
});

export const knowledgeAuditActionLabels: Record<KnowledgeAuditAction, string> = translatedRecord({
  created: "labels.create",
  updated: "labels.updated",
  archived: "common.archive",
  restored: "labels.restored",
});

export const graphNodeKindOrder = ["project", "session", "knowledge", "evidence", "file"] as const;

export const graphNodeKindLabels: Record<GraphNode["kind"], string> = translatedRecord({
  project: "common.project",
  session: "labels.workSession",
  knowledge: "common.workKnowledge",
  evidence: "labels.evidence",
  file: "labels.changedFiles",
});

export const graphEdgeKindLabels = translatedRecord({
  contains: "labels.contains",
  changed_file: "labels.changedFiles",
  has_knowledge: "labels.linkedKnowledge",
  has_evidence: "labels.attachedEvidence",
  session_link: "labels.sessionLinks",
  co_changed: "labels.changedTogetherDerived",
});

export const graphMetadataLabels: Record<string, string> = translatedRecord({
  rootPath: "labels.projectRoot",
  status: "labels.trackingStatus",
  completedAt: "common.completed",
  changedFilesCount: "labels.changedFiles",
  verification: "labels.verification",
  kind: "labels.dataType",
  tagsCount: "labels.tagCount",
  reference: "labels.reference",
  capturedAt: "labels.captured",
  path: "labels.filePath",
});
