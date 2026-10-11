import type {
  PageInfo,
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
export type AgentReportContext = Omit<
  ReportSynthesisContextResult,
  "request" | "report" | "sessions" | "handoffSummaries"
> & {
  request: Omit<ReportSynthesisRequest, "sourceSessionIds">;
  report: Omit<WorkReport, "sessions" | "completedWork" | "sourceSessionIds">;
  sessions: ReportSourcePreview[];
  projection: ReportAgentProjection;
};

export type AgentReportNotReady = Omit<ReportSynthesisRequestNotReadyResult, "request"> & {
  request: Omit<ReportSynthesisRequest, "sourceSessionIds">;
  sourceSessionCount: number;
  projection: ReportAgentProjection;
};

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

/** Remove complete items, never silently cut evidence or recalculate whole-period totals from a page. */
function bound(
  result: AgentReport | AgentReportContext,
  report: Omit<WorkReport, "sessions" | "completedWork" | "sourceSessionIds">,
  sources: ReportSourcePreview[],
  syncIds: () => void,
): void {
  const fields: Array<[string, unknown[]]> = [
    ["evidence", report.evidence],
    ["decisions", report.decisions],
    ["pendingDecisions", report.agentAutonomousDecisions.pendingItems],
    ["risks", report.risks],
    ["projects", report.projects],
    ["startedEarlier", report.spanning.startedEarlier],
    ["continuedLater", report.spanning.continuedLater],
    ["updatedInPeriod", report.spanning.updatedInPeriod],
    ["trends", report.trends],
    ["sessions", sources],
  ];
  let characters = JSON.stringify(result).length;
  for (const [key, items] of fields) {
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
  bound(result, result, sources, () => {
    result.sourceSessionIds = sources.map((source) => source.id);
  });
  return result;
}

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
  const result: AgentReportContext = {
    ...base,
    request,
    report,
    sessions: sources,
    sourceSessionIds: sources.map((source) => source.id),
    projection: projection(maxCharacters, "work_get_report_context", [
      "request.sourceSessionIds",
      "report.sessions",
      "report.completedWork",
      "report.sourceSessionIds",
      "sessionDetails",
      "handoffSummaries",
    ]),
  };
  bound(result, report, sources, () => {
    result.sourceSessionIds = sources.map((source) => source.id);
  });
  return result;
}
