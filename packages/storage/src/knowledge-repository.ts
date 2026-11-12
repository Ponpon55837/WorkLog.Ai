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
  ProjectRecord,
} from "@work-intelligence/core";
import {
  LIST_SEARCH_CHARGE_FUNCTION,
  KNOWLEDGE_SEARCH_ROW_BYTES,
  listSearchOverBoundWarning,
  parseListSearchTerms,
  runListSearchScan,
} from "./list-search-scan.js";
import { createPageInfo } from "./pagination.js";

export interface KnowledgeCount {
  count: number;
  /** Rows above the per-row search cap were skipped, so count may be low. */
  truncated: boolean;
}

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
  applies_to_json?: string | null;
  last_confirmed_at?: string | null;
  last_confirmed_session_id?: string | null;
  supersedes_id?: string | null;
  review_json?: string | null;
};

type KnowledgeMapper = (row: KnowledgeRepositoryRow) => KnowledgeRecord;
type PageInfoBuilder = (
  pageValue: number | undefined,
  pageSizeValue: number | undefined,
  total: number,
  maxPageSize?: number,
) => PageInfo;

interface KnowledgeRepositoryDependencies {
  listTrackedProjects(): ProjectRecord[];
  checkProjectRoot(projectRoot: string): PolicyDecision;
  checkProjectById(projectId: string): PolicyDecision;
}

const SEARCHED_COLUMNS = ["title", "body", "tags_json", "references_json", "applies_to_json"] as const;
/** Stored bytes the term clauses may read, from the record header (octet_length does not load the text). */
const SEARCHED_BYTES = SEARCHED_COLUMNS.map((column) => `COALESCE(octet_length(k.${column}), 0)`).join(" + ");

