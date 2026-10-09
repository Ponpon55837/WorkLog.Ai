import { DatabaseSync } from "node:sqlite";
import type {
  ProjectRecord,
  ReportEvidenceKind,
  ReportExportFormat,
  ReportExportResult,
  ReportPeriod,
  ReportQueryResult,
  ReportRange,
  ReportEvidence,
  ReportDecision,
  ReportInsight,
  ReportProjectSummary,
  ReportSpanningSession,
  ReportSpanningSessions,
  ReportVerificationStatus,
  SessionDecisionRecord,
  WorkReportPeriod,
  WorkSessionRecord,
} from "@work-intelligence/core";
import { localDayStartIso, localTimeZone, toLocalCalendarDate } from "@work-intelligence/shared";
import { createPageInfo } from "./pagination.js";
import { ReportBuilder } from "./report-builder.js";
import { CHANGED_FILES_NORMAL } from "./search-repository.js";
import { nextCalendarDate, type SessionListOptions } from "./session-repository.js";
import {
  buildReportTrends,
  compareReportMetric,
  getPreviousCustomRange,
  getPreviousReportRange,
  getReportRange,
  getReportTrendGranularity,
  verificationStatusLabel,
  type ReportEventRow,
} from "./report-utils.js";

interface ReportStoreReader {
  getProjectById(projectId: string): ProjectRecord | undefined;
  listSessions(options: SessionListOptions): WorkSessionRecord[];
}

type ReportAttachedEvidenceRow = {
  session_id: string;
  kind: string;
  reference: string;
  summary: string | null;
  session_title: string;
  project_name: string | null;
};

type ReportSnapshotSummaryRow = {
  session_id: string;
  source_path: string | null;
};

interface WorkReportAgentDecisions {
  total: number;
  pending: number;
  pendingItems: SessionDecisionRecord[];
}

interface ReportPeriodMetrics {
  sessions: number;
  events: number;
  changedFiles: number;
  changedFilesOversizedSessions: number;
  verification: Record<ReportVerificationStatus, number>;
  projects: Array<{ projectId: string; projectName: string; sessionCount: number; eventCount: number }>;
}

type ReportProjectMetricsRow = {
  project_id: string;
  project_name: string;
  sessions: number;
  changed_files: number;
  oversized: number;
  passed: number;
  failed: number;
  in_progress: number;
  not_run: number;
  not_supplied: number;
};

const REPORT_SESSION_LIMIT = 200;
const REPORT_PENDING_DECISION_LIMIT = 20;

export class ReportReadService {
  private readonly reportBuilder = new ReportBuilder();

  public constructor(
    private readonly db: DatabaseSync,
    private readonly store: ReportStoreReader,
  ) {}

  private getProjectById(projectId: string): ProjectRecord | undefined {
    return this.store.getProjectById(projectId);
  }

  private listSessions(options: SessionListOptions): WorkSessionRecord[] {
    return this.store.listSessions(options);
  }

  /** Sessions that belong to the period without being counted in it (see WorkReport.spanning). */
  private getReportSpanningSessions(
    range: ReportRange,
    sessions: WorkSessionRecord[],
    projectId: string | undefined,
  ): ReportSpanningSessions {
    const limit = 20;
    const digest = (session: WorkSessionRecord): ReportSpanningSession => ({
      id: session.id,
      title: session.title,
      ...(session.projectName ? { projectName: session.projectName } : {}),
      ...(session.startedAt ? { startedAt: session.startedAt } : {}),
      completedAt: session.completedAt,
      updatedAt: session.updatedAt,
    });
    const periodStart = localDayStartIso(range.from) ?? range.from;
    const scope = { projectId, trackedOnly: true, limit };
    return {
      startedEarlier: sessions
        .filter((session) => session.startedAt && session.startedAt < periodStart)
        .slice(0, limit)
        .map(digest),
      continuedLater: this.listSessions({
        ...scope,
        startedFrom: range.from,
        startedTo: range.to,
        completedAfter: range.to,
      }).map(digest),
      updatedInPeriod: this.listSessions({
        ...scope,
        updatedFrom: range.from,
        updatedTo: range.to,
        completedBefore: range.from,
      }).map(digest),
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
    let project: ProjectRecord | undefined;
    if (options.projectId) {
      project = this.getProjectById(options.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: options.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        };
      }
      if (project.status !== "tracked") {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: project.status,
          reason: "Project reporting is not enabled for this tracking state.",
        };
      }
    }

