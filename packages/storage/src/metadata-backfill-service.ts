import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  CancelMetadataBackfillRequestResult,
  CreateMetadataBackfillRequestInput,
  CreateMetadataBackfillRequestResult,
  MetadataBackfillApplyInput,
  MetadataBackfillBatchResult,
  MetadataBackfillFailure,
  MetadataBackfillItem,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequest,
  MetadataBackfillRequestContextQuery,
  MetadataBackfillRequestContextQueryResult,
  MetadataBackfillRequestListQueryResult,
  MetadataBackfillRequestQuery,
  MetadataBackfillSkipped,
  PolicyDecision,
  ProjectIdSkippedResult,
  ProjectRecord,
  UpdateSessionMetadataInput,
  UpdateSessionMetadataResult,
  WorkSessionRecord,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { isChangedFilesMetadataConfirmed } from "./changed-files-confirmation.js";
import { DataRevisionCache } from "./data-revision-cache.js";
import { MetadataBackfillRepository } from "./metadata-backfill-repository.js";
import { runImmediateTransaction as runImmediateSqlTransaction } from "./sqlite-transaction.js";
import type { SessionRow } from "./session-repository.js";

interface MetadataBackfillStoreReader {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  checkProjectById(projectId: string): PolicyDecision;
  getProjectById(projectId: string): ProjectRecord | undefined;
  updateSessionMetadata(input: UpdateSessionMetadataInput): UpdateSessionMetadataResult;
  toSession(row: SessionRow): WorkSessionRecord;
}

type MetadataBackfillRequestRow = {
  id: string;
  idempotency_key: string;
  scope_type: "all" | "project";
  project_id: string | null;
  project_name: string | null;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  source_session_ids_json: string;
};

type MetadataBackfillRow = SessionRow & {
  project_root: string;
  raw_snapshot_count: number;
};

type MetadataBackfillTotals = Extract<MetadataBackfillPreviewResult, { outcome: "backfill_preview" }>["totals"];

type MetadataBackfillCountRow = {
  needs_backfill: number;
  changed_files_missing: number;
  verification_missing: number;
  verification_not_run: number;
};

function changedFilesMetadataMissingSql(alias: string): string {
  const json = `${alias}.changed_files_json`;
  const validJsonArray =
    `CASE WHEN json_valid(${json}) THEN CASE WHEN json_type(${json}) = 'array' ` +
    `THEN ${json} ELSE '[]' END ELSE '[]' END`;
  return (
    `CASE WHEN json_valid(${json}) THEN CASE WHEN json_type(${json}) = 'array' ` +
    `AND NOT EXISTS (SELECT 1 FROM json_each(${validJsonArray}) AS changed_file WHERE changed_file.type <> 'text') ` +
    `AND (json_array_length(${json}) > 0 OR ${alias}.changed_files_confirmed = 1) ` +
    `THEN 0 ELSE 1 END ELSE 1 END`
  );
}

function verificationValueFalsySql(alias: string): string {
  const json = `${alias}.verification_json`;
  return (
    `CASE WHEN ${json} IS NULL OR NOT json_valid(${json}) THEN 1 ` +
    `WHEN json_type(${json}) IN ('null', 'false') THEN 1 ` +
    `WHEN json_type(${json}) IN ('integer', 'real') AND json_extract(${json}, '$') = 0 THEN 1 ` +
    `WHEN json_type(${json}) = 'text' AND json_extract(${json}, '$') = '' THEN 1 ELSE 0 END`
  );
}

function verificationStatusNotSuppliedSql(alias: string): string {
  const json = `${alias}.verification_json`;
  const falsy = verificationValueFalsySql(alias);
  return (
    `CASE WHEN ${falsy} = 1 THEN 1 ` +
    `WHEN json_type(${json}, '$.status') IS NULL OR json_type(${json}, '$.status') = 'null' ` +
    `THEN 1 ELSE 0 END`
  );
}

function verificationStatusNotRunSql(alias: string): string {
  const json = `${alias}.verification_json`;
  return (
    `CASE WHEN json_valid(${json}) AND json_type(${json}, '$.status') = 'text' ` +
    `AND json_extract(${json}, '$.status') = 'not_run' THEN 1 ELSE 0 END`
  );
}

