import type { DatabaseSync } from "node:sqlite";
import type {
  ContextQueryResult,
  ContextResult,
  DecisionDigest,
  KnowledgeCandidateRequest,
  KnowledgeDigest,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeRecord,
  KnowledgeSkippedResult,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequestListQueryResult,
  MetadataBackfillRequestQuery,
  PolicyDecision,
  ProjectRecord,
  RecallHit,
  RecallQueryResult,
  RelevantContext,
  ReportSynthesisRequestListQueryResult,
  ReportSynthesisRequestQuery,
  SearchResult,
  SessionLinkRecord,
  SkippedResult,
  WorkSessionRecord,
} from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";
import { DIGEST_ITEM_LENGTH, toKnowledgeDigest, toSessionDigest } from "./digest.js";
import type { SessionListOptions } from "./session-repository.js";
import type { SearchRepository } from "./search-repository.js";

const RECENT_DECISION_LIMIT = 12;
const RELEVANT_LIMIT = 5;
const RECALL_DEFAULT_LIMIT = 8;
const RECALL_MAX_LIMIT = 30;
const SEARCH_LIMIT = 20;

/** What an Agent is about to work on; ranks relevant records into the context result. */
export type ContextFocus = { task?: string; paths?: string[] };

interface ContextRecallStoreReader {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  listProjects(): ProjectRecord[];
  listSessions(options: SessionListOptions): WorkSessionRecord[];
  getSessionById(sessionId: string): WorkSessionRecord | undefined;
  getProjectById(projectId: string): ProjectRecord | undefined;
  getSessionLinks(sessionId: string): SessionLinkRecord[];
  getKnowledgeWithTrust(knowledgeId: string): KnowledgeRecord | undefined;
  searchKnowledge(options: KnowledgeQuery): KnowledgeQueryResult | KnowledgeSkippedResult;
  listReportSynthesisRequests(options: ReportSynthesisRequestQuery): ReportSynthesisRequestListQueryResult;
  listMetadataBackfillRequests(options: MetadataBackfillRequestQuery): MetadataBackfillRequestListQueryResult;
  previewMetadataBackfill(options: { projectRoot?: string; limit?: number }): MetadataBackfillPreviewResult;
  openKnowledgeCandidateRequests(projectId?: string): KnowledgeCandidateRequest[];
}

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

