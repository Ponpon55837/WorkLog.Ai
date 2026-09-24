import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  CancelReportSynthesisRequestResult,
  CreateReportSynthesisRequestInput,
  CreateReportSynthesisRequestResult,
  DeleteReportSummaryResult,
  PolicyDecision,
  ProjectRecord,
  ReportPeriod,
  ReportQueryResult,
  ReportSummary,
  ReportSummaryBlock,
  ReportSummaryListResult,
  ReportSummaryQuery,
  ReportSummaryQueryResult,
  ReportSynthesisContextQuery,
  ReportSynthesisContextQueryResult,
  ReportSynthesisContextResult,
  ReportSynthesisRequest,
  ReportSynthesisRequestDetailResult,
  ReportSynthesisRequestListQueryResult,
  ReportSynthesisRequestLookupResult,
  ReportSynthesisRequestQuery,
  ReportSummaryRequestNotReadyResult,
  RetryReportSynthesisRequestResult,
  SaveReportSummaryInput,
  SaveReportSummaryResult,
  WorkReport,
} from "@work-intelligence/core";
import { nowIso, toLocalCalendarDate } from "@work-intelligence/shared";
import { createPageInfo } from "./pagination.js";
import { getReportRange } from "./report-utils.js";
import { ReportSynthesisRequestRepository } from "./report-synthesis-request-repository.js";
import { runImmediateTransaction as runImmediateSqlTransaction } from "./sqlite-transaction.js";

type ReportReaderOptions = {
  period: ReportPeriod;
  date?: string;
  projectId?: string;
  evidencePage?: number;
  evidencePageSize?: number;
  includeAllEvidence?: boolean;
};

interface ReportSynthesisStoreReader {
  getProjectById(projectId: string): ProjectRecord | undefined;
  checkProjectById(projectId: string): PolicyDecision;
  getReport(options: ReportReaderOptions): ReportQueryResult;
}

type ReportSynthesisRequestRow = {
  id: string;
  idempotency_key: string;
  scope_type: "all" | "project";
  project_id: string | null;
  project_name: string | null;
  period: ReportPeriod;
  range_from: string;
  range_to: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  source_session_ids_json: string;
};

type ReportSummaryRow = {
  id: string;
  request_id: string;
  period: ReportPeriod;
  range_from: string;
  range_to: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  executive_summary: string;
  themes_json: string;
  highlights_json: string;
  verification_json: string;
  comparison_json: string;
  risks_json: string;
  decisions_json: string;
  next_steps_json: string;
  source_session_ids_json: string;
  generated_by_agent: string;
  generated_by_model: string | null;
  prompt_version: string;
  created_at: string;
  is_current: number;
};

type SynthesisSnapshotRow = {
  id: string;
  session_id: string;
  project_id: string;
  kind: "handoff";
  source_path: string | null;
  content: string;
  captured_at: string;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toReportSynthesisRequest(row: ReportSynthesisRequestRow): ReportSynthesisRequest {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    scopeType: row.scope_type,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    period: row.period,
    range: { from: row.range_from, to: row.range_to },
    status: row.status,
    requestedAt: row.requested_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    sourceSessionIds: parseJson<string[]>(row.source_session_ids_json, []),
  };
}

function toReportSummary(row: ReportSummaryRow): ReportSummary {
  return {
    id: row.id,
    requestId: row.request_id,
    period: row.period,
    range: { from: row.range_from, to: row.range_to },
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    title: row.title,
    executiveSummary: row.executive_summary,
    themes: parseJson<ReportSummaryBlock[]>(row.themes_json, []),
    highlights: parseJson<ReportSummaryBlock[]>(row.highlights_json, []),
    verification: parseJson<ReportSummaryBlock[]>(row.verification_json, []),
    comparison: parseJson<ReportSummaryBlock[]>(row.comparison_json, []),
    risks: parseJson<ReportSummaryBlock[]>(row.risks_json, []),
    decisions: parseJson<ReportSummaryBlock[]>(row.decisions_json, []),
    nextSteps: parseJson<ReportSummaryBlock[]>(row.next_steps_json, []),
    sourceSessionIds: parseJson<string[]>(row.source_session_ids_json, []),
    generatedByAgent: row.generated_by_agent,
    ...(row.generated_by_model ? { generatedByModel: row.generated_by_model } : {}),
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    isCurrent: row.is_current === 1,
  };
}