/** Knowledge query persistence. Mutation and audit flows remain behind the facade for now. */
export class KnowledgeRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly mapKnowledge: KnowledgeMapper,
    private readonly buildPageInfo: PageInfoBuilder = createPageInfo,
    private readonly dependencies: KnowledgeRepositoryDependencies,
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
          reason: decision.reason ?? "Project recording is not enabled.",
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
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      scopedProject = decision.project;
      projectId = decision.project.id;
    }

    const { where, parameters, terms, warnings } = this.whereClause(options, projectId);
    const pageSize = options.pageSize ?? options.limit ?? 50;
    const trackedProjects = this.dependencies.listTrackedProjects();
    const page =
      terms.length > 0
        ? this.searchTextPage(where, parameters, options.page, pageSize)
        : this.searchPage(where, parameters, options.page, pageSize);
    const allWarnings = [...warnings, ...page.warnings];
    const skipped = page.skippedRecords ?? 0;
    return {
      outcome: "knowledge",
      project: scopedProject,
      projects: scopedProject ? [scopedProject] : trackedProjects,
      items: page.rows.map(this.mapKnowledge),
      pageInfo: page.pageInfo,
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
      ...(skipped > 0 ? { searchSkippedRecords: skipped } : {}),
    };
  }

  /**
   * How many Knowledge records the list search would return in a scope the caller already passed through the policy
   * gate (an allowed projectId, or every tracked project), without reading them. A text query spends at most
   * reads at most KNOWLEDGE_SEARCH_ROW_BYTES of each row (see list-search-scan.ts).
   */
  public count(options: KnowledgeQuery & { status: KnowledgeStatus }): KnowledgeCount {
    const { where, parameters, terms } = this.whereClause(options, options.projectId);
    const countWhere = () =>
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM knowledge k
             JOIN projects p ON p.id = k.project_id
             WHERE ${where}`,
          )
          .get(...parameters) as { count: number }
      ).count;
    if (terms.length === 0) return { count: countWhere(), truncated: false };
    const { value, scan } = runListSearchScan(this.db, 1, countWhere, KNOWLEDGE_SEARCH_ROW_BYTES);
    return { count: value, truncated: scan.overBound > 0 };
  }

  private searchPage(
    where: string,
    parameters: Array<string | number>,
    page: number | undefined,
    pageSize: number,
  ): { rows: KnowledgeRepositoryRow[]; pageInfo: PageInfo; warnings: string[]; skippedRecords?: number } {
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM knowledge k
           JOIN projects p ON p.id = k.project_id
           WHERE ${where}`,
        )
        .get(...parameters) as { count: number }
    ).count;
    const pageInfo = this.buildPageInfo(page, pageSize, total, 200);
    const rows = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE ${where}
         ORDER BY k.updated_at DESC, k.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as KnowledgeRepositoryRow[];
    return { rows, pageInfo, warnings: [] };
  }

  /**
   * A text query scans the stored text once: the ordered ids of every match give the total, and the page is cut from
   * them before the full rows are read by primary key in the same order (as the Sessions list does). The page clamps
   * to the total exactly as COUNT plus LIMIT/OFFSET did, and a row above the per-row cap is left out of both.
   */
  private searchTextPage(
    where: string,
    parameters: Array<string | number>,
    page: number | undefined,
    pageSize: number,
  ): { rows: KnowledgeRepositoryRow[]; pageInfo: PageInfo; warnings: string[]; skippedRecords?: number } {
    const { value: ids, scan } = runListSearchScan(
      this.db,
      1,
      () =>
        (
          this.db
            .prepare(
              `SELECT k.id
             FROM knowledge k
             JOIN projects p ON p.id = k.project_id
             WHERE ${where}
             ORDER BY k.updated_at DESC, k.id DESC`,
            )
            .all(...parameters) as Array<{ id: string }>
        ).map((row) => row.id),
      KNOWLEDGE_SEARCH_ROW_BYTES,
    );
    const pageInfo = this.buildPageInfo(page, pageSize, ids.length, 200);
    const pageIds = ids.slice((pageInfo.page - 1) * pageInfo.pageSize, pageInfo.page * pageInfo.pageSize);
    const rows =
      pageIds.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT k.*, p.name AS project_name
               FROM json_each(?) page
               CROSS JOIN knowledge k ON k.id = page.value
               JOIN projects p ON p.id = k.project_id
               ORDER BY page.key`,
            )
            .all(JSON.stringify(pageIds)) as KnowledgeRepositoryRow[]);
    const truncated = listSearchOverBoundWarning(scan);
    return { rows, pageInfo, warnings: truncated ? [truncated] : [], skippedRecords: scan.overBound };
  }

  private whereClause(
    options: KnowledgeQuery,
    projectId: string | undefined,
  ): { where: string; parameters: Array<string | number>; terms: string[]; warnings: string[] } {
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
    // Every term must appear in at least one of the Knowledge's text fields or appliesTo paths, so a file path
    // finds the Knowledge recorded about it. instr(LOWER(x), term) > 0 is LOWER(x) LIKE '%term%' with the wildcards
    // escaped (terms are lower-case, LIKE folds ASCII only), without LIKE's re-match from every stored position. Each
    // CASE charges the row's stored bytes before its word reads them; the structural filters above run first.
    const { terms, warnings } = parseListSearchTerms(options.query?.trim() || options.q?.trim() || "");
    if (terms.length > 0) {
      // Each word is charged when SQLite reaches it, so a row the first word rules out costs one pass, not eight. The
      // test is a CASE WHEN condition, which SQLite evaluates left to right and stops at the answer: the charge runs
      // first and a word found in the title is not searched for in the body. (In a THEN branch, as in 1.6.27, the OR
      // was computed as a value and every column was searched: 2,000 rows at the write limits took 0.74 s, not 0.04.)
      const termClauses = terms.map(
        () =>
          `CASE WHEN ${LIST_SEARCH_CHARGE_FUNCTION}(${SEARCHED_BYTES})
             AND (${SEARCHED_COLUMNS.map((column) => `instr(LOWER(k.${column}), ?) > 0`).join(" OR ")}) THEN 1 ELSE 0 END`,
      );
      clauses.push(`(${termClauses.join(" AND ")})`);
      for (const term of terms) parameters.push(...SEARCHED_COLUMNS.map(() => term));
    }
    return { where: clauses.join(" AND "), parameters, terms, warnings };
  }
}
