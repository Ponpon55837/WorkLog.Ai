import type {
  PageInfo,
  ReportEvidence,
  ReportInsight,
  ReportProjectSummary,
  ReportQueryResult,
  ReportSynthesisContextQueryResult,
  ReportSynthesisContextResult,
  ReportSynthesisRequest,
  ReportSynthesisRequestNotReadyResult,
  WorkReport,
  WorkSessionRecord,
  ReportVerificationStatus,
} from "@work-intelligence/core";

export interface ReportSourcePreview {
  id: string;
  title: string;
  summary: string;
  completedAt: string;
  verificationStatus: ReportVerificationStatus;
  truncatedFields: string[];
}

export interface ReportAgentProjection {
  version: 1;
  view: "agent";
  previewOnly: true;
  maxCharacters: number;
  omittedFields: string[];
  budgetOmitted: Record<string, number>;
  sourceSessionIdsOmitted: string[];
  moreSourceSessionIdsOmitted: number;
  readWith: { source: "work_get_session"; details: "work_get_report" | "work_get_report_context"; view: "full" };
}

export type AgentReport = Omit<WorkReport, "sessions" | "completedWork"> & {
  sessions: ReportSourcePreview[];
  sourcePageInfo: PageInfo;
  projection: ReportAgentProjection;
};

/** An item's Session-id list in the report block: the first ids, and how many more the full report lists. */
export type BoundedSourceIds<T extends { sourceSessionIds: string[] }> = T & { sourceSessionIdsOmittedCount?: number };

/** Context evidence belongs to a Session of the same page, whose preview already carries its title. */
export type AgentReportEvidence = Omit<ReportEvidence, "sessionTitle" | "projectName">;

/** The period-level report block. It is the same on every Session page, so the Agent context sends it once. */
export type AgentReportBlock = Omit<
  WorkReport,
  "sessions" | "completedWork" | "sourceSessionIds" | "projects" | "risks" | "evidence"
> & {
  projects: Array<BoundedSourceIds<ReportProjectSummary>>;
  risks: Array<BoundedSourceIds<ReportInsight>>;
  evidence: AgentReportEvidence[];
};

/** What a later Session page carries of the report: only the evidence of its own Sessions. */
export type AgentReportPageEvidence = Pick<AgentReportBlock, "evidence" | "evidencePageInfo">;

export type AgentReportContext = Omit<
  ReportSynthesisContextResult,
  "request" | "report" | "sessions" | "handoffSummaries"
> & {
  request: Omit<ReportSynthesisRequest, "sourceSessionIds">;
  report: AgentReportBlock | AgentReportPageEvidence;
  /** On a later Session page: the page that carries the report block (read it again there after a restart). */
  reportBlockOnSessionPage?: 1;
  sessions: ReportSourcePreview[];
  projection: ReportAgentProjection;
};

export type AgentReportNotReady = Omit<ReportSynthesisRequestNotReadyResult, "request"> & {
  request: Omit<ReportSynthesisRequest, "sourceSessionIds">;
  sourceSessionCount: number;
  projection: ReportAgentProjection;
};

/** Session ids an item of the context report block keeps; the full lists repeat the period's Session pages. */
const BLOCK_SOURCE_ID_LIMIT = 8;

function preview(session: WorkSessionRecord): ReportSourcePreview {
  return {
    id: session.id,
    title: session.title.slice(0, 120),
    summary: session.summary.slice(0, 240),
    completedAt: session.completedAt,
    verificationStatus: session.verification?.status ?? "not_supplied",
    truncatedFields: [session.title.length > 120 ? "title" : "", session.summary.length > 240 ? "summary" : ""].filter(
      Boolean,
    ),
  };
}

