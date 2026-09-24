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
  MAX_CUSTOM_REPORT_DAYS,
  REPORT_PERIODS,
  REPORT_SYNTHESIS_SCOPE_TYPES,
  REPORT_SYNTHESIS_STATUSES,
  SESSION_SUMMARY_UPDATE_MODES,
  WORK_REPORT_PERIODS,
  WORK_SUMMARY_UPDATE_MODES,
  WORK_EVENT_TYPES,
  INSIGHT_AVAILABILITIES,
  INSIGHT_PROVIDER_EXECUTIONS,
} from "@work-intelligence/core";
import { z } from "zod";

export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export const workEventTypeSchema = z.enum(WORK_EVENT_TYPES);

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rootPath: z.string().trim().min(1).max(1_000),
});

export const updateProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: projectStatusSchema.optional(),
});

export const verificationSchema = z.object({
  status: z.enum(["passed", "failed", "not_run"]),
  summary: z.string().max(2_000).optional(),
});

export const changedFileSourceSchema = z.enum(CHANGED_FILE_SOURCES);
export const changedFilesModeSchema = z.enum(CHANGED_FILES_MODES);
export const changedFileChangeStatusSchema = z.enum(CHANGED_FILE_CHANGE_STATUSES);

export const changedFileProvenanceSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  sources: z.array(changedFileSourceSchema).min(1).max(CHANGED_FILE_SOURCES.length),
  references: z.array(z.string().trim().min(1).max(1_000)).max(20).optional(),
});

export const changedFileChangeSchema = z
  .object({
    path: z.string().trim().min(1).max(1_000),
    status: changedFileChangeStatusSchema,
    previousPath: z.string().trim().min(1).max(1_000).optional(),
  })
  .superRefine((value, context) => {
    if (value.status === "renamed" && !value.previousPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousPath"],
        message: "A renamed file must include previousPath.",
      });
    }
  });

const gitSchema = z.object({
  branch: z.string().max(300).optional(),
  commitSha: z.string().max(200).optional(),
  dirty: z.boolean().optional(),
});

const eventSchema = z.object({
  type: workEventTypeSchema,
  summary: z.string().trim().min(1).max(4_000),
  details: z.record(z.unknown()).optional(),
  occurredAt: z.string().datetime().optional(),
});

const workSummarySectionSchema = z.array(z.string().trim().min(1).max(4_000)).max(20);
export const workSummarySectionsSchema = z.object({
  outcomes: workSummarySectionSchema.describe("成果：確認完成的交付或已解決問題，使用符合證據的完成程度用語。"),
  scope: workSummarySectionSchema.describe(
    "範圍：重要 module、component、API、UI、locale、test 與可確認的變更數量；避免重複其他區段。",
  ),
  decisions: workSummarySectionSchema.describe("決策：只記錄來源明確提及的技術、API、相容性或安全決策；理由不得推測。"),
  verification: workSummarySectionSchema.describe(
    "驗證：實際命令、結果、數量、瀏覽器／平台覆蓋、人工確認與未驗證範圍；不可把局部驗證寫成全面通過。",
  ),
  nextSteps: workSummarySectionSchema.describe(
    "狀態／未結項：此 API 相容欄位只記錄 finalize 時已知的未完成項、限制、證據缺口或未驗證情境；不得新增建議、計畫或未來展望。沒有已確認內容時使用空陣列。",
  ),
});