    const customRange = options.from && options.to ? { from: options.from, to: options.to } : undefined;
    const period: WorkReportPeriod = customRange ? "custom" : options.period;
    const range = customRange ?? getReportRange(options.period, options.date ?? toLocalCalendarDate());
    const agentAutonomousDecisions = this.getAgentAutonomousDecisions(range, project?.id);
    const previousRange = customRange ? getPreviousCustomRange(range) : getPreviousReportRange(options.period, range);
    const sessions = this.listSessions({
      from: range.from,
      to: range.to,
      projectId: project?.id,
      trackedOnly: true,
      limit: REPORT_SESSION_LIMIT,
    });
    // Counts cover the whole period; only the listed Sessions and what is derived from them stop at the limit.
    const currentMetrics = this.getReportPeriodMetrics(range, project?.id);
    const previousMetrics = this.getReportPeriodMetrics(previousRange, project?.id);
    const sessionTruncation = {
      currentPeriod: currentMetrics.sessions > REPORT_SESSION_LIMIT,
      previousPeriod: previousMetrics.sessions > REPORT_SESSION_LIMIT,
    };
    const sessionIds = sessions.map((session) => session.id);
    const eventRows = this.getReportEvents(sessionIds);
    const snapshotRows = sessionIds.length
      ? (this.db
          .prepare(
            `SELECT rs.session_id, rs.source_path
             FROM raw_snapshots rs
             CROSS JOIN projects p ON p.id = rs.project_id
             WHERE p.status = 'tracked'
               AND rs.session_id IN (${sessionIds.map(() => "?").join(", ")})
             ORDER BY rs.captured_at ASC, rs.id ASC`,
          )
          .all(...sessionIds) as ReportSnapshotSummaryRow[])
      : [];
    const attachedEvidenceRows = sessionIds.length
      ? (this.db
          .prepare(
            `SELECT e.*, s.title AS session_title, p.name AS project_name
             FROM evidence e
             CROSS JOIN sessions s ON s.id = e.session_id
             CROSS JOIN projects p ON p.id = e.project_id
             WHERE p.status = 'tracked'
               AND e.voided_at IS NULL
               AND e.session_id IN (${sessionIds.map(() => "?").join(", ")})
             ORDER BY e.captured_at ASC, e.id ASC`,
          )
          .all(...sessionIds) as ReportAttachedEvidenceRow[])
      : [];

    // Project shares are counted over the whole period; source ids name the listed Sessions behind each share.
    const sourceIdsByProject = new Map<string, string[]>();
    for (const session of sessions) {
      const ids = sourceIdsByProject.get(session.projectId) ?? [];
      ids.push(session.id);
      sourceIdsByProject.set(session.projectId, ids);
    }
    const projectSummaries: ReportProjectSummary[] = currentMetrics.projects.map((summary) => ({
      ...summary,
      sourceSessionIds: sourceIdsByProject.get(summary.projectId) ?? [],
    }));

