export type {
  DatabaseBackupCreated,
  DatabaseBackupDeleted,
  DatabaseBackupList,
  DeleteProjectResult,
  FolderPickResult,
  DashboardSummary,
  CancelMetadataBackfillRequestResult,
  CancelReportSynthesisRequestResult,
  CreateMetadataBackfillRequestResult,
  CreateReportSynthesisRequestResult,
  DeleteReportSummaryResult,
  GraphQuery,
  GraphQueryResult,
  HandoffImportApplyInput,
  HandoffImportBatchResult,
  HandoffImportPreviewResult,
  KnowledgeHistoryResult,
  KnowledgeQuery,
  KnowledgeSearchResult,
  DecideKnowledgeCandidateInput,
  DecideKnowledgeCandidateResult,
  KnowledgeCandidateListResult,
  RequestKnowledgeCandidatesResult,
  LinkSessionsResult,
  SessionLinkRelation,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequestListQueryResult,
  PageInfo,
  ProjectDeletionAuditRecord,
  ProjectRecord,
  ProjectDataExportScope,
  ProjectDataImportInput,
  ProjectDataImportPreview,
  ProjectDataImportResult,
  ProjectStatus,
  ReportPeriod,
  WorkReportPeriod,
  ReportExportFormat,
  ReportExportResult,
  ReportQueryResult,
  ReportSynthesisScopeType,
  ReportSummaryQueryResult,
  ReportSynthesisRequestListQueryResult,
  RetryReportSynthesisRequestResult,
  SessionDetail,
  SessionListResult,
  SessionVoidedFilter,
  SetEvidenceVoidInput,
  SetEvidenceVoidResult,
  SetSessionVoidInput,
  SetSessionVoidResult,
  SystemStatus,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult,
  UpdateSessionSummaryInput,
  UpdateSessionVerificationResult,
  VerificationSummary,
  UpdateSessionSummaryResult,
  UpdateSessionWorkSummaryInput,
  UpdateSessionWorkSummaryResult,
} from "@work-intelligence/core";

import type { KnowledgeQuery, ReportPeriod, SessionVoidedFilter } from "@work-intelligence/core";

export type ApiHealth = {
  ok: boolean;
  app: string;
  version: string;
  schemaVersion: number;
  policy: string;
  database: "connected" | "unavailable";
};

export type SessionListRequest = {
  q?: string;
  projectId?: string;
  voided?: SessionVoidedFilter;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number | "all";
};

export type ReportRequest = {
  period: ReportPeriod;
  date?: string;
  /** An explicit calendar range; the server then ignores period and date. */
  from?: string;
  to?: string;
  projectId?: string;
  evidencePage?: number;
  evidencePageSize?: number | "all";
  evidenceKind?: string;
  evidenceQuery?: string;
};

export type KnowledgeRequest = Omit<KnowledgeQuery, "pageSize"> & { pageSize?: number | "all" };