export const finalizeSessionInputSchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  idempotencyKey: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe("One concise, outcome-first executive sentence; detailed facts belong in workSummary."),
  workSummary: workSummarySectionsSchema.optional(),
  externalSessionId: z.string().trim().max(300).optional(),
  handoffPath: z.string().max(1_000).optional(),
  handoffContent: z.string().max(200_000).optional(),
  events: z.array(eventSchema).max(100).optional(),
  changedFiles: z.array(z.string().max(1_000)).max(200),
  baselineChangedFiles: z
    .array(z.string().max(1_000))
    .max(200)
    .optional()
    .describe("Paths already changed before this work started; they are excluded from this Session's changed files."),
  changedFilesProvenance: z.array(changedFileProvenanceSchema).max(200).optional(),
  changedFileChanges: z.array(changedFileChangeSchema).max(200).optional(),
  verification: verificationSchema,
  git: gitSchema.optional(),
  startedAt: z
    .string()
    .datetime()
    .optional()
    .describe("When the work began, e.g. the first message of the conversation; must not be after completedAt."),
  completedAt: z.string().datetime().optional(),
  parentSessionId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("An earlier Session this one continues, e.g. the planning Session it implements."),
  relatedSessionIds: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  appliedKnowledgeIds: z
    .array(z.string().trim().min(1).max(200))
    .max(30)
    .optional()
    .describe("Knowledge this work relied on and found still valid."),
  contradictedKnowledgeIds: z
    .array(z.string().trim().min(1).max(200))
    .max(30)
    .optional()
    .describe("Knowledge this work found no longer true; it is flagged for review."),
});

export const sessionSummaryUpdateModeSchema = z.enum(SESSION_SUMMARY_UPDATE_MODES);
export const workSummaryUpdateModeSchema = z.enum(WORK_SUMMARY_UPDATE_MODES);

export const mcpFinalizeSessionInputSchema = finalizeSessionInputSchema.extend({
  workSummary: workSummarySectionsSchema,
});

export const updateSessionSummaryInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(300),
  mode: sessionSummaryUpdateModeSchema.default("replace"),
  summary: z.string().trim().min(1).max(20_000),
});

const workSummaryPatchSchema = workSummarySectionsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one workSummary section is required.");

export const updateSessionWorkSummaryInputSchemaBase = z.object({
  sessionId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(300),
  mode: workSummaryUpdateModeSchema.default("replace"),
  workSummary: z.union([workSummarySectionsSchema, workSummaryPatchSchema]),
});

export const updateSessionWorkSummaryInputSchema = updateSessionWorkSummaryInputSchemaBase.superRefine(
  (value, context) => {
    if (value.mode === "replace" && !workSummarySectionsSchema.safeParse(value.workSummary).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workSummary"],
        message: "replace mode requires all five workSummary sections.",
      });
    }
  },
);

const recallPathsSchema = z.array(z.string().trim().min(1).max(1_000)).max(20);

export const contextQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
  task: z.string().trim().min(1).max(500).optional(),
  paths: recallPathsSchema.optional(),
});

export const recallQuerySchemaBase = z.object({
  q: z.string().trim().min(1).max(500).optional(),
  paths: recallPathsSchema.optional(),
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
  limit: z.number().int().min(1).max(30).optional(),
});

export const recallQuerySchema = recallQuerySchemaBase.refine(
  (value) => Boolean(value.q) || (value.paths?.length ?? 0) > 0,
  { message: "Provide q, paths, or both." },
);

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
});

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD format.");
const listPageSizeSchema = z.union([z.literal(0), z.number().int().min(1).max(100)]);

const voidedFilterSchema = z.enum(["exclude", "include", "only"]);

export const sessionsQuerySchema = z
  .object({
    q: z.string().trim().max(500).optional(),
    projectId: z.string().trim().min(1).max(200).optional(),
    voided: voidedFilterSchema.default("exclude"),
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    page: z.number().int().min(1).max(10_000).default(1),
    pageSize: listPageSizeSchema.default(10),
  })
  .superRefine((value, context) => {
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "The end date must be on or after the start date.",
      });
    }
  });

const projectRootSchema = z.string().trim().min(1).max(1_000);
const projectIdSchema = z.string().trim().min(1).max(200);

export const projectStatusQuerySchema = z.object({
  projectRoot: projectRootSchema,
});