    const comparison = {
      sessions: compareReportMetric(currentMetrics.sessions, previousMetrics.sessions),
      events: compareReportMetric(currentMetrics.events, previousMetrics.events),
      changedFiles: compareReportMetric(currentMetrics.changedFiles, previousMetrics.changedFiles),
    };
    const periodScope = project ? `專案「${project.name}」` : `${projectSummaries.length} 個記錄中專案`;
    const oversizedNote = currentMetrics.changedFilesOversizedSessions
      ? `（另有 ${currentMetrics.changedFilesOversizedSessions} 個 Session 列出超過 ${CHANGED_FILES_NORMAL} 個檔案，未計入）`
      : "";
    const periodSummary = currentMetrics.sessions
      ? `${range.from} 至 ${range.to}，${periodScope}完成 ${currentMetrics.sessions} 個 Session，留下 ${currentMetrics.events} 個事件與 ${currentMetrics.changedFiles} 筆檔案變更 metadata${oversizedNote}。`
      : `${range.from} 至 ${range.to} 沒有可彙整的完成工作。`;

    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const eventsBySession = new Map<string, ReportEventRow[]>();
    for (const event of eventRows) {
      const events = eventsBySession.get(event.session_id) ?? [];
      events.push(event);
      eventsBySession.set(event.session_id, events);
    }
    const snapshotsBySession = new Map<string, ReportSnapshotSummaryRow>();
    for (const snapshot of snapshotRows) {
      if (!snapshotsBySession.has(snapshot.session_id)) {
        snapshotsBySession.set(snapshot.session_id, snapshot);
      }
    }

    const risks: ReportInsight[] = [];
    const verificationIds = new Map<ReportVerificationStatus, string[]>([
      ["passed", []],
      ["failed", []],
      ["in_progress", []],
      ["not_run", []],
      ["not_supplied", []],
    ]);
    const missingHandoffIds: string[] = [];
    const missingChangedFileIds: string[] = [];
    // Classify bounded report sources once; each risk reuses ids without scanning Sessions again.
    for (const session of sessions) {
      const status = session.verification?.status ?? "not_supplied";
      const ids = verificationIds.get(status) ?? verificationIds.get("not_supplied")!;
      ids.push(session.id);
      if (!snapshotsBySession.has(session.id)) missingHandoffIds.push(session.id);
      if (session.changedFiles.length === 0) missingChangedFileIds.push(session.id);
    }
    const verificationRisks = [
      {
        status: "not_supplied",
        label: "Verification 尚未回報",
        detail: "沒有結構化 verification；不能只根據文件內容推測結果。",
      },
      {
        status: "not_run",
        label: "Verification 明確標示未執行",
        detail: "由 Agent 明確回報 verification 尚未執行；Agent 應再確認是否能補回 passed 或 failed。",
      },
      {
        status: "in_progress",
        label: "Verification 進行中",
        detail: "回報 verification 正在進行；結果尚未確定，不能視為通過或失敗。",
      },
      { status: "failed", label: "Verification 失敗", detail: "回報 failed，請回到來源工作檢查驗證事件。" },
    ] as const;
    for (const risk of verificationRisks) {
      const ids = verificationIds.get(risk.status)!;
      if (ids.length)
        risks.push({
          kind: "verification",
          label: risk.label,
          detail: `${ids.length} 個 Session ${risk.detail}`,
          sourceSessionIds: ids,
        });
    }
    if (missingHandoffIds.length) {
      risks.push({
        kind: "metadata",
        label: "Handoff snapshot 未保存",
        detail: `${missingHandoffIds.length} 個 Session 沒有可追溯的 raw handoff snapshot。`,
        sourceSessionIds: missingHandoffIds,
      });
    }
    if (missingChangedFileIds.length) {
      risks.push({
        kind: "metadata",
        label: "變更檔案 metadata 未提供",
        detail: `${missingChangedFileIds.length} 個 Session 沒有 changed files metadata；請由 Agent 檢查工作樹後補回，這不代表工作沒有完成。`,
        sourceSessionIds: missingChangedFileIds,
      });
    }

    const decisions: ReportDecision[] = eventRows
      .filter((event) => event.type === "note" || event.type === "closing")
      .sort((left, right) => {
        if (right.occurred_at !== left.occurred_at) {
          return right.occurred_at < left.occurred_at ? -1 : 1;
        }
        return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
      })
      .slice(0, 8)
      .flatMap((event) => {
        const session = sessionById.get(event.session_id);
        return session
          ? [
              {
                sessionId: session.id,
                sessionTitle: session.title,
                projectName: session.projectName,
                summary: event.summary,
                occurredAt: event.occurred_at,
              },
            ]
          : [];
      });

