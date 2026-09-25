import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  PROJECT_DATA_TABLES,
  type ProjectDataCounts,
  type ProjectDataExport,
  type ProjectDataImportConflict,
  type ProjectDataImportInput,
  type ProjectDataImportPreview,
  type ProjectDataImportResult,
  type ProjectDataRow,
  type ProjectDataTable,
  type ProjectDataValue,
  type ProjectPathRemap,
  type ProjectDataExportScope,
} from "@work-intelligence/core";
import {
  projectDataExportSchema,
  projectDataImportInputSchema,
  projectDataExportTableColumns,
} from "@work-intelligence/schema";
import { nowIso } from "@work-intelligence/shared";
import { remapPathPrefix } from "./project-path-remap.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";
import { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";

const TABLE_ORDER: readonly ProjectDataTable[] = [
  "projects",
  "sessions",
  "work_events",
  "raw_snapshots",
  "evidence",
  "void_audit",
  "session_verification_updates",
  "session_links",
  "knowledge",
  "knowledge_audit",
  "knowledge_candidate_requests",
  "knowledge_candidates",
  "report_synthesis_requests",
  "report_summaries",
  "metadata_backfill_requests",
  "session_summary_updates",
  "session_work_summary_updates",
];

const UNIQUE_FIELDS: Partial<Record<ProjectDataTable, readonly (readonly string[])[]>> = {
  sessions: [["idempotency_key"]],
  evidence: [["session_id", "kind", "reference"]],
  knowledge: [["project_id", "idempotency_key"]],
  report_synthesis_requests: [["idempotency_key"]],
  metadata_backfill_requests: [["idempotency_key"]],
  session_summary_updates: [["idempotency_key"]],
  session_work_summary_updates: [["idempotency_key"]],
  session_links: [["session_id", "related_session_id"]],
};

const CONFLICT_DETAIL_LIMIT = 100;
const MAX_CONFLICT_ID_LENGTH = 200;

export type ProjectDataTransferErrorCode =
  "invalid_input" | "invalid_bundle" | "unsupported_schema" | "project_not_found";

export class ProjectDataTransferError extends Error {
  public constructor(
    public readonly code: ProjectDataTransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectDataTransferError";
  }
}

interface PlannedRow {
  row: ProjectDataRow;
  disposition: "add" | "skip" | "conflict";
  reason?: string;
}

type InsertStatement = ReturnType<DatabaseSync["prepare"]>;

interface TransferPlan {
  rows: Record<ProjectDataTable, PlannedRow[]>;
  projectIds: Map<string, string>;
  selectedProjects: Array<{ id: string; name: string }>;
  remappedPaths: ProjectDataImportPreview["remappedPaths"];
  conflicts: ProjectDataImportConflict[];
  conflictDetailsTruncated: boolean;
}

function emptyCounts(): Record<ProjectDataTable, number> {
  return Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, 0])) as Record<ProjectDataTable, number>;
}

function emptyRows(): Record<ProjectDataTable, PlannedRow[]> {
  return Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, []])) as unknown as Record<
    ProjectDataTable,
    PlannedRow[]
  >;
}

function sqlRows(
  db: DatabaseSync,
  table: ProjectDataTable,
  where = "",
  values: ProjectDataValue[] = [],
): ProjectDataRow[] {
  const columns = projectDataExportTableColumns[table].join(", ");
  const sql = `SELECT ${columns} FROM ${table}${where ? ` WHERE ${where}` : ""} ORDER BY id`;
  return db.prepare(sql).all(...values) as unknown as ProjectDataRow[];
}

function rowsByIds(
  db: DatabaseSync,
  table: ProjectDataTable,
  column: string,
  ids: readonly string[],
): ProjectDataRow[] {
  if (ids.length === 0) {
    return [];
  }
  const results: ProjectDataRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const placeholders = batch.map(() => "?").join(", ");
    results.push(...sqlRows(db, table, `${column} IN (${placeholders})`, [...batch]));
  }
  return results.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function getRows(db: DatabaseSync, table: ProjectDataTable): Set<string> {
  const ids = db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>;
  return new Set(ids.map((row) => row.id));
}

