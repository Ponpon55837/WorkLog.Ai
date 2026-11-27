import { DatabaseSync } from "node:sqlite";
import type {
  CompactKnowledgeItem,
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

type CompactKnowledgeRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  title: string;
  updated_at: string;
  applies_to_count: number;
  needs_review: number;
};

type KnowledgeMapper = (row: KnowledgeRepositoryRow) => KnowledgeRecord;
type KnowledgePage<Row> = { rows: Row[]; pageInfo: PageInfo; warnings: string[]; skippedRecords?: number };
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
/** octet_length reads the record header, so the text is measured without being loaded. */
const SEARCHED_BYTES = SEARCHED_COLUMNS.map((column) => `COALESCE(octet_length(k.${column}), 0)`).join(" + ");

const RECORD_COLUMNS = "k.*, p.name AS project_name";
const COMPACT_COLUMNS = `k.id, k.project_id, p.name AS project_name, k.kind, k.status, k.title, k.updated_at,
  CASE WHEN json_valid(k.applies_to_json) THEN json_array_length(k.applies_to_json) ELSE 0 END AS applies_to_count,
  COALESCE(k.review_json, '') <> '' AS needs_review`;

function toCompactKnowledgeItem(row: CompactKnowledgeRow): CompactKnowledgeItem {
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.project_name ? { projectName: row.project_name } : {}),
    kind: row.kind,
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
    ...(row.applies_to_count > 0 ? { appliesToCount: row.applies_to_count } : {}),
    ...(row.needs_review ? { needsReview: true as const } : {}),
  };
}

export class KnowledgeRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly mapKnowledge: KnowledgeMapper,
    private readonly buildPageInfo: PageInfoBuilder = createPageInfo,
    private readonly dependencies: KnowledgeRepositoryDependencies,
  ) {}

  public search(options: KnowledgeQuery = {}): KnowledgeQueryResult | KnowledgeSkippedResult {
    return this.searchRows(options, RECORD_COLUMNS, this.mapKnowledge);
  }

  public searchCompact(
    options: KnowledgeQuery = {},
  ): KnowledgeQueryResult<CompactKnowledgeItem> | KnowledgeSkippedResult {
    return this.searchRows(options, COMPACT_COLUMNS, toCompactKnowledgeItem);
  }

  private searchRows<Row, Item>(
    options: KnowledgeQuery,
    columns: string,
    map: (row: Row) => Item,
  ): KnowledgeQueryResult<Item> | KnowledgeSkippedResult {
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
        ? this.searchTextPage<Row>(columns, where, parameters, options.page, pageSize)
        : this.searchPage<Row>(columns, where, parameters, options.page, pageSize);
    const allWarnings = [...warnings, ...page.warnings];
    const skipped = page.skippedRecords ?? 0;
    return {
      outcome: "knowledge",
      project: scopedProject,
      projects: scopedProject ? [scopedProject] : trackedProjects,
      items: page.rows.map(map),
      pageInfo: page.pageInfo,
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
      ...(skipped > 0 ? { searchSkippedRecords: skipped } : {}),
    };
  }

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

  private searchPage<Row>(
    columns: string,
    where: string,
    parameters: Array<string | number>,
    page: number | undefined,
    pageSize: number,
  ): KnowledgePage<Row> {
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
        `SELECT ${columns}
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE ${where}
         ORDER BY k.updated_at DESC, k.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as Row[];
    return { rows, pageInfo, warnings: [] };
  }

  private searchTextPage<Row>(
    columns: string,
    where: string,
    parameters: Array<string | number>,
    page: number | undefined,
    pageSize: number,
  ): KnowledgePage<Row> {
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
              `SELECT ${columns}
               FROM json_each(?) page
               CROSS JOIN knowledge k ON k.id = page.value
               JOIN projects p ON p.id = k.project_id
               ORDER BY page.key`,
            )
            .all(JSON.stringify(pageIds)) as Row[]);
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
    if (options.convention) {
      clauses.push("k.convention_confirmed_at IS NOT NULL AND k.convention_confirmed_at <> ''");
    }
    const status = options.status ?? "active";
    if (status) {
      clauses.push("k.status = ?");
      parameters.push(status);
    }
    // instr(LOWER(x), term) > 0 is LIKE '%term%' with wildcards escaped (LIKE folds ASCII only), without LIKE's
    // re-match from every stored position.
    const { terms, warnings } = parseListSearchTerms(options.query?.trim() || options.q?.trim() || "");
    if (terms.length > 0) {
      // The charge sits in a CASE WHEN condition, which SQLite evaluates left to right and short-circuits; in a THEN
      // branch the OR was computed as a value and every column was searched.
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
