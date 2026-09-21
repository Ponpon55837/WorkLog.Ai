import {
  CHANGED_FILE_SOURCES,
  CHANGED_FILE_CHANGE_STATUSES,
  CHANGED_FILES_MODES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_STATUSES,
  METADATA_BACKFILL_REQUEST_STATUSES,
  METADATA_BACKFILL_SCOPE_TYPES,
  PROJECT_STATUSES,
  REPORT_EXPORT_FORMATS,
  REPORT_EVIDENCE_KINDS,
  REPORT_PERIODS,
  REPORT_SYNTHESIS_SCOPE_TYPES,
  REPORT_SYNTHESIS_STATUSES,
  SESSION_SUMMARY_UPDATE_MODES,
  WORK_EVENT_TYPES
} from "@work-intelligence/core";
import { z } from "zod";

export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export const workEventTypeSchema = z.enum(WORK_EVENT_TYPES);

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rootPath: z.string().trim().min(1).max(1_000)
});

export const updateProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: projectStatusSchema.optional()
});

export const verificationSchema = z.object({
  status: z.enum(["passed", "failed", "not_run"]),
  summary: z.string().max(2_000).optional()
});

export const changedFileSourceSchema = z.enum(CHANGED_FILE_SOURCES);
export const changedFilesModeSchema = z.enum(CHANGED_FILES_MODES);
export const changedFileChangeStatusSchema = z.enum(CHANGED_FILE_CHANGE_STATUSES);

export const changedFileProvenanceSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  sources: z.array(changedFileSourceSchema).min(1).max(CHANGED_FILE_SOURCES.length),
  references: z.array(z.string().trim().min(1).max(1_000)).max(20).optional()
});

export const changedFileChangeSchema = z
  .object({
    path: z.string().trim().min(1).max(1_000),
    status: changedFileChangeStatusSchema,
    previousPath: z.string().trim().min(1).max(1_000).optional()
  })
  .superRefine((value, context) => {
    if (value.status === "renamed" && !value.previousPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousPath"],
        message: "A renamed file must include previousPath."
      });
    }
  });

const gitSchema = z.object({
  branch: z.string().max(300).optional(),
  commitSha: z.string().max(200).optional(),
  dirty: z.boolean().optional()
});

const eventSchema = z.object({
  type: workEventTypeSchema,
  summary: z.string().trim().min(1).max(4_000),
  details: z.record(z.unknown()).optional(),
  occurredAt: z.string().datetime().optional()
});

const workSummarySectionSchema = z.array(z.string().trim().min(1).max(4_000)).max(20);
export const workSummarySectionsSchema = z.object({
  outcomes: workSummarySectionSchema,
  scope: workSummarySectionSchema,
  decisions: workSummarySectionSchema,
  verification: workSummarySectionSchema,
  nextSteps: workSummarySectionSchema
});

export const finalizeSessionInputSchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  idempotencyKey: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(20_000),
  workSummary: workSummarySectionsSchema.optional(),
  externalSessionId: z.string().trim().max(300).optional(),
  handoffPath: z.string().max(1_000).optional(),
  handoffContent: z.string().max(200_000).optional(),
  events: z.array(eventSchema).max(100).optional(),
  changedFiles: z.array(z.string().max(1_000)).max(200),
  changedFilesProvenance: z.array(changedFileProvenanceSchema).max(200).optional(),
  changedFileChanges: z.array(changedFileChangeSchema).max(200).optional(),
  verification: verificationSchema,
  git: gitSchema.optional(),
  completedAt: z.string().datetime().optional()
});

export const sessionSummaryUpdateModeSchema = z.enum(SESSION_SUMMARY_UPDATE_MODES);

export const mcpFinalizeSessionInputSchema = finalizeSessionInputSchema.extend({
  workSummary: workSummarySectionsSchema
});

export const updateSessionSummaryInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(300),
  mode: sessionSummaryUpdateModeSchema.default("replace"),
  summary: z.string().trim().min(1).max(20_000)
});

export const contextQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000).optional()
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  projectRoot: z.string().trim().min(1).max(1_000).optional()
});

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD format.");
const listPageSizeSchema = z.union([z.literal(0), z.number().int().min(1).max(100)]);

export const sessionsQuerySchema = z
  .object({
    q: z.string().trim().max(500).optional(),
    projectId: z.string().trim().min(1).max(200).optional(),
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    page: z.number().int().min(1).max(10_000).default(1),
    pageSize: listPageSizeSchema.default(10)
  })
  .superRefine((value, context) => {
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "The end date must be on or after the start date."
      });
    }
  });