function selectExportRows(db: DatabaseSync, scope: ProjectDataExportScope): Record<ProjectDataTable, ProjectDataRow[]> {
  const projects =
    scope.type === "all" ? sqlRows(db, "projects") : sqlRows(db, "projects", "id = ?", [scope.projectId]);
  const projectIds = projects.map((project) => String(project.id));
  const sessions = rowsByIds(db, "sessions", "project_id", projectIds);
  const sessionIds = sessions.map((session) => String(session.id));
  const sessionIdSet = new Set(sessionIds);
  const reportRequests =
    scope.type === "all"
      ? sqlRows(db, "report_synthesis_requests")
      : sqlRows(db, "report_synthesis_requests", "scope_type = 'project' AND project_id = ?", [scope.projectId]);
  const reportRequestIds = reportRequests.map((request) => String(request.id));
  const candidateRequests = rowsByIds(db, "knowledge_candidate_requests", "project_id", projectIds);
  const candidateRequestIds = candidateRequests.map((request) => String(request.id));
  const rows: Record<ProjectDataTable, ProjectDataRow[]> = {
    projects,
    sessions,
    work_events: rowsByIds(db, "work_events", "session_id", sessionIds),
    raw_snapshots: rowsByIds(db, "raw_snapshots", "project_id", projectIds),
    evidence: rowsByIds(db, "evidence", "project_id", projectIds),
    void_audit: rowsByIds(db, "void_audit", "project_id", projectIds),
    session_verification_updates: rowsByIds(db, "session_verification_updates", "session_id", sessionIds),
    session_links: sqlRows(db, "session_links").filter(
      (link) => sessionIdSet.has(String(link.session_id)) && sessionIdSet.has(String(link.related_session_id)),
    ),
    knowledge: rowsByIds(db, "knowledge", "project_id", projectIds),
    knowledge_audit: rowsByIds(db, "knowledge_audit", "project_id", projectIds),
    knowledge_candidate_requests: candidateRequests,
    knowledge_candidates: rowsByIds(db, "knowledge_candidates", "project_id", projectIds),
    report_synthesis_requests: reportRequests,
    report_summaries:
      scope.type === "all"
        ? sqlRows(db, "report_summaries")
        : rowsByIds(db, "report_summaries", "request_id", reportRequestIds),
    metadata_backfill_requests:
      scope.type === "all"
        ? sqlRows(db, "metadata_backfill_requests")
        : sqlRows(db, "metadata_backfill_requests", "scope_type = 'project' AND project_id = ?", [scope.projectId]),
    session_summary_updates: rowsByIds(db, "session_summary_updates", "session_id", sessionIds),
    session_work_summary_updates: rowsByIds(db, "session_work_summary_updates", "session_id", sessionIds),
  };

  if (scope.type === "all") {
    rows.knowledge_candidates = sqlRows(db, "knowledge_candidates");
    rows.report_summaries = sqlRows(db, "report_summaries");
  }
  if (candidateRequestIds.length > 0) {
    const candidateIds = new Set(candidateRequestIds);
    rows.knowledge_candidates = rows.knowledge_candidates.filter((candidate) =>
      candidateIds.has(String(candidate.request_id)),
    );
  }
  return rows;
}