function metadataBackfillCandidateSql(alias: string): string {
  const changedFilesMissing = changedFilesMetadataMissingSql(alias);
  const verificationFalsy = verificationValueFalsySql(alias);
  const verificationNotRun = verificationStatusNotRunSql(alias);
  return `(${changedFilesMissing} = 1 OR ${verificationFalsy} = 1 OR ${verificationNotRun} = 1)`;
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

function toMetadataBackfillRequest(row: MetadataBackfillRequestRow): MetadataBackfillRequest {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    scopeType: row.scope_type,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    status: row.status,
    requestedAt: row.requested_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    sourceSessionIds: parseJson<string[]>(row.source_session_ids_json, []),
  };
}

function toMetadataBackfillItem(
  row: MetadataBackfillRow,
  mapSession: (row: SessionRow) => WorkSessionRecord,
): MetadataBackfillItem {
  const mapped = mapSession(row);
  // Legacy or hand-edited rows may hold JSON `null`, which parseJson returns as-is; treat non-arrays as empty.
  const session = {
    ...mapped,
    changedFiles: Array.isArray(mapped.changedFiles) ? mapped.changedFiles : [],
    changedFilesProvenance: Array.isArray(mapped.changedFilesProvenance) ? mapped.changedFilesProvenance : [],
    changedFileChanges: Array.isArray(mapped.changedFileChanges) ? mapped.changedFileChanges : [],
    verification: mapped.verification ?? undefined,
  };
  const gaps = [
    ...(!isChangedFilesMetadataConfirmed(row.changed_files_json, row.changed_files_confirmed)
      ? ["changed_files" as const]
      : []),
    ...(!session.verification || session.verification.status === "not_run" ? ["verification" as const] : []),
  ];
  return {
    sessionId: session.id,
    projectId: session.projectId,
    projectName: session.projectName ?? session.projectId,
    projectRoot: row.project_root,
    title: session.title,
    completedAt: session.completedAt,
    changedFilesCount: session.changedFiles.length,
    changedFilesProvenanceCount: session.changedFilesProvenance.length,
    changedFileChangesCount: session.changedFileChanges.length,
    changedFiles: session.changedFiles,
    changedFilesProvenance: session.changedFilesProvenance,
    changedFileChanges: session.changedFileChanges,
    verificationStatus: session.verification?.status ?? "not_supplied",
    ...(session.verification ? { verification: session.verification } : {}),
    rawSnapshotCount: row.raw_snapshot_count,
    gaps,
  };
}

export class MetadataBackfillService {
  // The follow-up count scans every Session of its scope and getContext asks for it on every call.
  private readonly followUpCounts: DataRevisionCache<MetadataBackfillTotals>;

  public constructor(
    private readonly db: DatabaseSync,
    private readonly store: MetadataBackfillStoreReader,
    private readonly repository: MetadataBackfillRepository,
  ) {
    this.followUpCounts = new DataRevisionCache(db);
  }

  private toMetadataBackfillItem(row: MetadataBackfillRow): MetadataBackfillItem {
    return toMetadataBackfillItem(row, (sessionRow) => this.store.toSession(sessionRow));
  }