    const spanning = this.getReportSpanningSessions(range, sessions, project?.id);
    const trendGranularity = getReportTrendGranularity(period, range);
    const trends = buildReportTrends(trendGranularity, range, sessions, eventsBySession);

    const evidence: ReportEvidence[] = [];
    for (const session of sessions) {
      const snapshot = snapshotsBySession.get(session.id);
      if (snapshot) {
        evidence.push({
          sessionId: session.id,
          sessionTitle: session.title,
          projectName: session.projectName,
          kind: "handoff",
          label: "Handoff snapshot",
          detail: "Closing handoff 已保存為 raw snapshot。",
          reference: snapshot.source_path ?? "captured handoff",
        });
      }
      if (session.verification) {
        evidence.push({
          sessionId: session.id,
          sessionTitle: session.title,
          projectName: session.projectName,
          kind: "verification",
          label: `Verification ${verificationStatusLabel(session.verification.status)}`,
          detail: session.verification.summary ?? "Agent 提供了 verification 狀態。",
        });
      }
      if (session.changedFiles.length) {
        evidence.push({
          sessionId: session.id,
          sessionTitle: session.title,
          projectName: session.projectName,
          kind: "changed-files",
          label: "Changed files metadata",
          detail: `記錄 ${session.changedFiles.length} 個檔案變更；不等同 Git commit。`,
          reference: session.changedFiles.slice(0, 3).join(", "),
        });
      }
      const primaryEvent = (eventsBySession.get(session.id) ?? []).find(
        (event) => event.type === "verification" || event.type === "note" || event.type === "closing",
      );
      if (primaryEvent) {
        evidence.push({
          sessionId: session.id,
          sessionTitle: session.title,
          projectName: session.projectName,
          kind: "event",
          label: `${primaryEvent.type} event`,
          detail: primaryEvent.summary,
          reference: primaryEvent.id,
        });
      }
    }
    for (const item of attachedEvidenceRows) {
      evidence.push({
        sessionId: item.session_id,
        sessionTitle: item.session_title,
        projectName: item.project_name ?? undefined,
        kind: "attached",
        label: `Evidence · ${item.kind}`,
        detail: item.summary ?? item.reference,
        reference: item.reference,
      });
    }