function bundleForScope(bundle: ProjectDataExport, projectId?: string): ProjectDataExport {
  const selectedIds = new Set(
    (projectId ? [projectId] : bundle.tables.projects.map((project) => String(project.id))).filter(
      (id) => id.length > 0,
    ),
  );
  if (selectedIds.size === 0) {
    throw new ProjectDataTransferError("invalid_bundle", "匯入檔中沒有可匯入的專案。");
  }
  if (bundle.scope.type === "project" && !selectedIds.has(bundle.scope.projectId)) {
    throw new ProjectDataTransferError("invalid_bundle", "所選專案不在這份單一專案匯出檔中。");
  }
  const selectedProjects = bundle.tables.projects.filter((project) => selectedIds.has(String(project.id)));
  if (selectedProjects.length !== selectedIds.size) {
    throw new ProjectDataTransferError("invalid_bundle", "所選專案不在匯入檔中。");
  }

  const sessions = bundle.tables.sessions.filter((session) => selectedIds.has(String(session.project_id)));
  const sessionIds = new Set(sessions.map((session) => String(session.id)));
  const knowledge = bundle.tables.knowledge.filter((item) => selectedIds.has(String(item.project_id)));
  const candidateRequests = bundle.tables.knowledge_candidate_requests.filter((item) =>
    selectedIds.has(String(item.project_id)),
  );
  const reportRequests = bundle.tables.report_synthesis_requests.filter(
    (item) => item.scope_type === "all" || (item.scope_type === "project" && selectedIds.has(String(item.project_id))),
  );
  const reportRequestIds = new Set(reportRequests.map((item) => String(item.id)));
  const metadataRequests = bundle.tables.metadata_backfill_requests.filter(
    (item) => item.scope_type === "all" || (item.scope_type === "project" && selectedIds.has(String(item.project_id))),
  );

  if (projectId) {
    for (const row of reportRequests) {
      if (row.scope_type === "all") {
        reportRequestIds.delete(String(row.id));
      }
    }
  }
  const filterSessionChildrenByScope = bundle.scope.type === "all" && projectId !== undefined;
  const tables: Record<ProjectDataTable, ProjectDataRow[]> = {
    projects: selectedProjects,
    sessions,
    work_events: filterSessionChildrenByScope
      ? bundle.tables.work_events.filter((row) => sessionIds.has(String(row.session_id)))
      : bundle.tables.work_events,
    raw_snapshots: bundle.tables.raw_snapshots.filter((row) => selectedIds.has(String(row.project_id))),
    evidence: bundle.tables.evidence.filter((row) => selectedIds.has(String(row.project_id))),
    void_audit: bundle.tables.void_audit.filter((row) => selectedIds.has(String(row.project_id))),
    session_verification_updates: filterSessionChildrenByScope
      ? bundle.tables.session_verification_updates.filter((row) => sessionIds.has(String(row.session_id)))
      : bundle.tables.session_verification_updates,
    session_links:
      bundle.scope.type === "all" && projectId !== undefined
        ? bundle.tables.session_links.filter(
            (row) => sessionIds.has(String(row.session_id)) && sessionIds.has(String(row.related_session_id)),
          )
        : bundle.tables.session_links.filter((row) => sessionIds.has(String(row.session_id))),
    knowledge,
    knowledge_audit: bundle.tables.knowledge_audit.filter((row) => selectedIds.has(String(row.project_id))),
    knowledge_candidate_requests: candidateRequests,
    knowledge_candidates: bundle.tables.knowledge_candidates.filter((row) => selectedIds.has(String(row.project_id))),
    report_synthesis_requests: reportRequests.filter((row) => projectId === undefined || row.scope_type === "project"),
    report_summaries:
      projectId === undefined
        ? bundle.tables.report_summaries
        : bundle.tables.report_summaries.filter((row) => reportRequestIds.has(String(row.request_id))),
    metadata_backfill_requests: metadataRequests.filter(
      (row) => projectId === undefined || row.scope_type === "project",
    ),
    session_summary_updates: filterSessionChildrenByScope
      ? bundle.tables.session_summary_updates.filter((row) => sessionIds.has(String(row.session_id)))
      : bundle.tables.session_summary_updates,
    session_work_summary_updates: filterSessionChildrenByScope
      ? bundle.tables.session_work_summary_updates.filter((row) => sessionIds.has(String(row.session_id)))
      : bundle.tables.session_work_summary_updates,
  };

  for (const table of PROJECT_DATA_TABLES) {
    tables[table] = tables[table].map((row) => ({ ...row }));
  }

  return { ...bundle, scope: { type: "all" }, tables };
}

function applyPathRemaps(
  tables: Record<ProjectDataTable, ProjectDataRow[]>,
  mappings: readonly ProjectPathRemap[],
): ProjectDataImportPreview["remappedPaths"] {
  return mappings.map((mapping) => {
    let projects = 0;
    let snapshots = 0;
    for (const row of tables.projects) {
      const path = String(row.root_path);
      const moved = remapPathPrefix(path, mapping);
      if (moved !== path) {
        row.root_path = moved;
        projects += 1;
      }
    }
    for (const row of tables.raw_snapshots) {
      if (typeof row.source_path !== "string") {
        continue;
      }
      const moved = remapPathPrefix(row.source_path, mapping);
      if (moved !== row.source_path) {
        row.source_path = moved;
        snapshots += 1;
      }
    }
    return { projects, snapshots };
  });
}

function equalProjectRoot(left: string, right: string): boolean {
  return projectRootKey(left) === projectRootKey(right);
}

function projectRootKey(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const windowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  return windowsPath ? normalized.toLowerCase() : normalized;
}