export const reportQuerySchema = z.object({
  period: z.enum(REPORT_PERIODS).default("week"),
  date: calendarDateSchema.optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  evidenceKind: z.enum(REPORT_EVIDENCE_KINDS).optional(),
  evidenceQuery: z.string().trim().max(500).optional(),
  evidencePage: z.number().int().min(1).max(10_000).default(1),
  evidencePageSize: listPageSizeSchema.default(20)
});

export const reportExportQuerySchema = reportQuerySchema.extend({
  format: z.enum(REPORT_EXPORT_FORMATS).default("markdown")
});

export const reportSynthesisStatusSchema = z.enum(REPORT_SYNTHESIS_STATUSES);
export const reportSynthesisScopeTypeSchema = z.enum(REPORT_SYNTHESIS_SCOPE_TYPES);

export const createReportSynthesisRequestInputSchema = z.object({
  period: z.enum(REPORT_PERIODS).default("week"),
  date: calendarDateSchema.optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(300).optional()
});

export const reportSynthesisRequestQuerySchema = z.object({
  period: z.enum(REPORT_PERIODS).optional(),
  date: calendarDateSchema.optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  status: reportSynthesisStatusSchema.optional(),
  requestId: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20)
});

export const reportSynthesisContextQuerySchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  maxSessions: z.number().int().min(1).max(100).default(24),
  maxEvidence: z.number().int().min(1).max(100).default(40),
  maxHandoffCharacters: z.number().int().min(1_000).max(200_000).default(40_000)
});

export const retryReportSynthesisRequestInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200)
});

export const cancelReportSynthesisRequestInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200)
});

const reportSummaryBlockSchema = z.object({
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().min(1).max(8_000),
  sourceSessionIds: z.array(z.string().trim().min(1).max(200)).max(100)
});

export const saveReportSummaryInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  executiveSummary: z.string().trim().min(1).max(12_000),
  themes: z.array(reportSummaryBlockSchema).max(30).default([]),
  highlights: z.array(reportSummaryBlockSchema).max(50),
  verification: z.array(reportSummaryBlockSchema).max(30).default([]),
  comparison: z.array(reportSummaryBlockSchema).max(30).default([]),
  risks: z.array(reportSummaryBlockSchema).max(50),
  decisions: z.array(reportSummaryBlockSchema).max(50),
  nextSteps: z.array(reportSummaryBlockSchema).max(50),
  sourceSessionIds: z.array(z.string().trim().min(1).max(200)).max(200),
  generatedByAgent: z.string().trim().min(1).max(120),
  generatedByModel: z.string().trim().max(200).optional(),
  promptVersion: z.string().trim().min(1).max(120)
});

export const updateSessionVerificationInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  verification: verificationSchema
});

export const updateSessionMetadataInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  changedFiles: z.array(z.string().max(1_000)).max(200),
  changedFilesMode: changedFilesModeSchema.default("replace"),
  changedFilesProvenance: z.array(changedFileProvenanceSchema).max(200).optional(),
  changedFileChanges: z.array(changedFileChangeSchema).max(200).optional(),
  verification: verificationSchema.optional(),
  git: gitSchema.optional()
});

export const attachEvidenceInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  kind: z.string().trim().min(1).max(80),
  reference: z.string().trim().min(1).max(1_000),
  summary: z.string().trim().max(2_000).optional()
});

export const knowledgeKindSchema = z.enum(KNOWLEDGE_KINDS);
export const knowledgeStatusSchema = z.enum(KNOWLEDGE_STATUSES);

export const recordKnowledgeInputSchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  idempotencyKey: z.string().trim().min(1).max(300),
  kind: knowledgeKindSchema,
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  sessionId: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  references: z.array(z.string().trim().min(1).max(1_000)).max(30).optional()
});

export const updateKnowledgeInputSchemaBase = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  knowledgeId: z.string().trim().min(1).max(200),
  kind: knowledgeKindSchema.optional(),
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().trim().min(1).max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  references: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  status: knowledgeStatusSchema.optional()
});

export const updateKnowledgeInputSchema = updateKnowledgeInputSchemaBase
  .superRefine((value, context) => {
    if (
      value.kind === undefined &&
      value.title === undefined &&
      value.body === undefined &&
      value.tags === undefined &&
      value.references === undefined &&
      value.status === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledgeId"],
        message: "At least one Knowledge field must be updated."
      });
    }
  });