    const filteredEvidence = evidence.filter((item) => {
      if (options.evidenceKind && item.kind !== options.evidenceKind) {
        return false;
      }
      const query = options.evidenceQuery?.trim().toLowerCase();
      if (!query) {
        return true;
      }
      return [item.label, item.detail, item.reference, item.sessionTitle, item.projectName]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(query));
    });
    const evidencePageInfo = createPageInfo(
      options.evidencePage,
      options.evidencePageSize,
      filteredEvidence.length,
      100,
    );
    const pageEvidence = options.includeAllEvidence
      ? filteredEvidence
      : filteredEvidence.slice(
          (evidencePageInfo.page - 1) * evidencePageInfo.pageSize,
          evidencePageInfo.page * evidencePageInfo.pageSize,
        );

    return {
      outcome: "report",
      period,
      range,
      previousRange,
      timezone: localTimeZone(),
      project,
      periodSummary,
      sourceSessionIds: sessionIds,
      sessions,
      sessionTruncation,
      completedWork: sessions.slice(0, 10),
      projects: projectSummaries.sort((left, right) => {
        if (right.sessionCount !== left.sessionCount) {
          return right.sessionCount - left.sessionCount;
        }
        return left.projectName < right.projectName ? -1 : left.projectName > right.projectName ? 1 : 0;
      }),
      totals: {
        sessions: currentMetrics.sessions,
        events: currentMetrics.events,
        changedFiles: currentMetrics.changedFiles,
        changedFilesOversizedSessions: currentMetrics.changedFilesOversizedSessions,
        verification: currentMetrics.verification,
      },
      comparison,
      risks,
      decisions,
      agentAutonomousDecisions,
      trendGranularity,
      trends,
      spanning,
      evidence: pageEvidence,
      evidencePageInfo,
    };
  }

  /**
   * Totals for every finalized, non-voided Session in the period, counted in SQL so they are not capped by the
   * report's Session limit. Sessions listing more than CHANGED_FILES_NORMAL files add nothing to changedFiles and
   * are counted separately, matching how recall and hotspots treat a polluted worktree.
   */
  private getReportPeriodMetrics(range: ReportRange, projectId?: string): ReportPeriodMetrics {
    const scopeClause = projectId ? "AND s.project_id = ?" : "";
    const parameters = [
      localDayStartIso(range.from) ?? range.from,
      nextCalendarDate(range.to),
      ...(projectId ? [projectId] : []),
    ];
    const sessionFilter = `p.status = 'tracked' AND s.voided_at IS NULL
           AND s.completed_at >= ? AND s.completed_at < ? ${scopeClause}`;
    const rows = this.db
      .prepare(
        `SELECT project_id, project_name, COUNT(*) AS sessions,
                SUM(CASE WHEN files <= ${CHANGED_FILES_NORMAL} THEN files ELSE 0 END) AS changed_files,
                SUM(files > ${CHANGED_FILES_NORMAL}) AS oversized,
                SUM(status = 'passed') AS passed, SUM(status = 'failed') AS failed,
                SUM(status = 'in_progress') AS in_progress, SUM(status = 'not_run') AS not_run, SUM(status = 'not_supplied') AS not_supplied
         FROM (
           SELECT s.project_id, p.name AS project_name,
                  json_array_length(CASE WHEN json_valid(s.changed_files_json) THEN s.changed_files_json ELSE '[]' END)
                    AS files,
                  COALESCE(json_extract(s.verification_json, '$.status'), 'not_supplied') AS status
           FROM sessions s
           JOIN projects p ON p.id = s.project_id
           WHERE ${sessionFilter}
         )
         GROUP BY project_id`,
      )
      .all(...parameters) as unknown as ReportProjectMetricsRow[];
    const eventCounts = new Map(
      (
        this.db
          .prepare(
            `SELECT s.project_id, COUNT(*) AS events
             FROM sessions s
             JOIN projects p ON p.id = s.project_id
             JOIN work_events e ON e.session_id = s.id
             WHERE ${sessionFilter}
             GROUP BY s.project_id`,
          )
          .all(...parameters) as Array<{ project_id: string; events: number }>
      ).map((row) => [row.project_id, row.events]),
    );

    const metrics: ReportPeriodMetrics = {
      sessions: 0,
      events: 0,
      changedFiles: 0,
      changedFilesOversizedSessions: 0,
      verification: { passed: 0, failed: 0, in_progress: 0, not_run: 0, not_supplied: 0 },
      projects: [],
    };
    for (const row of rows) {
      const eventCount = eventCounts.get(row.project_id) ?? 0;
      metrics.sessions += row.sessions;
      metrics.events += eventCount;
      metrics.changedFiles += row.changed_files;
      metrics.changedFilesOversizedSessions += row.oversized;
      metrics.verification.passed += row.passed;
      metrics.verification.failed += row.failed;
      metrics.verification.in_progress += row.in_progress;
      metrics.verification.not_run += row.not_run;
      metrics.verification.not_supplied += row.not_supplied;
      metrics.projects.push({
        projectId: row.project_id,
        projectName: row.project_name,
        sessionCount: row.sessions,
        eventCount,
      });
    }
    return metrics;
  }

  private getAgentAutonomousDecisions(range: ReportRange, projectId?: string): WorkReportAgentDecisions {
    const from = localDayStartIso(range.from) ?? range.from;
    const exclusiveEndDate = new Date(`${range.to}T00:00:00.000Z`);
    exclusiveEndDate.setUTCDate(exclusiveEndDate.getUTCDate() + 1);
    const to = localDayStartIso(exclusiveEndDate.toISOString().slice(0, 10)) ?? range.to;
    const scopeClause = projectId ? "AND d.project_id = ?" : "";
    const scopeParams = projectId ? [projectId] : [];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN d.review_status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM session_decisions d
         JOIN sessions s ON s.id = d.session_id
         JOIN projects p ON p.id = d.project_id
         WHERE p.status = 'tracked' AND s.voided_at IS NULL
           AND d.origin = 'agent_autonomous'
           AND s.completed_at >= ? AND s.completed_at < ? ${scopeClause}`,
      )
      .get(from, to, ...scopeParams) as { total: number; pending: number | null };
    const rows = this.db
      .prepare(
        `SELECT d.id, d.session_id, d.project_id, d.position, d.text, d.origin, d.review_status,
                d.reviewed_at, d.knowledge_id, s.title AS session_title,
                s.completed_at AS session_completed_at
         FROM session_decisions d
         JOIN sessions s ON s.id = d.session_id
         JOIN projects p ON p.id = d.project_id
         WHERE p.status = 'tracked' AND s.voided_at IS NULL
           AND d.origin = 'agent_autonomous' AND d.review_status = 'pending'
           AND s.completed_at >= ? AND s.completed_at < ? ${scopeClause}
         ORDER BY s.completed_at DESC, d.session_id DESC, d.position ASC
         LIMIT ${REPORT_PENDING_DECISION_LIMIT}`,
      )
      .all(from, to, ...scopeParams) as Array<{
      id: string;
      session_id: string;
      project_id: string;
      position: number;
      text: string;
      origin: SessionDecisionRecord["origin"];
      review_status: SessionDecisionRecord["reviewStatus"];
      reviewed_at: string | null;
      knowledge_id: string | null;
      session_title: string;
      session_completed_at: string;
    }>;
    return {
      total: totals.total,
      pending: totals.pending ?? 0,
      pendingItems: rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        projectId: row.project_id,
        position: row.position,
        text: row.text,
        origin: row.origin,
        reviewStatus: row.review_status,
        ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
        ...(row.knowledge_id ? { knowledgeId: row.knowledge_id } : {}),
        sessionTitle: row.session_title,
        sessionCompletedAt: row.session_completed_at,
      })),
    };
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
    const report = this.getReport({ ...options, includeAllEvidence: true });
    if (report.outcome !== "report") {
      return report;
    }

    const projectSuffix = report.project ? "-" + this.reportBuilder.filenamePart(report.project.name) : "-all-projects";
    const baseName =
      "work-report-" + report.period + "-" + report.range.from + "-to-" + report.range.to + projectSuffix;
    const contentType = options.format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8";
    const content =
      options.format === "json" ? JSON.stringify(report, null, 2) + "\n" : this.reportBuilder.toMarkdown(report);

    return {
      outcome: "report_export",
      format: options.format,
      filename: baseName + (options.format === "json" ? ".json" : ".md"),
      contentType,
      content,
      report,
    };
  }

  private getReportEvents(sessionIds: string[]): ReportEventRow[] {
    if (!sessionIds.length) {
      return [];
    }

    // CROSS JOIN pins the join order in SQLite: drive from the session-id list instead of letting
    // the planner walk every tracked project's sessions first. Used the same way for the other
    // IN-list report/synthesis queries and the recent-decision lookup.
    return this.db
      .prepare(
        `SELECT e.*, s.project_id
         FROM work_events e
         CROSS JOIN sessions s ON s.id = e.session_id
         CROSS JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked'
           AND e.session_id IN (${sessionIds.map(() => "?").join(", ")})
         ORDER BY e.occurred_at ASC, e.id ASC`,
      )
      .all(...sessionIds) as unknown as ReportEventRow[];
  }
}