function uniqueIndexKey(fields: readonly string[], row: ProjectDataRow): string | undefined {
  const values: ProjectDataValue[] = [];
  for (const field of fields) {
    const value = row[field];
    if (value === null || value === undefined) {
      return undefined;
    }
    values.push(value);
  }
  return JSON.stringify([fields, values]);
}

function runReadTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}

function equalRows(table: ProjectDataTable, left: ProjectDataRow, right: ProjectDataRow): boolean {
  return projectDataExportTableColumns[table].every((column) => left[column] === right[column]);
}

function existingRow(db: DatabaseSync, table: ProjectDataTable, id: string): ProjectDataRow | undefined {
  const columns = projectDataExportTableColumns[table].join(", ");
  return db.prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`).get(id) as unknown as ProjectDataRow | undefined;
}

function existingUniqueRow(db: DatabaseSync, table: ProjectDataTable, row: ProjectDataRow): ProjectDataRow | undefined {
  for (const fields of UNIQUE_FIELDS[table] ?? []) {
    const values: ProjectDataValue[] = [];
    let missingValue = false;
    for (const field of fields) {
      const value = row[field];
      if (value === null || value === undefined) {
        missingValue = true;
        break;
      }
      values.push(value);
    }
    if (missingValue) {
      continue;
    }
    const where = fields.map((field) => `${field} = ?`).join(" AND ");
    const columns = projectDataExportTableColumns[table].join(", ");
    const found = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${where}`).get(...values) as
      ProjectDataRow | undefined;
    if (found) {
      return found;
    }
  }
  return undefined;
}

function countPlan(plan: TransferPlan, disposition: PlannedRow["disposition"]): ProjectDataCounts {
  const counts = emptyCounts();
  for (const table of TABLE_ORDER) {
    counts[table] = plan.rows[table].filter((row) => row.disposition === disposition).length;
  }
  return counts;
}

function isAvailable(
  table: ProjectDataTable,
  id: string,
  selectedIds: Set<string>,
  availableIds: Record<ProjectDataTable, Set<string>>,
  conflictIds: Record<ProjectDataTable, Set<string>>,
): boolean {
  if (selectedIds.has(id) && conflictIds[table].has(id)) {
    return false;
  }
  return availableIds[table].has(id);
}

function dependencyIssue(
  table: ProjectDataTable,
  row: ProjectDataRow,
  projectIds: Map<string, string>,
  selectedIds: Record<ProjectDataTable, Set<string>>,
  availableIds: Record<ProjectDataTable, Set<string>>,
  conflictIds: Record<ProjectDataTable, Set<string>>,
): string | undefined {
  if (table !== "projects" && typeof row.project_id === "string") {
    const mappedProjectId = projectIds.get(row.project_id);
    if (
      !mappedProjectId ||
      !isAvailable("projects", mappedProjectId, selectedIds.projects, availableIds, conflictIds)
    ) {
      return "所屬專案發生衝突或不存在。";
    }
    row.project_id = mappedProjectId;
  }

  const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
  if (sessionId && !isAvailable("sessions", sessionId, selectedIds.sessions, availableIds, conflictIds)) {
    return "關聯的 Session 發生衝突或不存在。";
  }
  if (table === "session_links") {
    const relatedSessionId = String(row.related_session_id);
    if (sessionId === relatedSessionId) {
      return "Session 不可與自己建立關聯。";
    }
    if (!selectedIds.sessions.has(sessionId ?? "") || !selectedIds.sessions.has(relatedSessionId)) {
      return "Session 關聯的兩端都必須包含在匯入範圍內。";
    }
    if (!isAvailable("sessions", relatedSessionId, selectedIds.sessions, availableIds, conflictIds)) {
      return "關聯的另一端 Session 發生衝突或不存在。";
    }
  }

  if (table === "knowledge") {
    const lastConfirmedSessionId =
      typeof row.last_confirmed_session_id === "string" ? row.last_confirmed_session_id : undefined;
    if (
      lastConfirmedSessionId &&
      !isAvailable("sessions", lastConfirmedSessionId, selectedIds.sessions, availableIds, conflictIds)
    ) {
      return "Knowledge 的最後確認 Session 發生衝突或不存在。";
    }
    const supersedesId = typeof row.supersedes_id === "string" ? row.supersedes_id : undefined;
    if (supersedesId && !selectedIds.knowledge.has(supersedesId)) {
      return "Knowledge 的 supersedes 關聯不在匯入範圍內。";
    }
    if (supersedesId && !isAvailable("knowledge", supersedesId, selectedIds.knowledge, availableIds, conflictIds)) {
      return "Knowledge 的 supersedes 目標發生衝突或不存在。";
    }
  }

  if (table === "knowledge_audit" || table === "knowledge_candidates") {
    const knowledgeId = typeof row.knowledge_id === "string" ? row.knowledge_id : undefined;
    if (knowledgeId && !isAvailable("knowledge", knowledgeId, selectedIds.knowledge, availableIds, conflictIds)) {
      return "關聯的 Knowledge 發生衝突或不存在。";
    }
  }

  const requestId = typeof row.request_id === "string" ? row.request_id : undefined;
  const requestTable = table === "report_summaries" ? "report_synthesis_requests" : "knowledge_candidate_requests";
  if (requestId && (table === "report_summaries" || table === "knowledge_candidates")) {
    if (!isAvailable(requestTable, requestId, selectedIds[requestTable], availableIds, conflictIds)) {
      return "關聯的請求發生衝突或不存在。";
    }
  }

  if (table === "void_audit") {
    const targetTable = row.target_type === "session" ? "sessions" : "evidence";
    if (!isAvailable(targetTable, String(row.target_id), selectedIds[targetTable], availableIds, conflictIds)) {
      return "作廢紀錄的目標發生衝突或不存在。";
    }
  }
  return undefined;
}