function projection(
  maxCharacters: number,
  details: "work_get_report" | "work_get_report_context",
  omittedFields: string[],
): ReportAgentProjection {
  return {
    version: 1,
    view: "agent",
    previewOnly: true,
    maxCharacters: Math.min(Math.max(Math.trunc(maxCharacters), 12_000), 60_000),
    omittedFields,
    budgetOmitted: {},
    sourceSessionIdsOmitted: [],
    moreSourceSessionIdsOmitted: 0,
    readWith: { source: "work_get_session", details, view: "full" },
  };
}

function reportFields(
  report: Omit<WorkReport, "sessions" | "completedWork" | "sourceSessionIds"> | AgentReportBlock,
): Array<[string, unknown[]]> {
  return [
    ["evidence", report.evidence],
    ["decisions", report.decisions],
    ["pendingDecisions", report.agentAutonomousDecisions.pendingItems],
    ["risks", report.risks],
    ["projects", report.projects],
    ["startedEarlier", report.spanning.startedEarlier],
    ["continuedLater", report.spanning.continuedLater],
    ["updatedInPeriod", report.spanning.updatedInPeriod],
    ["trends", report.trends],
  ];
}

/** Remove complete items, never silently cut evidence or recalculate whole-period totals from a page. */
function bound(
  result: AgentReport | AgentReportContext,
  fields: Array<[string, unknown[]]>,
  sources: ReportSourcePreview[],
  syncIds: () => void,
): void {
  let characters = JSON.stringify(result).length;
  for (const [key, items] of [...fields, ["sessions", sources] as [string, unknown[]]]) {
    while (items.length && characters > result.projection.maxCharacters) {
      const beforeMetadata = JSON.stringify(result.projection).length;
      const beforeIds = key === "sessions" ? JSON.stringify(result.sourceSessionIds).length : 0;
      const removed = items.pop();
      characters -= JSON.stringify(removed).length + (items.length ? 1 : 0);
      result.projection.budgetOmitted[key] = (result.projection.budgetOmitted[key] ?? 0) + 1;
      if (key === "sessions") {
        const id = (removed as ReportSourcePreview).id;
        if (result.projection.sourceSessionIdsOmitted.length < 5) result.projection.sourceSessionIdsOmitted.push(id);
        else result.projection.moreSourceSessionIdsOmitted++;
        syncIds();
        characters += JSON.stringify(result.sourceSessionIds).length - beforeIds;
      }
      characters += JSON.stringify(result.projection).length - beforeMetadata;
    }
  }
  // The non-source envelope is bounded by input schemas. Fail closed if a future field breaks that invariant.
  if (JSON.stringify(result).length > result.projection.maxCharacters)
    throw new Error("Report projection envelope exceeded its budget.");
}

/** Keep the first Session ids of a long list and count the rest; the Session pages list every source. */
function boundSourceIds<T extends { sourceSessionIds: string[] }>(item: T): BoundedSourceIds<T> {
  if (item.sourceSessionIds.length <= BLOCK_SOURCE_ID_LIMIT) return item;
  return {
    ...item,
    sourceSessionIds: item.sourceSessionIds.slice(0, BLOCK_SOURCE_ID_LIMIT),
    sourceSessionIdsOmittedCount: item.sourceSessionIds.length - BLOCK_SOURCE_ID_LIMIT,
  };
}

function contextEvidence({ sessionTitle: _title, projectName: _project, ...evidence }: ReportEvidence) {
  return evidence;
}

function reportCopy(report: WorkReport): WorkReport {
  return {
    ...report,
    evidence: [...report.evidence],
    decisions: [...report.decisions],
    risks: [...report.risks],
    projects: [...report.projects],
    trends: [...report.trends],
    agentAutonomousDecisions: {
      ...report.agentAutonomousDecisions,
      pendingItems: [...report.agentAutonomousDecisions.pendingItems],
    },
    spanning: {
      startedEarlier: [...report.spanning.startedEarlier],
      continuedLater: [...report.spanning.continuedLater],
      updatedInPeriod: [...report.spanning.updatedInPeriod],
    },
  };
}