export const knowledgeQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  q: z.string().trim().max(500).optional(),
  kind: knowledgeKindSchema.optional(),
  status: knowledgeStatusSchema.default("active"),
  limit: z.number().int().min(1).max(200).optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: listPageSizeSchema.default(10)
});

export const knowledgeHistoryQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  knowledgeId: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(200).default(100)
});

export const graphQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  maxNodes: z.number().int().min(1).max(500).default(180),
  maxEdges: z.number().int().min(1).max(1_000).default(360)
});

export const metadataBackfillPreviewQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
  limit: z.number().int().min(1).max(500).default(50)
});

export const metadataBackfillApplyInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200).optional(),
  updates: z.array(updateSessionMetadataInputSchema).min(1).max(100)
});

export const metadataBackfillRequestStatusSchema = z.enum(METADATA_BACKFILL_REQUEST_STATUSES);
export const metadataBackfillScopeTypeSchema = z.enum(METADATA_BACKFILL_SCOPE_TYPES);

export const createMetadataBackfillRequestInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(300).optional()
});

export const metadataBackfillRequestQuerySchema = z.object({
  scopeType: metadataBackfillScopeTypeSchema.optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  status: metadataBackfillRequestStatusSchema.optional(),
  requestId: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20)
});

export const metadataBackfillRequestContextQuerySchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(500).default(100)
});

export const cancelMetadataBackfillRequestInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200)
});

export const handoffImportOptionsSchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  handoffDirectory: z.string().trim().min(1).max(1_000).default(".openspec/handoffs"),
  excludePaths: z.array(z.string().trim().min(1).max(1_000)).max(500).default([]),
  maxFiles: z.number().int().min(1).max(500).default(100)
});

export const handoffImportApplyInputSchema = handoffImportOptionsSchema.extend({
  sourcePaths: z.array(z.string().trim().min(1).max(1_000)).max(500)
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;
export type FinalizeSessionInput = z.infer<typeof finalizeSessionInputSchema>;
export type McpFinalizeSessionInput = z.infer<typeof mcpFinalizeSessionInputSchema>;
export type UpdateSessionSummaryInput = z.infer<typeof updateSessionSummaryInputSchema>;
export type SessionsQuery = z.infer<typeof sessionsQuerySchema>;
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;
export type CreateReportSynthesisRequestInput = z.infer<typeof createReportSynthesisRequestInputSchema>;
export type ReportSynthesisRequestQuery = z.infer<typeof reportSynthesisRequestQuerySchema>;
export type ReportSynthesisContextQuery = z.infer<typeof reportSynthesisContextQuerySchema>;
export type RetryReportSynthesisRequestInput = z.infer<typeof retryReportSynthesisRequestInputSchema>;
export type CancelReportSynthesisRequestInput = z.infer<typeof cancelReportSynthesisRequestInputSchema>;
export type SaveReportSummaryInput = z.infer<typeof saveReportSummaryInputSchema>;
export type UpdateSessionVerificationInput = z.infer<typeof updateSessionVerificationInputSchema>;
export type UpdateSessionMetadataInput = z.infer<typeof updateSessionMetadataInputSchema>;
export type AttachEvidenceInput = z.infer<typeof attachEvidenceInputSchema>;
export type RecordKnowledgeInput = z.infer<typeof recordKnowledgeInputSchema>;
export type UpdateKnowledgeInput = z.infer<typeof updateKnowledgeInputSchema>;
export type KnowledgeQuery = z.infer<typeof knowledgeQuerySchema>;
export type KnowledgeHistoryQuery = z.infer<typeof knowledgeHistoryQuerySchema>;
export type GraphQuery = z.infer<typeof graphQuerySchema>;
export type MetadataBackfillPreviewQuery = z.infer<typeof metadataBackfillPreviewQuerySchema>;
export type MetadataBackfillApplyInput = z.infer<typeof metadataBackfillApplyInputSchema>;
export type CreateMetadataBackfillRequestInput = z.infer<typeof createMetadataBackfillRequestInputSchema>;
export type MetadataBackfillRequestQuery = z.infer<typeof metadataBackfillRequestQuerySchema>;
export type MetadataBackfillRequestContextQuery = z.infer<typeof metadataBackfillRequestContextQuerySchema>;
export type CancelMetadataBackfillRequestInput = z.infer<typeof cancelMetadataBackfillRequestInputSchema>;
export type HandoffImportOptions = z.infer<typeof handoffImportOptionsSchema>;
export type HandoffImportApplyInput = z.infer<typeof handoffImportApplyInputSchema>;