  public previewMetadataBackfill(
    options: {
      projectRoot?: string;
      limit?: number;
    } = {},
  ): MetadataBackfillPreviewResult {
    let project: ProjectRecord | undefined;
    let projectId: string | undefined;
    if (options.projectRoot) {
      const decision = this.store.checkProjectRoot(options.projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      project = decision.project;
      projectId = project.id;
    }

    const parameters: string[] = [];
    const projectClause = projectId ? " AND s.project_id = ?" : "";
    if (projectId) {
      parameters.push(projectId);
    }
    const scanned = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sessions s JOIN projects p ON p.id = s.project_id " +
          "WHERE p.status = 'tracked' AND s.voided_at IS NULL" +
          projectClause,
      )
      .get(...parameters) as { count: number };
    // Keep the SQL candidate predicate equivalent to toMetadataBackfillItem so legacy or malformed JSON rows
    // cannot be dropped before the JavaScript DTO mapper decides the exact preview items.
    const candidate = metadataBackfillCandidateSql("s");
    const rows = this.db
      .prepare(
        "SELECT s.*, p.name AS project_name, p.root_path AS project_root, " +
          "(SELECT COUNT(*) FROM raw_snapshots rs WHERE rs.session_id = s.id) AS raw_snapshot_count " +
          "FROM sessions s JOIN projects p ON p.id = s.project_id " +
          "WHERE p.status = 'tracked' AND s.voided_at IS NULL" +
          projectClause +
          ` AND ${candidate} ` +
          "ORDER BY s.completed_at DESC, s.id DESC",
      )
      .all(...parameters) as MetadataBackfillRow[];
    const allItems = rows.map((row) => this.toMetadataBackfillItem(row)).filter((item) => item.gaps.length > 0);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const items = allItems.slice(0, limit);

    return {
      outcome: "backfill_preview",
      project,
      scannedSessions: scanned.count,
      truncated: allItems.length > limit,
      items,
      totals: {
        needsBackfill: allItems.length,
        changedFilesMissing: allItems.filter((item) => item.gaps.includes("changed_files")).length,
        verificationMissing: allItems.filter((item) => item.verificationStatus === "not_supplied").length,
        verificationNotRun: allItems.filter((item) => item.verificationStatus === "not_run").length,
      },
    };
  }

  public countMetadataBackfillFollowUps(options: { projectRoot?: string } = {}): MetadataBackfillTotals | undefined {
    let projectId: string | undefined;
    if (options.projectRoot) {
      const decision = this.store.checkProjectRoot(options.projectRoot);
      if (!decision.allowed || !decision.project) {
        return undefined;
      }
      projectId = decision.project.id;
    }
    // Policy is checked above on every call; only the count itself is reused, keyed by its project scope.
    const totals = this.followUpCounts.get(projectId ?? "", () => this.scanMetadataBackfillFollowUps(projectId));
    return { ...totals };
  }

