import { DatabaseSync } from "node:sqlite";
import type {
  KnowledgeKind,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeRecord,
  KnowledgeSkippedResult,
  KnowledgeStatus,
  PageInfo,
  PolicyDecision,
  ProjectRecord
} from "@work-intelligence/core";
import { LIKE_ESCAPE, likeContainsPattern } from "./sql-like.js";
import { createPageInfo } from "./pagination.js";

type KnowledgeRepositoryRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  session_id: string | null;
  idempotency_key: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags_json: string;
  references_json: string;
  status: KnowledgeStatus;
  created_at: string;
  updated_at: string;
};

type KnowledgeMapper = (row: KnowledgeRepositoryRow) => KnowledgeRecord;
type PageInfoBuilder = (
  pageValue: number | undefined,
  pageSizeValue: number | undefined,
  total: number,
  maxPageSize?: number
) => PageInfo;

interface KnowledgeRepositoryDependencies {
  listTrackedProjects(): ProjectRecord[];
  checkProjectRoot(projectRoot: string): PolicyDecision;
  checkProjectById(projectId: string): PolicyDecision;
}

/** Knowledge query persistence. Mutation and audit flows remain behind the facade for now. */
export class KnowledgeRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly mapKnowledge: KnowledgeMapper,
    private readonly buildPageInfo: PageInfoBuilder = createPageInfo,
    private readonly dependencies: KnowledgeRepositoryDependencies
  ) {}

  public search(options: KnowledgeQuery = {}): KnowledgeQueryResult | KnowledgeSkippedResult {
    let scopedProject: ProjectRecord | undefined;
    let projectId = options.projectId;

    if (options.projectRoot) {
      const decision = this.dependencies.checkProjectRoot(options.projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled."
        };
      }
      scopedProject = decision.project;
      projectId = decision.project.id;
    }

    if (projectId) {
      const decision = this.dependencies.checkProjectById(projectId);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled."
        };
      }
      scopedProject = decision.project;
      projectId = decision.project.id;
    }

    const clauses = ["p.status = 'tracked'"];
    const parameters: Array<string | number> = [];
    if (projectId) {
      clauses.push("k.project_id = ?");
      parameters.push(projectId);
    }
    if (options.kind) {
      clauses.push("k.kind = ?");
      parameters.push(options.kind);
    }
    const status = options.status ?? "active";
    if (status) {
      clauses.push("k.status = ?");
      parameters.push(status);
    }
    const queryText = options.query?.trim() || options.q?.trim();
    if (queryText) {
      clauses.push(
        `(LOWER(k.title) LIKE ? ${LIKE_ESCAPE} OR LOWER(k.body) LIKE ? ${LIKE_ESCAPE} OR LOWER(k.tags_json) LIKE ? ${LIKE_ESCAPE} OR LOWER(k.references_json) LIKE ? ${LIKE_ESCAPE})`
      );
      const needle = likeContainsPattern(queryText.toLowerCase());
      parameters.push(needle, needle, needle, needle);
    }

    const pageSize = options.pageSize ?? options.limit ?? 50;
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE ${clauses.join(" AND ")}`
      )
      .get(...parameters) as { count: number };
    const pageInfo = this.buildPageInfo(options.page, pageSize, totalRow.count, 200);
    const rows = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY k.updated_at DESC, k.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...parameters, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as KnowledgeRepositoryRow[];
    const trackedProjects = this.dependencies.listTrackedProjects();
    return {
      outcome: "knowledge",
      project: scopedProject,
      projects: scopedProject ? [scopedProject] : trackedProjects,
      items: rows.map(this.mapKnowledge),
      pageInfo
    };
  }
}