function orderKnowledgeRows(rows: ProjectDataRow[]): ProjectDataRow[] {
  const rowsById = new Map(rows.map((row) => [String(row.id), row]));
  const depths = new Map<string, number>();
  const depth = (id: string, visiting = new Set<string>()): number => {
    const known = depths.get(id);
    if (known !== undefined) {
      return known;
    }
    const row = rowsById.get(id);
    if (!row || typeof row.supersedes_id !== "string" || !rowsById.has(row.supersedes_id)) {
      depths.set(id, 0);
      return 0;
    }
    if (visiting.has(id)) {
      return 0;
    }
    const next = new Set(visiting);
    next.add(id);
    const result = depth(row.supersedes_id, next) + 1;
    depths.set(id, result);
    return result;
  };
  return [...rows].sort((left, right) => depth(String(left.id)) - depth(String(right.id)));
}

function makePlan(db: DatabaseSync, input: ProjectDataImportInput): TransferPlan {
  const inputResult = projectDataImportInputSchema.safeParse(input);
  if (!inputResult.success) {
    throw new ProjectDataTransferError(
      "invalid_input",
      `匯入資料不符合格式：${inputResult.error.issues[0]?.message ?? "欄位驗證失敗。"}`,
    );
  }
  const bundleResult = projectDataExportSchema.safeParse(input.bundle);
  if (!bundleResult.success) {
    throw new ProjectDataTransferError(
      "invalid_bundle",
      `匯入檔格式錯誤：${bundleResult.error.issues[0]?.message ?? "欄位驗證失敗。"}`,
    );
  }
  if (input.bundle.schemaVersion !== LATEST_SCHEMA_VERSION) {
    throw new ProjectDataTransferError(
      "unsupported_schema",
      `匯入檔使用 schema 版本 ${input.bundle.schemaVersion}，目前支援版本為 ${LATEST_SCHEMA_VERSION}。`,
    );
  }

  const selectedBundle = bundleForScope(input.bundle, input.projectId);
  const remappedPaths = applyPathRemaps(selectedBundle.tables, input.remap ?? []);
  const rows = emptyRows();
  const conflictIds = Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, new Set<string>()])) as Record<
    ProjectDataTable,
    Set<string>
  >;
  const plannedUniqueKeys = Object.fromEntries(
    PROJECT_DATA_TABLES.map((table) => [table, new Set<string>()]),
  ) as Record<ProjectDataTable, Set<string>>;
  const conflicts: ProjectDataImportConflict[] = [];
  let conflictDetailsTruncated = false;
  const addPlan = (
    table: ProjectDataTable,
    row: ProjectDataRow,
    disposition: PlannedRow["disposition"],
    reason?: string,
  ) => {
    rows[table].push({ row, disposition, reason });
    if (disposition === "conflict") {
      conflictIds[table].add(String(row.id));
      if (conflicts.length < CONFLICT_DETAIL_LIMIT) {
        conflicts.push({ table, id: String(row.id).slice(0, MAX_CONFLICT_ID_LENGTH), reason: reason ?? "資料衝突。" });
      } else {
        conflictDetailsTruncated = true;
      }
    } else {
      for (const fields of UNIQUE_FIELDS[table] ?? []) {
        const key = uniqueIndexKey(fields, row);
        if (key !== undefined) {
          plannedUniqueKeys[table].add(key);
        }
      }
    }
  };

  const existingIds = Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, getRows(db, table)])) as Record<
    ProjectDataTable,
    Set<string>
  >;
  const existingRowsById = Object.fromEntries(
    PROJECT_DATA_TABLES.map((table) => [
      table,
      new Map(
        rowsByIds(
          db,
          table,
          "id",
          selectedBundle.tables[table].map((row) => String(row.id)),
        ).map((row) => [String(row.id), row]),
      ),
    ]),
  ) as Record<ProjectDataTable, Map<string, ProjectDataRow>>;
  const selectedIds = Object.fromEntries(
    PROJECT_DATA_TABLES.map((table) => [table, new Set(selectedBundle.tables[table].map((row) => String(row.id)))]),
  ) as Record<ProjectDataTable, Set<string>>;
  const projectIds = new Map<string, string>();
  const existingProjects = db.prepare("SELECT id, root_path FROM projects ORDER BY id").all() as Array<{
    id: string;
    root_path: string;
  }>;
  const existingProjectsById = new Map(existingProjects.map((project) => [project.id, project]));
  const existingProjectsByRoot = new Map<string, (typeof existingProjects)[number]>();
  for (const project of existingProjects) {
    const rootKey = projectRootKey(project.root_path);
    if (!existingProjectsByRoot.has(rootKey)) {
      existingProjectsByRoot.set(rootKey, project);
    }
  }
  const plannedProjectsByRoot = new Map<string, { rootPath: string; projectId: string }>();
  const plannedProjectIds = new Set<string>();

  for (const original of selectedBundle.tables.projects) {
    const row = { ...original };
    const sourceId = String(row.id);
    const rootPath = String(row.root_path);
    const rootKey = projectRootKey(rootPath);
    const byId = existingProjectsById.get(sourceId);
    const byRoot = existingProjectsByRoot.get(rootKey);
    const plannedByRoot = plannedProjectsByRoot.get(rootKey);

    if (byId && byRoot && byId.id !== byRoot.id) {
      addPlan("projects", row, "conflict", "專案 ID 與根路徑分別對應到不同的既有專案。");
      continue;
    }
    if (byId && !equalProjectRoot(byId.root_path, rootPath)) {
      addPlan("projects", row, "conflict", "相同專案 ID 已存在，但根路徑不同；請確認路徑前綴轉換。");
      continue;
    }
    const matchedProject = byId ?? byRoot ?? plannedByRoot;
    if (matchedProject) {
      const targetId = "projectId" in matchedProject ? matchedProject.projectId : matchedProject.id;
      projectIds.set(sourceId, targetId);
      existingIds.projects.add(targetId);
      addPlan("projects", row, "skip");
      continue;
    }
    if (plannedProjectIds.has(sourceId)) {
      addPlan("projects", row, "conflict", "匯入檔中有重複的專案 ID。");
      continue;
    }
    projectIds.set(sourceId, sourceId);
    row.status = "paused";
    plannedProjectsByRoot.set(rootKey, { rootPath, projectId: sourceId });
    plannedProjectIds.add(sourceId);
    existingIds.projects.add(sourceId);
    addPlan("projects", row, "add");
  }

  for (const table of TABLE_ORDER) {
    if (table === "projects") {
      continue;
    }
    const sourceRows =
      table === "knowledge" ? orderKnowledgeRows(selectedBundle.tables.knowledge) : selectedBundle.tables[table];
    for (const sourceRow of sourceRows) {
      const row = { ...sourceRow };
      const dependencyError = dependencyIssue(table, row, projectIds, selectedIds, existingIds, conflictIds);
      if (dependencyError) {
        addPlan(table, row, "conflict", dependencyError);
        continue;
      }
      const id = String(row.id);
      const current = existingRowsById[table].get(id);
      if (current) {
        if (equalRows(table, current, row)) {
          addPlan(table, row, "skip");
        } else {
          addPlan(table, row, "conflict", "相同 ID 的既有資料內容不同。");
        }
        continue;
      }

      const unique = existingUniqueRow(db, table, row);
      if (unique) {
        addPlan(table, row, "conflict", "唯一識別值已被另一筆資料使用。");
        continue;
      }
      const hasPlannedUnique = (UNIQUE_FIELDS[table] ?? []).some((fields) => {
        const key = uniqueIndexKey(fields, row);
        return key !== undefined && plannedUniqueKeys[table].has(key);
      });
      if (hasPlannedUnique) {
        addPlan(table, row, "conflict", "匯入檔內有重複的唯一識別值。");
        continue;
      }
      existingIds[table].add(id);
      addPlan(table, row, "add");
    }
  }

  return {
    rows,
    projectIds,
    selectedProjects: selectedBundle.tables.projects.map((project) => ({
      id: String(project.id),
      name: String(project.name),
    })),
    remappedPaths,
    conflicts,
    conflictDetailsTruncated,
  };
}