  public createMetadataBackfillRequest(input: CreateMetadataBackfillRequestInput): CreateMetadataBackfillRequestResult {
    this.repository.recoverStale();
    let project: ProjectRecord | undefined;
    if (input.projectId) {
      project = this.store.getProjectById(input.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: input.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        } satisfies ProjectIdSkippedResult;
      }
      const decision = this.store.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        } satisfies ProjectIdSkippedResult;
      }
    }

    const preview = this.previewMetadataBackfill({ projectRoot: project?.rootPath, limit: 500 });
    if (preview.outcome !== "backfill_preview") {
      return preview;
    }
    const sourceSessionIds = preview.items.map((item) => item.sessionId);
    if (sourceSessionIds.length === 0) {
      return {
        outcome: "metadata_backfill_not_needed",
        scannedSessions: preview.scannedSessions,
        reason: "目前沒有需要回補的 metadata。",
      };
    }

    const scopeType = project ? "project" : "all";
    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `metadata-backfill-${createHash("sha256")
        .update(`${scopeType}:${project?.id ?? "all"}:${sourceSessionIds.join(",")}`)
        .digest("hex")}`;
    return runImmediateSqlTransaction(this.db, () => {
      const existingRow = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM metadata_backfill_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.idempotency_key = ?`,
        )
        .get(idempotencyKey) as MetadataBackfillRequestRow | undefined;
      if (existingRow) {
        if (existingRow.status === "cancelled") {
          // A cancelled request must not block a later scan with the same
          // deterministic source set. The retry gets its own idempotency key.
          const retryIdempotencyKey = `${idempotencyKey}:retry:${randomUUID()}`;
          const requestedAt = nowIso();
          const id = randomUUID();
          this.db
            .prepare(
              `INSERT INTO metadata_backfill_requests (
                 id, idempotency_key, scope_type, project_id, status, requested_at, source_session_ids_json
               ) VALUES (@id, @idempotencyKey, @scopeType, @projectId, 'pending', @requestedAt, @sourceSessionIds)`,
            )
            .run({
              id,
              idempotencyKey: retryIdempotencyKey,
              scopeType,
              projectId: project?.id ?? null,
              requestedAt,
              sourceSessionIds: JSON.stringify(sourceSessionIds),
            });
          const retryRow = this.db
            .prepare(
              `SELECT r.*, p.name AS project_name
               FROM metadata_backfill_requests r
               LEFT JOIN projects p ON p.id = r.project_id
               WHERE r.id = ?`,
            )
            .get(id) as MetadataBackfillRequestRow | undefined;
          if (!retryRow) {
            throw new Error("Metadata backfill retry request was inserted but could not be loaded.");
          }
          return {
            outcome: "metadata_backfill_request",
            duplicate: false,
            request: toMetadataBackfillRequest(retryRow),
          };
        }
        return {
          outcome: "metadata_backfill_request",
          duplicate: true,
          request: toMetadataBackfillRequest(existingRow),
        };
      }

      const requestedAt = nowIso();
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO metadata_backfill_requests (
             id, idempotency_key, scope_type, project_id, status, requested_at, source_session_ids_json
           ) VALUES (@id, @idempotencyKey, @scopeType, @projectId, 'pending', @requestedAt, @sourceSessionIds)`,
        )
        .run({
          id,
          idempotencyKey,
          scopeType,
          projectId: project?.id ?? null,
          requestedAt,
          sourceSessionIds: JSON.stringify(sourceSessionIds),
        });
      const row = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM metadata_backfill_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.id = ?`,
        )
        .get(id) as MetadataBackfillRequestRow | undefined;
      if (!row) {
        throw new Error("Metadata backfill request was inserted but could not be loaded.");
      }
      return {
        outcome: "metadata_backfill_request",
        duplicate: false,
        request: toMetadataBackfillRequest(row),
      };
    });
  }

  public listMetadataBackfillRequests(
    options: MetadataBackfillRequestQuery = {},
  ): MetadataBackfillRequestListQueryResult {
    this.repository.recoverStale();
    if (options.projectId) {
      const project = this.store.getProjectById(options.projectId);
      if (!project) {
        return {
          outcome: "skipped",
          projectId: options.projectId,
          projectStatus: "unregistered",
          reason: "Project is not registered.",
        } satisfies ProjectIdSkippedResult;
      }
      const decision = this.store.checkProjectById(project.id);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: project.id,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        } satisfies ProjectIdSkippedResult;
      }
    }

    const clauses = ["(r.project_id IS NULL OR p.status = 'tracked')"];
    const parameters: Array<string | number> = [];
    if (options.scopeType) {
      clauses.push("r.scope_type = ?");
      parameters.push(options.scopeType);
    }
    if (options.projectId) {
      clauses.push("r.project_id = ?");
      parameters.push(options.projectId);
    }
    if (options.status) {
      clauses.push("r.status = ?");
      parameters.push(options.status);
    }
    if (options.requestId) {
      clauses.push("r.id = ?");
      parameters.push(options.requestId);
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const rows = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM metadata_backfill_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY r.requested_at DESC, r.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit) as MetadataBackfillRequestRow[];
    return {
      outcome: "metadata_backfill_requests",
      requests: rows.map(toMetadataBackfillRequest),
    };
  }

  public cancelMetadataBackfillRequest(requestId: string): CancelMetadataBackfillRequestResult {
    this.repository.recoverStale();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM metadata_backfill_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as MetadataBackfillRequestRow | undefined;
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
          reason: decision?.reason ?? "Project recording is not enabled.",
        } satisfies ProjectIdSkippedResult;
      }
    }

    const request = toMetadataBackfillRequest(row);
    if (request.status === "cancelled") {
      return { outcome: "metadata_backfill_request_cancelled", duplicate: true, request };
    }
    if (request.status !== "pending" && request.status !== "processing") {
      return {
        outcome: "metadata_backfill_cancel_rejected",
        requestId,
        status: request.status,
        reason: "只有等待 Agent 處理或 Agent 處理中的 metadata 回補可以取消。",
      };
    }

    this.db
      .prepare(
        `UPDATE metadata_backfill_requests
         SET status = 'cancelled', failure_reason = ?, completed_at = NULL
         WHERE id = ? AND status IN ('pending', 'processing')`,
      )
      .run("使用者取消這次 metadata 回補；Session 原有資料保留。", requestId);
    const nextRow = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM metadata_backfill_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(requestId) as MetadataBackfillRequestRow | undefined;
    if (!nextRow) {
      return { outcome: "not_found", requestId };
    }
    const nextRequest = toMetadataBackfillRequest(nextRow);
    if (nextRequest.status !== "cancelled") {
      return {
        outcome: "metadata_backfill_cancel_rejected",
        requestId,
        status: nextRequest.status,
        reason: "這次 metadata 回補已在取消前被其他流程更新，請重新整理狀態。",
      };
    }
    return { outcome: "metadata_backfill_request_cancelled", duplicate: false, request: nextRequest };
  }

  public getMetadataBackfillContext(
    options: MetadataBackfillRequestContextQuery,
  ): MetadataBackfillRequestContextQueryResult {
    this.repository.recoverStale();
    const row = this.db
      .prepare(
        `SELECT r.*, p.name AS project_name
         FROM metadata_backfill_requests r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?`,
      )
      .get(options.requestId) as MetadataBackfillRequestRow | undefined;
    if (!row) {
      return { outcome: "not_found", requestId: options.requestId };
    }

    const project = row.project_id ? this.store.getProjectById(row.project_id) : undefined;
    if (row.project_id) {
      const decision = this.store.checkProjectById(row.project_id);
      if (!decision?.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectId: row.project_id,
          projectStatus: decision?.projectStatus ?? "unregistered",
          reason: decision?.reason ?? "Project recording is not enabled.",
        } satisfies ProjectIdSkippedResult;
      }
    }

    const request = toMetadataBackfillRequest(row);
    if (request.status === "cancelled") {
      return {
        outcome: "metadata_backfill_request_not_ready",
        request,
        reason: "這筆 metadata 回補請求已取消；請由使用者重新建立請求後再處理。",
      };
    }
    const preview = this.previewMetadataBackfill({ projectRoot: project?.rootPath, limit: 500 });
    if (preview.outcome !== "backfill_preview") {
      return preview;
    }
    const sourceSessionSet = new Set(request.sourceSessionIds);
    const currentItems = preview.items.filter((item) => sourceSessionSet.has(item.sessionId));
    const currentSessionSet = new Set(currentItems.map((item) => item.sessionId));
    const resolvedSessionIds = request.sourceSessionIds.filter((sessionId) => !currentSessionSet.has(sessionId));

    if (request.status === "pending" && currentItems.length > 0) {
      const startedAt = nowIso();
      this.db
        .prepare(
          "UPDATE metadata_backfill_requests SET status = 'processing', started_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(startedAt, request.id);
      request.status = "processing";
      request.startedAt = startedAt;
    }
    if ((request.status === "pending" || request.status === "processing") && currentItems.length === 0) {
      const completedAt = nowIso();
      this.db
        .prepare(
          "UPDATE metadata_backfill_requests SET status = 'completed', completed_at = ?, failure_reason = NULL WHERE id = ?",
        )
        .run(completedAt, request.id);
      request.status = "completed";
      request.completedAt = completedAt;
    }

    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
    return {
      outcome: "metadata_backfill_context",
      request,
      items: currentItems.slice(0, limit),
      resolvedSessionIds,
      sourceSessionIds: request.sourceSessionIds,
      truncated: currentItems.length > limit,
    };
  }

  public applyMetadataBackfill(input: MetadataBackfillApplyInput): MetadataBackfillBatchResult {
    this.repository.recoverStale();
    let request: MetadataBackfillRequest | undefined;
    if (input.requestId) {
      const requestRow = this.db
        .prepare(
          `SELECT r.*, p.name AS project_name
           FROM metadata_backfill_requests r
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.id = ?`,
        )
        .get(input.requestId) as MetadataBackfillRequestRow | undefined;
      if (!requestRow) {
        throw new Error(`Metadata backfill request was not found: ${input.requestId}`);
      }
      request = toMetadataBackfillRequest(requestRow);
      if (request.status === "cancelled") {
        return {
          outcome: "metadata_backfill_request_not_ready",
          request,
          reason: "這筆 metadata 回補請求已取消；不允許再寫入 Session。",
        };
      }
      if (request.status === "pending") {
        const startedAt = nowIso();
        this.db
          .prepare(
            "UPDATE metadata_backfill_requests SET status = 'processing', started_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(startedAt, request.id);
        request.status = "processing";
        request.startedAt = startedAt;
      }
    }
    const updated: WorkSessionRecord[] = [];
    const skipped: MetadataBackfillSkipped[] = [];
    const failures: MetadataBackfillFailure[] = [];
    const seenSessionIds = new Set<string>();

    for (const update of input.updates) {
      if (seenSessionIds.has(update.sessionId)) {
        failures.push({
          sessionId: update.sessionId,
          reason: "The same sessionId was provided more than once in this batch.",
        });
        continue;
      }
      seenSessionIds.add(update.sessionId);

      try {
        const result = this.store.updateSessionMetadata(update);
        if (result.outcome === "updated") {
          updated.push(result.session);
        } else if (result.outcome === "skipped") {
          skipped.push({
            sessionId: result.sessionId,
            projectStatus: result.projectStatus,
            reason: result.reason,
          });
        } else {
          failures.push({
            sessionId: result.sessionId,
            reason: "Session was not found.",
          });
        }
      } catch (error) {
        failures.push({
          sessionId: update.sessionId,
          reason: error instanceof Error ? error.message : "Session metadata update failed.",
        });
      }
    }

    let remainingItems: MetadataBackfillItem[] | undefined;
    if (request) {
      const context = this.getMetadataBackfillContext({ requestId: request.id, limit: 500 });
      if (context.outcome === "metadata_backfill_context") {
        request = context.request;
        remainingItems = context.items;
      }
    }

    return {
      outcome: "backfill_applied",
      requestedCount: input.updates.length,
      updated,
      skipped,
      failures,
      ...(request ? { request } : {}),
      ...(remainingItems ? { remainingItems } : {}),
    };
  }

  private scanMetadataBackfillFollowUps(projectId: string | undefined): MetadataBackfillTotals {
    const parameters: string[] = [];
    const projectClause = projectId ? " AND s.project_id = ?" : "";
    if (projectId) {
      parameters.push(projectId);
    }
    const changedFilesMissing = changedFilesMetadataMissingSql("s");
    const verificationFalsy = verificationValueFalsySql("s");
    const verificationMissing = verificationStatusNotSuppliedSql("s");
    const verificationNotRun = verificationStatusNotRunSql("s");
    const needsBackfill = `(${changedFilesMissing} = 1 OR ${verificationFalsy} = 1 OR ${verificationNotRun} = 1)`;
    const row = this.db
      .prepare(
        "SELECT " +
          `COALESCE(SUM(CASE WHEN ${needsBackfill} THEN 1 ELSE 0 END), 0) AS needs_backfill, ` +
          `COALESCE(SUM(CASE WHEN ${changedFilesMissing} = 1 THEN 1 ELSE 0 END), 0) AS changed_files_missing, ` +
          `COALESCE(SUM(CASE WHEN ${needsBackfill} AND ${verificationMissing} = 1 THEN 1 ELSE 0 END), 0) AS verification_missing, ` +
          `COALESCE(SUM(CASE WHEN ${needsBackfill} AND ${verificationNotRun} = 1 THEN 1 ELSE 0 END), 0) AS verification_not_run ` +
          "FROM sessions s JOIN projects p ON p.id = s.project_id " +
          "WHERE p.status = 'tracked' AND s.voided_at IS NULL" +
          projectClause,
      )
      .get(...parameters) as MetadataBackfillCountRow;
    return {
      needsBackfill: row.needs_backfill,
      changedFilesMissing: row.changed_files_missing,
      verificationMissing: row.verification_missing,
      verificationNotRun: row.verification_not_run,
    };
  }
}