export function toAgentReport(
  input: ReportQueryResult,
  options: { maxCharacters?: number; sessionPage?: number; maxSessions?: number } = {},
): AgentReport | Exclude<ReportQueryResult, WorkReport> {
  if (input.outcome !== "report") return input;
  const copy = reportCopy(input);
  const { completedWork: _completed, sessions: original, ...base } = copy;
  const pageSize = Math.min(Math.max(options.maxSessions ?? 24, 1), 100);
  const totalPages = Math.max(1, Math.ceil(original.length / pageSize));
  const page = Math.min(Math.max(options.sessionPage ?? 1, 1), totalPages);
  const sources = original.slice((page - 1) * pageSize, page * pageSize).map(preview);
  const result: AgentReport = {
    ...base,
    sessions: sources,
    sourceSessionIds: sources.map((source) => source.id),
    sourcePageInfo: {
      page,
      pageSize,
      total: original.length,
      totalPages,
      from: original.length ? (page - 1) * pageSize + 1 : 0,
      to: Math.min(page * pageSize, original.length),
      hasPrevious: page > 1,
      hasNext: page < totalPages,
      truncated: input.sessionTruncation.currentPeriod,
    },
    projection: projection(options.maxCharacters ?? 24_000, "work_get_report", ["completedWork", "sessionDetails"]),
  };
  bound(result, reportFields(result), sources, () => {
    result.sourceSessionIds = sources.map((source) => source.id);
  });
  return result;
}

/**
 * The report block (period totals, comparison, projects, risks, decisions, trends, spanning) does not depend on the
 * Session page, so only sessionPage 1 carries it; a later page keeps the evidence of its own Sessions and points
 * back to page 1. Asking for page 1 again always returns the block, so no server-side paging state is needed.
 */
export function toAgentReportContext(
  input: ReportSynthesisContextQueryResult,
  maxCharacters = 24_000,
):
  | AgentReportContext
  | AgentReportNotReady
  | Exclude<ReportSynthesisContextQueryResult, ReportSynthesisContextResult | ReportSynthesisRequestNotReadyResult> {
  if (input.outcome === "report_synthesis_request_not_ready") {
    const { sourceSessionIds, ...request } = input.request;
    return {
      ...input,
      request,
      sourceSessionCount: sourceSessionIds.length,
      projection: projection(maxCharacters, "work_get_report_context", ["request.sourceSessionIds"]),
    };
  }
  if (input.outcome !== "report_context") return input;
  const { sourceSessionIds: _requestIds, ...request } = input.request;
  const {
    sessions: _reportSources,
    completedWork: _completed,
    sourceSessionIds: _reportIds,
    ...report
  } = reportCopy(input.report);
  const { handoffSummaries: _handoffs, ...base } = input;
  const sources = input.sessions.map(preview);
  const firstPage = input.coverage.sessionPageInfo.page === 1;
  const evidence = report.evidence.map(contextEvidence);
  const block: AgentReportBlock = {
    ...report,
    projects: report.projects.map(boundSourceIds),
    risks: report.risks.map(boundSourceIds),
    evidence,
  };
  const pageEvidence: AgentReportPageEvidence = { evidence, evidencePageInfo: report.evidencePageInfo };
  const result: AgentReportContext = {
    ...base,
    request,
    report: firstPage ? block : pageEvidence,
    ...(firstPage ? {} : { reportBlockOnSessionPage: 1 as const }),
    sessions: sources,
    sourceSessionIds: sources.map((source) => source.id),
    projection: projection(maxCharacters, "work_get_report_context", [
      "request.sourceSessionIds",
      "report.sessions",
      "report.completedWork",
      "report.sourceSessionIds",
      ...(firstPage ? [] : ["report.block"]),
      "sessionDetails",
      "handoffSummaries",
    ]),
  };
  bound(result, firstPage ? reportFields(block) : [["evidence", pageEvidence.evidence]], sources, () => {
    result.sourceSessionIds = sources.map((source) => source.id);
  });
  return result;
}
