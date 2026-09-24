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
  SessionListResult,
  WorkReportPeriod,
  WorkSessionRecord,
} from "@work-intelligence/core";
import { localDayStartIso, localTimeZone, toLocalCalendarDate } from "@work-intelligence/shared";
import { createPageInfo } from "./pagination.js";
import { ReportBuilder } from "./report-builder.js";
import type { SessionListOptions } from "./session-repository.js";
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
  listSessionsPage(options: SessionListOptions): SessionListResult;
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

const REPORT_SESSION_LIMIT = 200;

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
    const previousRange = customRange ? getPreviousCustomRange(range) : getPreviousReportRange(options.period, range);
    const currentSessionScope: SessionListOptions = {
      from: range.from,
      to: range.to,
      projectId: project?.id,
      trackedOnly: true,
    };
    const previousSessionScope: SessionListOptions = {
      from: previousRange.from,
      to: previousRange.to,
      projectId: project?.id,
      trackedOnly: true,
    };
    const sessions = this.listSessions({ ...currentSessionScope, limit: REPORT_SESSION_LIMIT });
    const previousSessions = this.listSessions({ ...previousSessionScope, limit: REPORT_SESSION_LIMIT });
    const sessionTruncation = {
      currentPeriod:
        this.store.listSessionsPage({ ...currentSessionScope, page: 1, pageSize: 1 }).pageInfo.total >
        REPORT_SESSION_LIMIT,
      previousPeriod:
        this.store.listSessionsPage({ ...previousSessionScope, page: 1, pageSize: 1 }).pageInfo.total >
        REPORT_SESSION_LIMIT,
    };
    const sessionIds = sessions.map((session) => session.id);
    const previousSessionIds = previousSessions.map((session) => session.id);
    const eventRows = this.getReportEvents(sessionIds);
    const previousEventRows = this.getReportEvents(previousSessionIds);
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

    const verification: Record<"passed" | "failed" | "not_run" | "not_supplied", number> = {
      passed: 0,
      failed: 0,
      not_run: 0,
      not_supplied: 0,
    };
    const projectSummaries = new Map<string, ReportProjectSummary>();
    for (const session of sessions) {
      const verificationStatus = session.verification?.status ?? "not_supplied";
      verification[verificationStatus] += 1;
      const existing = projectSummaries.get(session.projectId);
      if (existing) {
        existing.sessionCount += 1;
        existing.sourceSessionIds.push(session.id);
      } else {
        projectSummaries.set(session.projectId, {
          projectId: session.projectId,
          projectName: session.projectName ?? session.projectId,
          sessionCount: 1,
          eventCount: 0,
          sourceSessionIds: [session.id],
        });
      }
    }
    for (const event of eventRows) {
      const summary = projectSummaries.get(event.project_id);
      if (summary) {
        summary.eventCount += 1;
      }
    }

    const currentMetrics = {
      sessions: sessions.length,
      events: eventRows.length,
      changedFiles: sessions.reduce((total, session) => total + session.changedFiles.length, 0),
    };
    const previousMetrics = {
      sessions: previousSessions.length,
      events: previousEventRows.length,
      changedFiles: previousSessions.reduce((total, session) => total + session.changedFiles.length, 0),
    };
    const comparison = {
      sessions: compareReportMetric(currentMetrics.sessions, previousMetrics.sessions),
      events: compareReportMetric(currentMetrics.events, previousMetrics.events),
      changedFiles: compareReportMetric(currentMetrics.changedFiles, previousMetrics.changedFiles),
    };
    const periodScope = project ? `專案「${project.name}」` : `${projectSummaries.size} 個記錄中專案`;
    const periodSummary = sessions.length
      ? `${range.from} 至 ${range.to}，${periodScope}完成 ${sessions.length} 個 Session，留下 ${eventRows.length} 個事件與 ${currentMetrics.changedFiles} 筆檔案變更 metadata。`
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
    const notSuppliedSessions = sessions.filter((session) => !session.verification);
    if (notSuppliedSessions.length) {
      risks.push({
        kind: "verification",
        label: "Verification 尚未回報",
        detail: `${notSuppliedSessions.length} 個 Session 沒有結構化 verification；不能只根據文件內容推測結果。`,
        sourceSessionIds: notSuppliedSessions.map((session) => session.id),
      });
    }
    const notRunSessions = sessions.filter((session) => session.verification?.status === "not_run");
    if (notRunSessions.length) {
      risks.push({
        kind: "verification",
        label: "Verification 明確標示未執行",
        detail: `${notRunSessions.length} 個 Session 由 Agent 明確回報 verification 尚未執行；Agent 應再確認是否能補回 passed 或 failed。`,
        sourceSessionIds: notRunSessions.map((session) => session.id),
      });
    }
    const failedSessions = sessions.filter((session) => session.verification?.status === "failed");
    if (failedSessions.length) {
      risks.push({
        kind: "verification",
        label: "Verification 失敗",
        detail: `${failedSessions.length} 個 Session 回報 failed，請回到來源工作檢查驗證事件。`,
        sourceSessionIds: failedSessions.map((session) => session.id),
      });
    }
    const missingHandoffSessions = sessions.filter((session) => !snapshotsBySession.has(session.id));
    if (missingHandoffSessions.length) {
      risks.push({
        kind: "metadata",
        label: "Handoff snapshot 未保存",
        detail: `${missingHandoffSessions.length} 個 Session 沒有可追溯的 raw handoff snapshot。`,
        sourceSessionIds: missingHandoffSessions.map((session) => session.id),
      });
    }
    const missingChangedFilesSessions = sessions.filter((session) => session.changedFiles.length === 0);
    if (missingChangedFilesSessions.length) {
      risks.push({
        kind: "metadata",
        label: "變更檔案 metadata 未提供",
        detail: `${missingChangedFilesSessions.length} 個 Session 沒有 changed files metadata；請由 Agent 檢查工作樹後補回，這不代表工作沒有完成。`,
        sourceSessionIds: missingChangedFilesSessions.map((session) => session.id),
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
      completedWork: sessions.slice(0, 6),
      projects: [...projectSummaries.values()].sort((left, right) => {
        if (right.sessionCount !== left.sessionCount) {
          return right.sessionCount - left.sessionCount;
        }
        return left.projectName < right.projectName ? -1 : left.projectName > right.projectName ? 1 : 0;
      }),
      totals: {
        sessions: currentMetrics.sessions,
        events: eventRows.length,
        changedFiles: currentMetrics.changedFiles,
        verification,
      },
      comparison,
      risks,
      decisions,
      trendGranularity,
      trends,
      spanning,
      evidence: pageEvidence,
      evidencePageInfo,
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