export const sessionDetailQuerySchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  includeRawSnapshots: z.boolean().default(false),
});

/** MCP list: scoped by projectRoot or projectId; no "all" page size so Agent payloads stay bounded. */
export const mcpListSessionsInputSchemaBase = z.object({
  q: z.string().trim().max(500).optional(),
  projectRoot: projectRootSchema.optional(),
  projectId: projectIdSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  voided: voidedFilterSchema.default("exclude"),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export const mcpListSessionsInputSchema = mcpListSessionsInputSchemaBase.superRefine((value, context) => {
  if (value.from && value.to && value.from > value.to) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to"],
      message: "The end date must be on or after the start date.",
    });
  }
});

/** from/to come together, in order, and span at most MAX_CUSTOM_REPORT_DAYS. */
function checkCustomReportRange(value: { from?: string; to?: string }, context: z.RefinementCtx): void {
  if ((value.from === undefined) !== (value.to === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "from and to must be given together." });
    return;
  }
  if (value.from && value.to) {
    const days = (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000 + 1;
    if (!(days >= 1)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must not be before from." });
    } else if (days > MAX_CUSTOM_REPORT_DAYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `A custom report covers at most ${MAX_CUSTOM_REPORT_DAYS} days.`,
      });
    }
  }
}

export const reportQueryObjectSchema = z.object({
  period: z.enum(REPORT_PERIODS).default("week"),
  date: calendarDateSchema.optional(),
  /** An explicit calendar range (e.g. a sprint); when given, period and date are ignored. */
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  evidenceKind: z.enum(REPORT_EVIDENCE_KINDS).optional(),
  evidenceQuery: z.string().trim().max(500).optional(),
  evidencePage: z.number().int().min(1).max(10_000).default(1),
  evidencePageSize: listPageSizeSchema.default(20),
});

export const reportQuerySchema = reportQueryObjectSchema.superRefine(checkCustomReportRange);

export const reportExportQueryObjectSchema = reportQueryObjectSchema.extend({
  format: z.enum(REPORT_EXPORT_FORMATS).default("markdown"),
});
export const reportExportQuerySchema = reportExportQueryObjectSchema.superRefine(checkCustomReportRange);

export const reportSynthesisStatusSchema = z.enum(REPORT_SYNTHESIS_STATUSES);
export const reportSynthesisScopeTypeSchema = z.enum(REPORT_SYNTHESIS_SCOPE_TYPES);

export const createReportSynthesisRequestInputObjectSchema = z.object({
  period: z.enum(WORK_REPORT_PERIODS).default("week"),
  date: calendarDateSchema.optional(),
  /** When both dates are supplied, the request is scoped to this exact custom range. */
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(300).optional(),
});

function checkCreateReportSynthesisRange(
  value: { period: (typeof WORK_REPORT_PERIODS)[number]; from?: string; to?: string },
  context: z.RefinementCtx,
): void {
  checkCustomReportRange(value, context);
  if (value.period === "custom" && (!value.from || !value.to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.from ? "to" : "from"],
      message: "A custom report synthesis request needs both from and to.",
    });
  }
}

export const createReportSynthesisRequestInputSchema = createReportSynthesisRequestInputObjectSchema.superRefine(
  checkCreateReportSynthesisRange,
);

export const mcpCreateReportSynthesisRequestInputObjectSchema = createReportSynthesisRequestInputObjectSchema.extend({
  projectRoot: projectRootSchema.optional(),
});
export const mcpCreateReportSynthesisRequestInputSchema = mcpCreateReportSynthesisRequestInputObjectSchema.superRefine(
  checkCreateReportSynthesisRange,
);