export class ReportSynthesisService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly store: ReportSynthesisStoreReader,
    private readonly repository: ReportSynthesisRequestRepository,
  ) {}

  private runImmediateTransaction<T>(operation: () => T): T {
    return runImmediateSqlTransaction(this.db, operation);
  }

  private recoverStaleReportSynthesisRequests(): void {
    this.repository.recoverStale();
  }

  public createReportSynthesisRequest(input: CreateReportSynthesisRequestInput): CreateReportSynthesisRequestResult {
    this.recoverStaleReportSynthesisRequests();
    let project: ProjectRecord | undefined;
    if (input.projectId) {
      project = this.store.getProjectById(input.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: input.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        };
      }
      const decision = this.store.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const range = getReportRange(input.period, input.date ?? toLocalCalendarDate());
    const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();

    const report = this.store.getReport({
      period: input.period,
      date: input.date,
      projectId: project?.id,
      evidencePage: 1,
      evidencePageSize: 100,
      includeAllEvidence: true,
    });
    if (report.outcome !== "report") {
      return report;
    }

    const requestedAt = nowIso();
    const id = randomUUID();
    return this.runImmediateTransaction(() => {
      const existingRow = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM report_synthesis_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.idempotency_key = ?`,
        )
        .get(idempotencyKey) as ReportSynthesisRequestRow | undefined;
      if (existingRow) {
        return {
          outcome: "report_synthesis_request",
          duplicate: true,
          request: toReportSynthesisRequest(existingRow),
        };
      }

      this.db
        .prepare(
          `INSERT INTO report_synthesis_requests (
             id, idempotency_key, scope_type, project_id, period, range_from, range_to,
             status, requested_at, source_session_ids_json
           ) VALUES (@id, @idempotencyKey, @scopeType, @projectId, @period, @rangeFrom, @rangeTo,
                     'pending', @requestedAt, @sourceSessionIds)`,
        )
        .run({
          id,
          idempotencyKey,
          scopeType: project ? "project" : "all",
          projectId: project?.id ?? null,
          period: input.period,
          rangeFrom: range.from,
          rangeTo: range.to,
          requestedAt,
          sourceSessionIds: JSON.stringify(report.sourceSessionIds),
        });

      const row = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM report_synthesis_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.id = ?`,
        )
        .get(id) as ReportSynthesisRequestRow | undefined;
      if (!row) {
        throw new Error("Report synthesis request was inserted but could not be loaded.");
      }
      return {
        outcome: "report_synthesis_request",
        duplicate: false,
        request: toReportSynthesisRequest(row),
      };
    });
  }

  public listReportSynthesisRequests(options: ReportSynthesisRequestQuery = {}): ReportSynthesisRequestListQueryResult {
    this.recoverStaleReportSynthesisRequests();
    if (options.projectId) {
      const project = this.store.getProjectById(options.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: options.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        };
      }
      const decision = this.store.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const clauses = ["(r.project_id IS NULL OR p.status = 'tracked')"];
    const parameters: Array<string | number> = [];
    if (options.projectId) {
      clauses.push("r.project_id = ?");
      parameters.push(options.projectId);
    }
    if (options.scopeType) {
      clauses.push("r.scope_type = ?");
      parameters.push(options.scopeType);
    }
    if (options.requestId) {
      clauses.push("r.id = ?");
      parameters.push(options.requestId);
    }
    if (options.status) {
      clauses.push("r.status = ?");
      parameters.push(options.status);
    }
    if (options.period) {
      clauses.push("r.period = ?");
      parameters.push(options.period);
      if (options.date) {
        const range = getReportRange(options.period, options.date);
        clauses.push("r.range_from = ?", "r.range_to = ?");
        parameters.push(range.from, range.to);
      }
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const rows = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY r.requested_at DESC, r.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit) as ReportSynthesisRequestRow[];
    return {
      outcome: "report_synthesis_requests",
      requests: rows.map(toReportSynthesisRequest),
    };
  }

  public getReportSynthesisRequest(requestId: string): ReportSynthesisRequestLookupResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId };
    }
    if (row.project_id) {
      const decision = this.store.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }
    const summaryRow = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM report_summaries s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.request_id = ? AND s.is_current = 1
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 1`,
      )
      .get(requestId) as ReportSummaryRow | undefined;
    const result: ReportSynthesisRequestDetailResult = {
      outcome: "report_synthesis_request_detail",
      request: toReportSynthesisRequest(row),
    };
    if (summaryRow) {
      result.summary = toReportSummary(summaryRow);
    }
    return result;
  }

  public retryReportSynthesisRequest(requestId: string): RetryReportSynthesisRequestResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId };
    }

    if (row.project_id) {
      const decision = this.store.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const request = toReportSynthesisRequest(row);
    if (request.status !== "failed" && request.status !== "cancelled") {
      return {
        outcome: "report_synthesis_retry_rejected",
        requestId,
        status: request.status,
        reason:
          request.status === "processing"
            ? "The report synthesis request is still processing. Wait for the timeout recovery or let the Agent finish before retrying."
            : "Only failed or cancelled report synthesis requests can be retried.",
      };
    }

    const nextRequestId = randomUUID();
    const nextIdempotencyKey = `${request.idempotencyKey}:retry:${nextRequestId}`;
    const requestedAt = nowIso();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE report_synthesis_requests
           SET status = 'cancelled', failure_reason = ?
           WHERE id = ? AND status IN ('failed', 'cancelled')`,
        )
        .run(`Superseded by retry request ${nextRequestId}.`, request.id);
      this.db
        .prepare(
          `INSERT INTO report_synthesis_requests (
             id, idempotency_key, scope_type, project_id, period, range_from, range_to,
             status, requested_at, source_session_ids_json
           ) VALUES (@id, @idempotencyKey, @scopeType, @projectId, @period, @rangeFrom, @rangeTo,
                     'pending', @requestedAt, @sourceSessionIds)`,
        )
        .run({
          id: nextRequestId,
          idempotencyKey: nextIdempotencyKey,
          scopeType: request.scopeType,
          projectId: request.projectId ?? null,
          period: request.period,
          rangeFrom: request.range.from,
          rangeTo: request.range.to,
          requestedAt,
          sourceSessionIds: JSON.stringify(request.sourceSessionIds),
        });
      const nextRow = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM report_synthesis_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.id = ?`,
        )
        .get(nextRequestId) as ReportSynthesisRequestRow | undefined;
      if (!nextRow) {
        throw new Error("Report synthesis retry request was inserted but could not be loaded.");
      }
      this.db.exec("COMMIT");
      return {
        outcome: "report_synthesis_request_retried",
        previousRequestId: request.id,
        request: toReportSynthesisRequest(nextRow),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public cancelReportSynthesisRequest(requestId: string): CancelReportSynthesisRequestResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId };
    }

    if (row.project_id) {
      const decision = this.store.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const request = toReportSynthesisRequest(row);
    if (request.status === "cancelled") {
      return { outcome: "report_synthesis_request_cancelled", duplicate: true, request };
    }
    if (request.status !== "pending" && request.status !== "processing") {
      return {
        outcome: "report_synthesis_cancel_rejected",
        requestId,
        status: request.status,
        reason: "只有等待 Agent 處理或 Agent 處理中的報告提煉可以取消。",
      };
    }

    this.db
      .prepare(
        `UPDATE report_synthesis_requests
         SET status = 'cancelled', failure_reason = ?, completed_at = NULL
         WHERE id = ? AND status IN ('pending', 'processing')`,
      )
      .run("使用者取消這次報告提煉；既有摘要與歷史版本保留。", requestId);
    const nextRow = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as ReportSynthesisRequestRow | undefined;
    if (!nextRow) {
      return { outcome: "not_found", requestId };
    }
    const nextRequest = toReportSynthesisRequest(nextRow);
    if (nextRequest.status !== "cancelled") {
      return {
        outcome: "report_synthesis_cancel_rejected",
        requestId,
        status: nextRequest.status,
        reason: "這次報告提煉已在取消前被其他流程更新，請重新整理狀態。",
      };
    }
    return { outcome: "report_synthesis_request_cancelled", duplicate: false, request: nextRequest };
  }

  public getReportSynthesisContext(options: ReportSynthesisContextQuery): ReportSynthesisContextQueryResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(options.requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId: options.requestId };
    }

    if (row.project_id) {
      const decision = this.store.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const request = toReportSynthesisRequest(row);
    if (request.status === "cancelled") {
      return {
        outcome: "report_synthesis_request_not_ready",
        request,
        reason: "這次報告提煉已取消；請建立新的提煉請求後再取得報告 Context。",
      };
    }
    if (request.status === "pending") {
      const startedAt = nowIso();
      this.db
        .prepare(
          "UPDATE report_synthesis_requests SET status = 'processing', started_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(startedAt, request.id);
      request.status = "processing";
      request.startedAt = startedAt;
    }

    const maxEvidence = Math.min(Math.max(Math.trunc(options.maxEvidence ?? 40), 1), 100);
    const reportResult = this.store.getReport({
      period: request.period,
      date: request.range.from,
      projectId: request.projectId,
      evidencePage: 1,
      evidencePageSize: maxEvidence,
    });
    if (reportResult.outcome !== "report") {
      return reportResult;
    }

    const maxSessions = Math.min(Math.max(Math.trunc(options.maxSessions ?? 24), 1), 100);
    const sourceSessionSet = new Set(request.sourceSessionIds);
    const availableSessions = reportResult.sessions.filter((session) => sourceSessionSet.has(session.id));
    const sessions = availableSessions.slice(0, maxSessions);
    const selectedSessionIds = new Set(sessions.map((session) => session.id));
    const handoffRows = selectedSessionIds.size
      ? (this.db
          .prepare(
            `SELECT rs.*, s.title AS session_title, p.name AS project_name
             FROM raw_snapshots rs
             CROSS JOIN sessions s ON s.id = rs.session_id
             CROSS JOIN projects p ON p.id = rs.project_id
             WHERE p.status = 'tracked'
               AND rs.session_id IN (${[...selectedSessionIds].map(() => "?").join(", ")})
             ORDER BY rs.captured_at ASC, rs.id ASC`,
          )
          .all(...selectedSessionIds) as Array<SynthesisSnapshotRow & { session_title: string; project_name: string }>)
      : [];
    const maxHandoffCharacters = Math.min(Math.max(Math.trunc(options.maxHandoffCharacters ?? 40_000), 1_000), 200_000);
    let remainingCharacters = maxHandoffCharacters;
    const handoffSummaries = handoffRows.flatMap((snapshot) => {
      if (remainingCharacters <= 0) {
        return [];
      }
      const content = snapshot.content.slice(0, remainingCharacters);
      remainingCharacters -= content.length;
      return [
        {
          sessionId: snapshot.session_id,
          sessionTitle: snapshot.session_title,
          projectName: snapshot.project_name,
          ...(snapshot.source_path ? { sourcePath: snapshot.source_path } : {}),
          content,
        },
      ];
    });
    const totalHandoffCharacters = selectedSessionIds.size
      ? Number(
          (
            this.db
              .prepare(
                `SELECT COALESCE(SUM(LENGTH(rs.content)), 0) AS total
               FROM raw_snapshots rs
               CROSS JOIN projects p ON p.id = rs.project_id
               WHERE p.status = 'tracked'
                 AND rs.session_id IN (${[...selectedSessionIds].map(() => "?").join(", ")})`,
              )
              .get(...selectedSessionIds) as { total: number }
          ).total,
        )
      : 0;
    const contextEvidence = reportResult.evidence.filter((item) => selectedSessionIds.has(item.sessionId));
    const contextSourceSessionIds = request.sourceSessionIds.filter((sessionId) => selectedSessionIds.has(sessionId));
    const contextReport: WorkReport = {
      ...reportResult,
      sourceSessionIds: contextSourceSessionIds,
      sessions,
      completedWork: sessions.slice(0, 6),
      evidence: contextEvidence,
      evidencePageInfo: createPageInfo(1, Math.max(contextEvidence.length, 1), contextEvidence.length, 100),
    };
    const context: ReportSynthesisContextResult = {
      outcome: "report_context",
      request,
      report: contextReport,
      sessions,
      handoffSummaries,
      sourceSessionIds: contextSourceSessionIds,
      truncation: {
        sessions: availableSessions.length > sessions.length,
        evidence: reportResult.evidencePageInfo.total > contextEvidence.length,
        handoffCharacters: totalHandoffCharacters > maxHandoffCharacters,
      },
    };
    return context;
  }

  public saveReportSummary(input: SaveReportSummaryInput): SaveReportSummaryResult {
    this.recoverStaleReportSynthesisRequests();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM report_synthesis_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(input.requestId) as ReportSynthesisRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId: input.requestId };
    }

    if (row.project_id) {
      const decision = this.store.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const existingRow = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM report_summaries s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.request_id = ? AND s.is_current = 1
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 1`,
      )
      .get(input.requestId) as ReportSummaryRow | undefined;
    if (existingRow && row.status === "completed") {
      return { outcome: "report_summary_saved", duplicate: true, summary: toReportSummary(existingRow) };
    }

    if (row.status === "failed" || row.status === "cancelled") {
      const result: ReportSummaryRequestNotReadyResult = {
        outcome: "report_summary_request_not_ready",
        requestId: row.id,
        status: row.status,
        reason:
          row.status === "failed"
            ? "The report synthesis request failed or timed out. Retry the request before saving a summary."
            : "The report synthesis request was superseded by a retry and can no longer accept a summary.",
      };
      return result;
    }

    const request = toReportSynthesisRequest(row);
    const allowedSourceIds = new Set(request.sourceSessionIds);
    const sourceSessionIds = [...new Set(input.sourceSessionIds)];
    const invalidSourceId = sourceSessionIds.find((sessionId) => !allowedSourceIds.has(sessionId));
    if (invalidSourceId) {
      throw new Error(`Summary sourceSessionIds must belong to the synthesis request: ${invalidSourceId}`);
    }
    if (sourceSessionIds.length > 0) {
      const trackedCount = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sessions s
           CROSS JOIN projects p ON p.id = s.project_id
           WHERE p.status = 'tracked'
             AND s.id IN (${sourceSessionIds.map(() => "?").join(", ")})`,
        )
        .get(...sourceSessionIds) as { count: number };
      if (trackedCount.count !== sourceSessionIds.length) {
        throw new Error("Summary sourceSessionIds must reference tracked projects only.");
      }
    }

    const summary: ReportSummary = {
      id: randomUUID(),
      requestId: request.id,
      period: request.period,
      range: request.range,
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.projectName ? { projectName: request.projectName } : {}),
      title: input.title.trim(),
      executiveSummary: input.executiveSummary.trim(),
      themes: input.themes ?? [],
      highlights: input.highlights,
      verification: input.verification ?? [],
      comparison: input.comparison ?? [],
      risks: input.risks,
      decisions: input.decisions,
      nextSteps: input.nextSteps,
      sourceSessionIds,
      generatedByAgent: input.generatedByAgent.trim(),
      ...(input.generatedByModel?.trim() ? { generatedByModel: input.generatedByModel.trim() } : {}),
      promptVersion: input.promptVersion.trim(),
      createdAt: nowIso(),
      isCurrent: true,
    };

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE report_summaries
           SET is_current = 0
           WHERE period = ? AND range_from = ? AND range_to = ?
             AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))`,
        )
        .run(
          request.period,
          request.range.from,
          request.range.to,
          request.projectId ?? null,
          request.projectId ?? null,
        );
      this.db
        .prepare(
          `INSERT INTO report_summaries (
             id, request_id, period, range_from, range_to, project_id, title, executive_summary,
             themes_json, highlights_json, verification_json, comparison_json, risks_json, decisions_json,
             next_steps_json, source_session_ids_json,
             generated_by_agent, generated_by_model, prompt_version, created_at, is_current
           ) VALUES (
             @id, @requestId, @period, @rangeFrom, @rangeTo, @projectId, @title, @executiveSummary,
             @themes, @highlights, @verification, @comparison, @risks, @decisions, @nextSteps, @sourceSessionIds,
             @generatedByAgent, @generatedByModel, @promptVersion, @createdAt, 1
           )`,
        )
        .run({
          id: summary.id,
          requestId: summary.requestId,
          period: summary.period,
          rangeFrom: summary.range.from,
          rangeTo: summary.range.to,
          projectId: summary.projectId ?? null,
          title: summary.title,
          executiveSummary: summary.executiveSummary,
          themes: JSON.stringify(summary.themes),
          highlights: JSON.stringify(summary.highlights),
          verification: JSON.stringify(summary.verification),
          comparison: JSON.stringify(summary.comparison),
          risks: JSON.stringify(summary.risks),
          decisions: JSON.stringify(summary.decisions),
          nextSteps: JSON.stringify(summary.nextSteps),
          sourceSessionIds: JSON.stringify(summary.sourceSessionIds),
          generatedByAgent: summary.generatedByAgent,
          generatedByModel: summary.generatedByModel ?? null,
          promptVersion: summary.promptVersion,
          createdAt: summary.createdAt,
        });
      this.db
        .prepare(
          "UPDATE report_synthesis_requests SET status = 'completed', completed_at = ?, failure_reason = NULL WHERE id = ?",
        )
        .run(summary.createdAt, request.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { outcome: "report_summary_saved", duplicate: false, summary };
  }

  public listReportSummaries(options: ReportSummaryQuery = {}): ReportSummaryQueryResult {
    if (options.projectId) {
      const project = this.store.getProjectById(options.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: options.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        };
      }
      const decision = this.store.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const clauses = ["(s.project_id IS NULL OR p.status = 'tracked')"];
    const parameters: Array<string | number> = [];
    if (options.projectId) {
      clauses.push("s.project_id = ?");
      parameters.push(options.projectId);
    }
    if (options.scopeType) {
      clauses.push("s.request_id IN (SELECT id FROM report_synthesis_requests WHERE scope_type = ?)");
      parameters.push(options.scopeType);
    }
    if (options.period) {
      clauses.push("s.period = ?");
      parameters.push(options.period);
      if (options.date) {
        const range = getReportRange(options.period, options.date);
        clauses.push("s.range_from = ?", "s.range_to = ?");
        parameters.push(range.from, range.to);
      }
    }
    if (options.requestId) {
      clauses.push("s.request_id = ?");
      parameters.push(options.requestId);
    }
    if (options.currentOnly !== false) {
      clauses.push("s.is_current = 1");
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const rows = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM report_summaries s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit) as ReportSummaryRow[];
    const result: ReportSummaryListResult = { outcome: "report_summaries", summaries: rows.map(toReportSummary) };
    return result;
  }

  public deleteReportSummary(summaryId: string): DeleteReportSummaryResult {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM report_summaries s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(summaryId) as ReportSummaryRow | undefined;
    if (!row) {
      return { outcome: "not_found", summaryId };
    }

    if (row.project_id) {
      const decision = this.store.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    if (row.is_current === 1) {
      return {
        outcome: "report_summary_delete_rejected",
        summaryId,
        reason: "目前使用中的報告版本不能移除；請保留至少一個目前版本。",
      };
    }

    this.db.prepare("DELETE FROM report_summaries WHERE id = ? AND is_current = 0").run(summaryId);
    return { outcome: "report_summary_deleted", summaryId, deleted: true };
  }
}