function previewFromPlan(plan: TransferPlan): ProjectDataImportPreview {
  return {
    outcome: "project_data_import_preview",
    additions: countPlan(plan, "add"),
    skipped: countPlan(plan, "skip"),
    conflicts: countPlan(plan, "conflict"),
    selectedProjects: plan.selectedProjects,
    remappedPaths: plan.remappedPaths,
    conflictDetails: plan.conflicts,
    conflictDetailsTruncated: plan.conflictDetailsTruncated,
  };
}

function insertRow(db: DatabaseSync, table: ProjectDataTable, row: ProjectDataRow, statement: InsertStatement): void {
  const columns = projectDataExportTableColumns[table];
  const values = columns.map((column) => {
    const value = row[column];
    if (value === undefined) {
      throw new ProjectDataTransferError("invalid_bundle", `匯入的 ${table} 資料缺少 ${column} 欄位。`);
    }
    return value;
  });
  statement.run(...values);
}

/** Exports complete project-scoped data and merges validated portable data without closing SQLite. */
export class ProjectDataTransferService {
  public constructor(private readonly db: DatabaseSync) {}

  public export(scope: ProjectDataExportScope): ProjectDataExport {
    return runReadTransaction(this.db, () => {
      if (scope.type === "project" && !existingRow(this.db, "projects", scope.projectId)) {
        throw new ProjectDataTransferError("project_not_found", "找不到要匯出的專案。");
      }
      return {
        format: "work-intelligence-export",
        formatVersion: 1,
        schemaVersion: LATEST_SCHEMA_VERSION,
        exportedAt: nowIso(),
        scope,
        tables: selectExportRows(this.db, scope),
      };
    });
  }