export const reportSynthesisRequestQueryObjectSchema = z.object({
  period: z.enum(WORK_REPORT_PERIODS).optional(),
  date: calendarDateSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  scopeType: reportSynthesisScopeTypeSchema.optional(),
  status: reportSynthesisStatusSchema.optional(),
  requestId: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export const reportSynthesisRequestQuerySchema =
  reportSynthesisRequestQueryObjectSchema.superRefine(checkCustomReportRange);

export const reportSynthesisContextQuerySchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  maxSessions: z.number().int().min(1).max(100).default(24),
  maxEvidence: z.number().int().min(1).max(100).default(40),
  maxHandoffCharacters: z.number().int().min(1_000).max(200_000).default(40_000),
});

export const retryReportSynthesisRequestInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
});

export const cancelReportSynthesisRequestInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
});

const reportSummaryBlockSchema = z.object({
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().min(1).max(8_000),
  sourceSessionIds: z.array(z.string().trim().min(1).max(200)).max(100),
});

export const saveReportSummaryInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  executiveSummary: z.string().trim().min(1).max(12_000),
  themes: z
    .array(reportSummaryBlockSchema)
    .max(30)
    .default([])
    .describe(
      "Group at period scale: daily task/feature, weekly workstream, monthly project/milestone, quarterly initiative, annual major contribution.",
    ),
  highlights: z
    .array(reportSummaryBlockSchema)
    .max(50)
    .describe(
      "Evidence-backed outcomes and material scope; group related Sessions and avoid chronology or duplicate facts.",
    ),
  verification: z
    .array(reportSummaryBlockSchema)
    .max(30)
    .default([])
    .describe(
      "Exact representative verification evidence; distinguish passed, failed, not_run, not_supplied, partial coverage, and unverified platforms.",
    ),
  comparison: z
    .array(reportSummaryBlockSchema)
    .max(30)
    .default([])
    .describe(
      "Previous-period comparisons or objective trends only when deterministic source data supports them; otherwise use an empty array.",
    ),
  risks: z
    .array(reportSummaryBlockSchema)
    .max(50)
    .describe(
      "Evidence-backed risks and known limitations that remain; do not turn them into future-work recommendations.",
    ),
  decisions: z
    .array(reportSummaryBlockSchema)
    .max(50)
    .describe("Explicit decisions and documented trade-offs only; cite the Sessions that support each block."),
  nextSteps: z
    .array(reportSummaryBlockSchema)
    .max(50)
    .describe(
      "Compatibility field for confirmed current status/open items/limitations only. Do not add plans, recommendations, or future outlook; use an empty array when none.",
    ),
  sourceSessionIds: z.array(z.string().trim().min(1).max(200)).max(200),
  generatedByAgent: z.string().trim().min(1).max(120),
  generatedByModel: z.string().trim().max(200).optional(),
  promptVersion: z.string().trim().min(1).max(120),
});

export const updateSessionVerificationInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  verification: verificationSchema,
});

export const updateSessionMetadataInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  changedFiles: z.array(z.string().max(1_000)).max(200),
  changedFilesMode: changedFilesModeSchema.default("replace"),
  changedFilesProvenance: z.array(changedFileProvenanceSchema).max(200).optional(),
  changedFileChanges: z.array(changedFileChangeSchema).max(200).optional(),
  verification: verificationSchema.optional(),
  git: gitSchema.optional(),
  startedAt: z.string().datetime().optional(),
});

const voidReasonSchema = z.string().trim().min(1).max(1_000);

function requireReasonWhenVoiding(value: { voided: boolean; reason?: string }, context: z.RefinementCtx): void {
  if (value.voided && !value.reason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "A reason is required to void." });
  }
}

export const setSessionVoidInputSchemaBase = z.object({
  sessionId: z.string().trim().min(1).max(200),
  voided: z.boolean().default(true),
  reason: voidReasonSchema.optional(),
});

export const setSessionVoidInputSchema = setSessionVoidInputSchemaBase.superRefine(requireReasonWhenVoiding);

export const setEvidenceVoidInputSchemaBase = z.object({
  evidenceId: z.string().trim().min(1).max(200),
  voided: z.boolean().default(true),
  reason: voidReasonSchema.optional(),
});