export class ContextRecallService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly searchIndex: SearchRepository,
    private readonly store: ContextRecallStoreReader,
  ) {}

  public getContext(projectRoot?: string, focus: ContextFocus = {}): ContextQueryResult {
    if (projectRoot) {
      const decision = this.store.checkProjectRoot(projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }

      return this.buildContext(decision.project, focus);
    }

    const projects = this.store.listProjects().filter((project) => project.status === "tracked");
    const relevant = this.getRelevantContext(focus);
    return {
      outcome: "context",
      projects,
      recentSessions: this.store.listSessions({ limit: 12, trackedOnly: true }).map(toSessionDigest),
      recentDecisions: this.getRecentDecisions(),
      recentKnowledge: this.getRecentKnowledge(),
      metadataFollowUps: this.getMetadataFollowUps(),
      pendingRequests: this.getPendingRequests(),
      ...(relevant ? { relevant } : {}),
    };
  }

  /**
   * Ranked retrieval across Sessions (including raw handoff sections) and active Knowledge of tracked
   * projects. Returns compact hits; read full records with getSessionDetailForAgent or searchKnowledge.
   */
  public recall(input: { q?: string; paths?: string[]; projectRoot?: string; limit?: number }): RecallQueryResult {
    let project: ProjectRecord | undefined;
    if (input.projectRoot) {
      const decision = this.store.checkProjectRoot(input.projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      project = decision.project;
    }
    const result = this.searchIndex.recall({
      q: input.q,
      paths: input.paths,
      projectId: project?.id,
      limit: Math.min(Math.max(input.limit ?? RECALL_DEFAULT_LIMIT, 1), RECALL_MAX_LIMIT),
    });
    return {
      outcome: "recall",
      ...(project ? { project } : {}),
      ...result,
      hits: result.hits.map((hit) => this.withRelatedSessions(hit)),
    };
  }

  private withRelatedSessions(hit: RecallHit): RecallHit {
    if (hit.type === "knowledge") {
      const knowledge = this.store.getKnowledgeWithTrust(hit.id);
      return {
        ...hit,
        ...(knowledge?.possiblyStale ? { possiblyStale: true } : {}),
        ...(knowledge?.review ? { needsReview: true } : {}),
      };
    }
    const related = this.store
      .getSessionLinks(hit.id)
      .filter((link) => !link.voided)
      .map((link) => ({ id: link.sessionId, title: link.title, relation: link.relation }));
    return related.length > 0 ? { ...hit, related } : hit;
  }

  public search(query: string, projectRoot?: string): SearchResult[] | SkippedResult {
    let projectId: string | undefined;
    if (projectRoot) {
      const decision = this.store.checkProjectRoot(projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      projectId = decision.project.id;
    }

    const { hits } = this.searchIndex.recall({ q: query, projectId, types: ["session"], limit: SEARCH_LIMIT });
    return hits.flatMap((hit) => {
      const record = this.store.getSessionById(hit.id);
      if (!record) {
        return [];
      }
      return [
        {
          session: toSessionDigest(record),
          matchedIn: hit.matchedIn[0] ?? "title",
          ...(hit.section ? { section: hit.section } : {}),
          excerpt: hit.excerpt,
        },
      ];
    });
  }

  private buildContext(project: ProjectRecord, focus: ContextFocus): ContextResult {
    const relevant = this.getRelevantContext(focus, project.id);
    return {
      outcome: "context",
      project,
      projects: [project],
      recentSessions: this.store
        .listSessions({ projectId: project.id, limit: 12, trackedOnly: true })
        .map(toSessionDigest),
      recentDecisions: this.getRecentDecisions(project.id),
      recentKnowledge: this.getRecentKnowledge(project.id),
      metadataFollowUps: this.getMetadataFollowUps(project.id),
      pendingRequests: this.getPendingRequests(project.id),
      ...(relevant ? { relevant } : {}),
    };
  }

  /** Records ranked for the task and paths an Agent is about to work on; undefined without a focus. */
  private getRelevantContext(focus: ContextFocus, projectId?: string): RelevantContext | undefined {
    const task = focus.task?.trim();
    const paths = (focus.paths ?? []).map((path) => path.trim()).filter(Boolean);
    if (!task && paths.length === 0) {
      return undefined;
    }
    const recalled = this.searchIndex.recall({ q: task, paths, projectId, limit: 20 });
    const termHits = recalled.termHits;
    const hits = recalled.hits.map((hit) => this.withRelatedSessions(hit));
    const knowledge = hits.filter((hit) => hit.type === "knowledge").slice(0, RELEVANT_LIMIT);
    const sessions = hits
      .filter((hit) => hit.type === "session")
      .slice(0, RELEVANT_LIMIT)
      .flatMap((hit) => {
        const record = this.store.getSessionById(hit.id);
        return record ? [{ hit, record }] : [];
      });
    const decisions = sessions
      .flatMap(({ record }) =>
        (record.workSummary?.decisions ?? [])
          .filter((text) => text.trim().length > 0)
          .map((text) => ({
            sessionId: record.id,
            sessionTitle: record.title,
            completedAt: record.completedAt,
            text: truncateText(text, DIGEST_ITEM_LENGTH),
          })),
      )
      .slice(0, RECENT_DECISION_LIMIT);
    return {
      ...(task ? { task } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      knowledge,
      decisions,
      sessions: sessions.map(({ hit, record }) => ({ ...hit, openItems: toSessionDigest(record).openItems })),
      ...(termHits ? { termHits } : {}),
    };
  }

  /** Pending/processing requests an Agent could pick up; a project scope also includes its "all projects" requests. */
  private getPendingRequests(projectId?: string): ContextResult["pendingRequests"] {
    const active = new Set(["pending", "processing"]);
    const inScope = (request: { projectId?: string }) =>
      !projectId || !request.projectId || request.projectId === projectId;
    const byNewest = (left: { requestedAt: string }, right: { requestedAt: string }) =>
      right.requestedAt.localeCompare(left.requestedAt);
    const reports = this.store.listReportSynthesisRequests({ limit: 100 });
    const backfills = this.store.listMetadataBackfillRequests({ limit: 100 });
    return {
      reportSynthesis:
        reports.outcome === "report_synthesis_requests"
          ? reports.requests
              .filter((request) => active.has(request.status) && inScope(request))
              .sort(byNewest)
              .slice(0, 5)
          : [],
      metadataBackfill:
        backfills.outcome === "metadata_backfill_requests"
          ? backfills.requests
              .filter((request) => active.has(request.status) && inScope(request))
              .sort(byNewest)
              .slice(0, 5)
          : [],
      knowledgeCandidates: this.store.openKnowledgeCandidateRequests(projectId),
    };
  }

  private getMetadataFollowUps(projectId?: string): ContextResult["metadataFollowUps"] {
    const projectRoot = projectId ? this.store.getProjectById(projectId)?.rootPath : undefined;
    const preview = this.store.previewMetadataBackfill({ projectRoot, limit: 1 });
    return preview.outcome === "backfill_preview"
      ? preview.totals
      : { needsBackfill: 0, changedFilesMissing: 0, verificationMissing: 0, verificationNotRun: 0 };
  }

  private getRecentKnowledge(projectId?: string): KnowledgeDigest[] {
    const result = this.store.searchKnowledge({ projectId, status: "active", limit: 12 });
    return result.outcome === "knowledge" ? result.items.map(toKnowledgeDigest) : [];
  }

  /*
   * Decisions come from workSummary.decisions, the confirmed technical decisions an Agent wrote at
   * finalize. note/closing events are not used: they mostly record process state (commits,
   * worktree status), not decisions.
   */
  private getRecentDecisions(projectId?: string): DecisionDigest[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.completed_at, json_extract(s.work_summary_json, '$.decisions') AS decisions_json
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked'
           AND s.voided_at IS NULL
           ${projectId ? "AND p.id = ?" : ""}
           AND json_valid(s.work_summary_json)
           AND json_type(s.work_summary_json, '$.decisions') = 'array'
           AND json_array_length(s.work_summary_json, '$.decisions') > 0
         ORDER BY s.completed_at DESC, s.id DESC
         LIMIT ${RECENT_DECISION_LIMIT}`,
      )
      .all(...(projectId ? [projectId] : [])) as Array<{
      id: string;
      title: string;
      completed_at: string;
      decisions_json: string;
    }>;
    return rows
      .flatMap((row) =>
        parseJson<unknown[]>(row.decisions_json, [])
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((text) => ({
            sessionId: row.id,
            sessionTitle: row.title,
            completedAt: row.completed_at,
            text: truncateText(text, DIGEST_ITEM_LENGTH),
          })),
      )
      .slice(0, RECENT_DECISION_LIMIT);
  }
}