  public preview(input: ProjectDataImportInput): ProjectDataImportPreview {
    return runReadTransaction(this.db, () => previewFromPlan(makePlan(this.db, input)));
  }

  public import(input: ProjectDataImportInput): ProjectDataImportResult {
    return runImmediateTransaction(this.db, () => {
      const plan = makePlan(this.db, input);
      const insertStatements = new Map<ProjectDataTable, InsertStatement>();
      for (const table of TABLE_ORDER) {
        for (const entry of plan.rows[table]) {
          if (entry.disposition === "add") {
            let statement = insertStatements.get(table);
            if (!statement) {
              const columns = projectDataExportTableColumns[table];
              const placeholders = columns.map(() => "?").join(", ");
              statement = this.db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
              insertStatements.set(table, statement);
            }
            insertRow(this.db, table, entry.row, statement);
          }
        }
      }
      const preview = previewFromPlan(plan);
      const importedAt = nowIso();
      const sourceDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const remapCounts = JSON.stringify(plan.remappedPaths);
      this.db
        .prepare(
          `INSERT INTO project_data_import_audits
           (id, source_digest, imported_at, additions_json, skipped_json, conflicts_json, remapped_paths_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          sourceDigest,
          importedAt,
          JSON.stringify(preview.additions),
          JSON.stringify(preview.skipped),
          JSON.stringify(preview.conflicts),
          remapCounts,
        );
      return { ...preview, outcome: "project_data_imported", importedAt };
    });
  }
}