export const setEvidenceVoidInputSchema = setEvidenceVoidInputSchemaBase.superRefine(requireReasonWhenVoiding);

export const linkSessionsInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  relatedSessionId: z.string().trim().min(1).max(200),
  relation: z.enum(["continues", "related"]).default("related"),
  linked: z.boolean().default(true),
});

export const attachEvidenceInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  kind: z.string().trim().min(1).max(80),
  reference: z.string().trim().min(1).max(1_000),
  summary: z.string().trim().max(2_000).optional(),
});

export const knowledgeKindSchema = z.enum(KNOWLEDGE_KINDS);
export const knowledgeStatusSchema = z.enum(KNOWLEDGE_STATUSES);

const knowledgeAppliesToSchema = z
  .array(z.string().trim().min(1).max(1_000))
  .max(30)
  .describe("Project-relative paths or globs (*, **, ?) this Knowledge is about.");

export const recordKnowledgeInputSchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  idempotencyKey: z.string().trim().min(1).max(300),
  kind: knowledgeKindSchema,
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  sessionId: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  references: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  appliesTo: knowledgeAppliesToSchema.optional(),
  supersedesId: z.string().trim().min(1).max(200).optional(),
});

export const requestKnowledgeCandidatesInputSchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
});

export const knowledgeCandidateContextQuerySchemaBase = z.object({
  requestId: z.string().trim().min(1).max(200).optional(),
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
});

export const knowledgeCandidateContextQuerySchema = knowledgeCandidateContextQuerySchemaBase.refine(
  (value) => Boolean(value.requestId || value.projectRoot),
  { message: "Provide requestId or projectRoot." },
);

const knowledgeCandidateSchema = z.object({
  sourceSessionId: z.string().trim().min(1).max(200),
  kind: knowledgeKindSchema,
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  references: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  appliesTo: knowledgeAppliesToSchema.optional(),
  rationale: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe("Why this is reusable, pointing to the supporting part of the source Session."),
});

export const submitKnowledgeCandidatesInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  candidates: z.array(knowledgeCandidateSchema).max(30),
});

export const knowledgeCandidateListQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
  status: z.enum(["proposed", "accepted", "rejected"]).default("proposed"),
});

export const decideKnowledgeCandidateInputSchema = z.object({
  candidateId: z.string().trim().min(1).max(200),
  decision: z.enum(["accept", "reject"]),
  edits: z
    .object({
      kind: knowledgeKindSchema.optional(),
      title: z.string().trim().min(1).max(300).optional(),
      body: z.string().trim().min(1).max(20_000).optional(),
      tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
      references: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
      appliesTo: knowledgeAppliesToSchema.optional(),
    })
    .optional(),
});

export const updateKnowledgeInputSchemaBase = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  knowledgeId: z.string().trim().min(1).max(200),
  kind: knowledgeKindSchema.optional(),
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().trim().min(1).max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  references: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  status: knowledgeStatusSchema.optional(),
  appliesTo: knowledgeAppliesToSchema.optional(),
  confirm: z.literal(true).optional().describe("Record that the Knowledge was checked and still holds."),
});

export const updateKnowledgeInputSchema = updateKnowledgeInputSchemaBase.superRefine((value, context) => {
  if (
    value.kind === undefined &&
    value.title === undefined &&
    value.body === undefined &&
    value.tags === undefined &&
    value.references === undefined &&
    value.status === undefined &&
    value.appliesTo === undefined &&
    value.confirm === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["knowledgeId"],
      message: "At least one Knowledge field must be updated.",
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
  pageSize: listPageSizeSchema.default(10),
});

export const knowledgeHistoryQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  knowledgeId: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(200).default(100),
});

export const graphQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  maxNodes: z.number().int().min(1).max(500).default(180),
  maxEdges: z.number().int().min(1).max(1_000).default(360),
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
});

export const metadataBackfillPreviewQuerySchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000).optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

export const metadataBackfillApplyInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200).optional(),
  updates: z.array(updateSessionMetadataInputSchema).min(1).max(100),
});

export const metadataBackfillRequestStatusSchema = z.enum(METADATA_BACKFILL_REQUEST_STATUSES);
export const metadataBackfillScopeTypeSchema = z.enum(METADATA_BACKFILL_SCOPE_TYPES);

export const createMetadataBackfillRequestInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(300).optional(),
});

export const mcpCreateMetadataBackfillRequestInputSchema = createMetadataBackfillRequestInputSchema.extend({
  projectRoot: projectRootSchema.optional(),
});

export const metadataBackfillRequestQuerySchema = z.object({
  scopeType: metadataBackfillScopeTypeSchema.optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  status: metadataBackfillRequestStatusSchema.optional(),
  requestId: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const metadataBackfillRequestContextQuerySchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(500).default(100),
});

export const cancelMetadataBackfillRequestInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
});

export const handoffImportOptionsSchema = z.object({
  projectRoot: z.string().trim().min(1).max(1_000),
  handoffDirectory: z.string().trim().min(1).max(1_000).default(".openspec/handoffs"),
  excludePaths: z.array(z.string().trim().min(1).max(1_000)).max(500).default([]),
  maxFiles: z.number().int().min(1).max(500).default(100),
});

export const handoffImportApplyInputSchema = handoffImportOptionsSchema.extend({
  sourcePaths: z.array(z.string().trim().min(1).max(1_000)).max(500),
});

const insightChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string()),
});

const insightScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string(),
  criteria: z.array(z.string()),
});

const insightNoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
});

export const insightProviderExecutionSchema = z.enum(INSIGHT_PROVIDER_EXECUTIONS);
export const insightAvailabilitySchema = z.enum(INSIGHT_AVAILABILITIES);
export const insightProviderDescriptorSchema = z.object({
  id: z.string(),
  execution: insightProviderExecutionSchema,
  model: z.string(),
});
export const insightQuestionSchema = z.discriminatedUnion("type", [
  insightChoiceQuestionSchema,
  insightScoreQuestionSchema,
  insightNoulQuestionSchema,
]);
export const insightQuestionsSchema = z.record(insightQuestionSchema);
export const insightSignalSchema = z.object({
  value: z.unknown(),
  confidence: z.number().optional(),
  probability: z.number().optional(),
  distribution: z.record(z.number()).optional(),
});
export const insightEvaluationSchema = z.object({
  provider: z.string(),
  model: z.string(),
  results: z.record(insightSignalSchema),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      requestUnits: z.number().optional(),
      estimatedCost: z.number().optional(),
      currency: z.string().optional(),
    })
    .optional(),
  latencyMs: z.number(),
  evaluatedAt: z.string(),
  adapterVersion: z.string().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;
export type FinalizeSessionInput = z.infer<typeof finalizeSessionInputSchema>;
export type McpFinalizeSessionInput = z.infer<typeof mcpFinalizeSessionInputSchema>;
export type UpdateSessionSummaryInput = z.infer<typeof updateSessionSummaryInputSchema>;
export type UpdateSessionWorkSummaryInput = z.infer<typeof updateSessionWorkSummaryInputSchema>;
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
export type ProjectStatusQuery = z.infer<typeof projectStatusQuerySchema>;
export type SessionDetailQuery = z.infer<typeof sessionDetailQuerySchema>;
export type McpListSessionsInput = z.infer<typeof mcpListSessionsInputSchema>;
export type McpCreateReportSynthesisRequestInput = z.infer<typeof mcpCreateReportSynthesisRequestInputSchema>;
export type McpCreateMetadataBackfillRequestInput = z.infer<typeof mcpCreateMetadataBackfillRequestInputSchema>;
