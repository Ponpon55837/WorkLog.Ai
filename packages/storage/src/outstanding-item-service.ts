import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BatchUpdateOutstandingItemStatusInput,
  BatchUpdateOutstandingItemStatusResult,
  ListOutstandingItemsInput,
  OutstandingItem,
  OutstandingItemEventSource,
  OutstandingItemListQueryResult,
  OutstandingItemStatus,
  PolicyDecision,
  UpdateOutstandingItemStatusResult,
} from "@work-intelligence/core";
import { MAX_OUTSTANDING_ITEM_BATCH_SIZE, OUTSTANDING_ITEM_STATUSES } from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { normalizePath, parseQueryWords } from "./search-text.js";
import { createPageInfo } from "./pagination.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

export interface OutstandingItemFocus {
  projectId?: string;
  task?: string;
  paths?: readonly string[];
  sourceSessionIds?: readonly string[];
  excludeSourceSessionId?: string;
}

type OutstandingItemRow = {
  id: string;
  source_session_id: string;
  project_id: string;
  project_name: string;
  source_session_title: string;
  source_session_completed_at: string;
  position: number;
  text: string;
  status: OutstandingItemStatus;
  created_at: string;
  updated_at: string;
};

interface OutstandingItemDependencies {
  checkProjectById(projectId: string): PolicyDecision;
  checkProjectRoot(projectRoot: string): PolicyDecision;
}

function toOutstandingItem(row: OutstandingItemRow): OutstandingItem {
  return {
    id: row.id,
    sourceSessionId: row.source_session_id,
    projectId: row.project_id,
    projectName: row.project_name,
    sourceSessionTitle: row.source_session_title,
    sourceSessionCompletedAt: row.source_session_completed_at,
    position: row.position,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function baseSelect(
  where: string,
  columns = `i.*, p.name AS project_name, s.title AS source_session_title,
                 s.completed_at AS source_session_completed_at`,
): string {
  return `SELECT ${columns}
          FROM outstanding_items i
          JOIN projects p ON p.id = i.project_id
          JOIN sessions s ON s.id = i.source_session_id AND s.project_id = i.project_id
          WHERE p.status = 'tracked' AND s.voided_at IS NULL ${where}`;
}

/** Parses local ISO dates without Date's numeric-year 0–99 remapping to 1900–1999. */
function calendarDayBound(value: string, nextDay = false): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return nextDay ? `${value}￿` : value;
  if (nextDay) date.setDate(date.getDate() + 1);
  // Extended ISO years start with '+', which would sort before four-digit persisted timestamps.
  return date.getUTCFullYear() > 9999 ? "￿" : date.toISOString();
}

function appendEvent(
  db: DatabaseSync,
  itemId: string,
  projectId: string,
  fromStatus: OutstandingItemStatus | null,
  toStatus: OutstandingItemStatus,
  source: OutstandingItemEventSource,
  actorSessionId: string | undefined,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO outstanding_item_events
       (id, item_id, project_id, from_status, to_status, source, actor_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), itemId, projectId, fromStatus, toStatus, source, actorSessionId ?? null, createdAt);
}

/** Durable, source-linked unfinished work with append-only status history. */
export class OutstandingItemService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: OutstandingItemDependencies,
  ) {}

  public list(input: ListOutstandingItemsInput = {}): OutstandingItemListQueryResult {
    let projectId = input.projectId;
    if (input.projectRoot) {
      const policy = this.dependencies.checkProjectRoot(input.projectRoot);
      if (!policy.allowed || !policy.project) {
        return {
          outcome: "skipped",
          projectRoot: policy.canonicalRoot,
          projectStatus: policy.projectStatus,
          reason: policy.reason ?? "Project recording is not enabled.",
        };
      }
      if (projectId && projectId !== policy.project.id) {
        return {
          outcome: "skipped",
          projectRoot: policy.canonicalRoot,
          projectId,
          projectStatus: "tracked",
          reason: "Project root and id do not identify the same tracked project.",
        };
      }
      projectId = policy.project.id;
    } else if (projectId) {
      const policy = this.dependencies.checkProjectById(projectId);
      if (!policy.allowed || !policy.project) {
        return {
          outcome: "skipped",
          projectId,
          projectStatus: policy.projectStatus,
          reason: policy.reason ?? "Project recording is not enabled.",
        };
      }
    }
    const status = input.status ?? "pending";
    const where = `${projectId ? "AND i.project_id = ?" : ""} AND i.status = ?
      ${input.from ? "AND s.completed_at >= ?" : ""} ${input.to ? "AND s.completed_at < ?" : ""}`;
    const params = [
      ...(projectId ? [projectId] : []),
      status,
      ...(input.from ? [calendarDayBound(input.from)] : []),
      ...(input.to ? [calendarDayBound(input.to, true)] : []),
    ];
    const total = (this.db.prepare(baseSelect(where, "COUNT(*) AS count")).get(...params) as { count: number }).count;
    const pageInfo = createPageInfo(input.page, input.pageSize, total, 100);
    const rows = this.db
      .prepare(
        `${baseSelect(where)} ORDER BY s.completed_at DESC, i.source_session_id DESC, i.position ASC, i.id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as OutstandingItemRow[];
    return { outcome: "outstanding_items", items: rows.map(toOutstandingItem), pageInfo };
  }

  public hasPending(projectId: string, excludeSourceSessionId?: string): boolean {
    const policy = this.dependencies.checkProjectById(projectId);
    if (!policy.allowed || !policy.project) return false;
    return Boolean(
      this.db
        .prepare(
          `${baseSelect("AND i.project_id = ? AND i.status = 'pending' AND i.source_session_id <> ?", "i.id")} LIMIT 1`,
        )
        .get(projectId, excludeSourceSessionId ?? ""),
    );
  }

  /** Scores every eligible pending item in SQL, returning at most five pointers without per-item queries. */
  public relatedPending(input: OutstandingItemFocus): { items: OutstandingItem[]; total: number } {
    if (input.projectId) {
      const policy = this.dependencies.checkProjectById(input.projectId);
      if (!policy.allowed || !policy.project) return { items: [], total: 0 };
    }
    const terms = [...new Set(parseQueryWords((input.task ?? "").slice(0, 2_000)).flatMap((word) => word.terms))].slice(
      0,
      24,
    );
    const projects = input.paths?.length
      ? (this.db
          .prepare(
            `SELECT name, root_path AS rootPath FROM projects WHERE status = 'tracked' ${input.projectId ? "AND id = ?" : ""}`,
          )
          .all(...(input.projectId ? [input.projectId] : [])) as Array<{ name: string; rootPath: string }>)
      : [];
    const paths = [...new Set((input.paths ?? []).map((path) => normalizePath(path, projects)).filter(Boolean))].slice(
      0,
      20,
    );
    const sources = [...new Set(input.sourceSessionIds ?? [])].slice(0, 20);
    if (!terms.length && !paths.length && !sources.length) return { items: [], total: 0 };
    const changedPath = "lower(replace(f.value, char(92), '/'))";
    // Materialized CTEs parse query inputs and score each item once; window sorting must not repeat correlated scans.
    // Equality and segment boundaries treat directories literally; Agent paths never become LIKE patterns.
    const pathMatch = `${changedPath} = q.path
      OR substr(${changedPath}, 1, length(q.path) + 1) = q.path || '/'
      OR substr(${changedPath}, -length(q.path) - 1) = '/' || q.path
      OR substr(q.path, -length(${changedPath}) - 1) = '/' || ${changedPath}`;
    const score = `(SELECT COUNT(*) FROM keywords WHERE instr(lower(i.text), term) > 0) * 3.0
      + (SELECT COUNT(*) FROM keywords WHERE instr(lower(s.title), term) > 0) * 0.5
      + (SELECT COUNT(*) FROM keywords WHERE instr(lower(substr(s.summary, 1, 2000)), term) > 0) * 0.25
      + COALESCE((SELECT weight FROM sources WHERE id = s.id), 0)
      + (SELECT COUNT(*) FROM path_queries q WHERE EXISTS (
        SELECT 1 FROM json_each(s.changed_files_json) f WHERE ${pathMatch}
      )) * 10.0`;
    const rows = this.db
      .prepare(
        `WITH
      keywords AS MATERIALIZED (SELECT value AS term FROM json_each(?)),
      path_queries AS MATERIALIZED (SELECT value AS path FROM json_each(?)),
      sources AS MATERIALIZED (SELECT value AS id, (20 - CAST(key AS INTEGER)) / 20.0 AS weight FROM json_each(?)),
      scored AS MATERIALIZED (${baseSelect(
        `AND i.status = 'pending' ${input.projectId ? "AND i.project_id = ?" : ""} AND i.source_session_id <> ?`,
        `i.*, p.name AS project_name, s.title AS source_session_title,
         s.completed_at AS source_session_completed_at, ${score} AS relevance`,
      )})
      SELECT *, COUNT(*) OVER () AS matching_total FROM scored WHERE relevance > 0
      ORDER BY relevance DESC, source_session_completed_at DESC, source_session_id DESC, position ASC, id ASC
      LIMIT 5`,
      )
      .all(
        JSON.stringify(terms),
        JSON.stringify(paths),
        JSON.stringify(sources),
        ...(input.projectId ? [input.projectId] : []),
        input.excludeSourceSessionId ?? "",
      ) as Array<OutstandingItemRow & { matching_total: number }>;
    return { items: rows.map(toOutstandingItem), total: rows[0]?.matching_total ?? 0 };
  }

  public batchUpdateStatus(input: BatchUpdateOutstandingItemStatusInput): BatchUpdateOutstandingItemStatusResult {
    const { itemIds, status, expectedStatus } = input;
    if (
      !Array.isArray(itemIds) ||
      itemIds.length < 1 ||
      itemIds.length > MAX_OUTSTANDING_ITEM_BATCH_SIZE ||
      itemIds.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 200) ||
      new Set(itemIds).size !== itemIds.length ||
      !OUTSTANDING_ITEM_STATUSES.includes(status) ||
      (expectedStatus !== undefined && !OUTSTANDING_ITEM_STATUSES.includes(expectedStatus))
    ) {
      return { outcome: "rejected", reason: "invalid_batch", invalidItemIds: [] };
    }
    return runImmediateTransaction(this.db, () => {
      const placeholders = itemIds.map(() => "?").join(", ");
      const metadata = this.db
        .prepare(`SELECT id, project_id FROM outstanding_items WHERE id IN (${placeholders})`)
        .all(...itemIds) as Array<{ id: string; project_id: string }>;
      for (const projectId of new Set(metadata.map((row) => row.project_id))) {
        const policy = this.dependencies.checkProjectById(projectId);
        if (!policy.allowed || !policy.project) {
          return { outcome: "skipped", projectStatus: policy.projectStatus, reason: policy.reason };
        }
      }
      const rows = this.db.prepare(baseSelect(`AND i.id IN (${placeholders})`)).all(...itemIds) as OutstandingItemRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const invalidItemIds = itemIds.filter((id) => !byId.has(id));
      if (invalidItemIds.length) return { outcome: "rejected", reason: "invalid_items", invalidItemIds };
      const conflicts =
        expectedStatus === undefined ? [] : rows.filter((row) => row.status !== expectedStatus).map((row) => row.id);
      if (conflicts.length) return { outcome: "rejected", reason: "status_conflict", invalidItemIds: conflicts };
      const updatedAt = nowIso();
      const update = this.db.prepare("UPDATE outstanding_items SET status = ?, updated_at = ? WHERE id = ?");
      const updatedItemIds: string[] = [];
      for (const id of itemIds) {
        const row = byId.get(id)!;
        if (row.status === status) continue;
        update.run(status, updatedAt, id);
        appendEvent(this.db, id, row.project_id, row.status, status, "web", undefined, updatedAt);
        row.status = status;
        row.updated_at = updatedAt;
        updatedItemIds.push(id);
      }
      return {
        outcome: "outstanding_items_updated",
        items: itemIds.map((id) => toOutstandingItem(byId.get(id)!)),
        updatedItemIds,
        duplicate: updatedItemIds.length === 0,
      };
    });
  }

  public updateStatus(
    itemId: string,
    status: OutstandingItemStatus,
    source: OutstandingItemEventSource = "web",
  ): UpdateOutstandingItemStatusResult {
    const projectRow = this.db.prepare("SELECT project_id FROM outstanding_items WHERE id = ?").get(itemId) as
      { project_id: string } | undefined;
    if (!projectRow) return { outcome: "not_found", itemId };
    const policy = this.dependencies.checkProjectById(projectRow.project_id);
    if (!policy.allowed || !policy.project) {
      return {
        outcome: "skipped",
        itemId,
        projectStatus: policy.projectStatus,
        reason: policy.reason ?? "Project recording is not enabled.",
      };
    }

    return runImmediateTransaction(this.db, () => {
      const row = this.db
        .prepare(
          `SELECT i.* FROM outstanding_items i
           JOIN sessions s ON s.id = i.source_session_id AND s.project_id = i.project_id
           WHERE i.id = ? AND i.project_id = ? AND s.voided_at IS NULL`,
        )
        .get(itemId, projectRow.project_id) as
        (Pick<OutstandingItemRow, "id" | "project_id" | "status"> & Record<string, unknown>) | undefined;
      if (!row) return { outcome: "not_found", itemId };
      const currentPolicy = this.dependencies.checkProjectById(row.project_id);
      if (!currentPolicy.allowed || !currentPolicy.project) {
        return {
          outcome: "skipped",
          itemId,
          projectStatus: currentPolicy.projectStatus,
          reason: currentPolicy.reason ?? "Project recording is not enabled.",
        };
      }
      const duplicate = row.status === status;
      if (!duplicate) {
        const updatedAt = nowIso();
        this.db
          .prepare("UPDATE outstanding_items SET status = ?, updated_at = ? WHERE id = ?")
          .run(status, updatedAt, itemId);
        appendEvent(this.db, itemId, row.project_id, row.status, status, source, undefined, updatedAt);
      }
      const updated = this.getRow(itemId);
      return updated
        ? { outcome: "outstanding_item_updated", item: toOutstandingItem(updated), duplicate }
        : { outcome: "not_found", itemId };
    });
  }

  /** Synchronizes the compatibility nextSteps array; call inside its caller's transaction. */
  public syncForSessionInTransaction(
    sessionId: string,
    projectId: string,
    nextSteps: readonly string[],
    source: Exclude<OutstandingItemEventSource, "migration">,
    actorSessionId: string,
    updatedAt: string,
  ): void {
    const existing = this.db
      .prepare(
        "SELECT id, position, text, status FROM outstanding_items WHERE source_session_id = ? ORDER BY position, id",
      )
      .all(sessionId) as Array<{ id: string; position: number; text: string; status: OutstandingItemStatus }>;
    const byText = new Map<string, typeof existing>();
    for (const row of existing) {
      const queue = byText.get(row.text) ?? [];
      queue.push(row);
      byText.set(row.text, queue);
    }
    const updatePosition = this.db.prepare("UPDATE outstanding_items SET position = ?, updated_at = ? WHERE id = ?");
    const insert = this.db.prepare(
      `INSERT INTO outstanding_items
         (id, source_session_id, project_id, position, text, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    const retained = new Set<string>();
    nextSteps.forEach((text, position) => {
      const previous = byText.get(text)?.shift();
      if (previous) {
        retained.add(previous.id);
        if (previous.position !== position) updatePosition.run(position, updatedAt, previous.id);
        return;
      }
      const id = randomUUID();
      insert.run(id, sessionId, projectId, position, text, updatedAt, updatedAt);
      appendEvent(this.db, id, projectId, null, "pending", source, actorSessionId, updatedAt);
    });
    const markNotNeeded = this.db.prepare(
      "UPDATE outstanding_items SET status = 'not_needed', updated_at = ? WHERE id = ? AND status = 'pending'",
    );
    for (const row of existing) {
      if (retained.has(row.id) || row.status !== "pending") continue;
      markNotNeeded.run(updatedAt, row.id);
      appendEvent(this.db, row.id, projectId, "pending", "not_needed", source, actorSessionId, updatedAt);
    }
  }

  /** Completes only pending items in the same project; call in finalize's transaction. */
  public resolvePendingInTransaction(
    itemIds: readonly string[],
    projectId: string,
    actorSessionId: string,
    updatedAt: string,
  ): { resolvedIds: string[]; unresolvedIds: string[] } {
    return this.transitionPendingInTransaction(itemIds, projectId, actorSessionId, updatedAt, "completed");
  }

  public supersedePendingInTransaction(
    itemIds: readonly string[],
    projectId: string,
    actorSessionId: string,
    updatedAt: string,
  ): { resolvedIds: string[]; unresolvedIds: string[] } {
    return this.transitionPendingInTransaction(itemIds, projectId, actorSessionId, updatedAt, "not_needed");
  }

  public transitionedByActorSession(actorSessionId: string, status: "completed" | "not_needed"): string[] {
    return (
      this.db
        .prepare(
          `SELECT item_id FROM outstanding_item_events
      WHERE actor_session_id = ? AND source = 'agent' AND from_status = 'pending' AND to_status = ?
      ORDER BY created_at, id`,
        )
        .all(actorSessionId, status) as Array<{ item_id: string }>
    ).map(({ item_id }) => item_id);
  }

  public resolvedByActorSession(actorSessionId: string): string[] {
    return this.transitionedByActorSession(actorSessionId, "completed");
  }

  public pendingForSessions(sessionIds: readonly string[]): OutstandingItem[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `${baseSelect(`AND i.status = 'pending' AND i.source_session_id IN (${placeholders})`)}
         ORDER BY i.source_session_id, i.position, i.id`,
      )
      .all(...sessionIds) as OutstandingItemRow[];
    return rows.map(toOutstandingItem);
  }

  private transitionPendingInTransaction(
    itemIds: readonly string[],
    projectId: string,
    actorSessionId: string,
    updatedAt: string,
    status: "completed" | "not_needed",
  ): { resolvedIds: string[]; unresolvedIds: string[] } {
    const requestedIds = [...new Set(itemIds)];
    if (requestedIds.length === 0) return { resolvedIds: [], unresolvedIds: [] };
    const placeholders = requestedIds.map(() => "?").join(", ");
    const pending = this.db
      .prepare(
        `SELECT i.id FROM outstanding_items i
         JOIN sessions s ON s.id = i.source_session_id AND s.project_id = i.project_id
         WHERE i.project_id = ? AND i.status = 'pending' AND s.voided_at IS NULL
           AND i.id IN (${placeholders})`,
      )
      .all(projectId, ...requestedIds) as Array<{ id: string }>;
    const update = this.db.prepare(
      `UPDATE outstanding_items SET status = ?, updated_at = ?
       WHERE id = ? AND status = 'pending' AND project_id = ?
         AND EXISTS (
           SELECT 1 FROM sessions s
           WHERE s.id = outstanding_items.source_session_id
             AND s.project_id = outstanding_items.project_id
             AND s.voided_at IS NULL
         )`,
    );
    for (const { id } of pending) {
      update.run(status, updatedAt, id, projectId);
      appendEvent(this.db, id, projectId, "pending", status, "agent", actorSessionId, updatedAt);
    }
    const resolvedIds = pending.map(({ id }) => id);
    const resolved = new Set(resolvedIds);
    return { resolvedIds, unresolvedIds: requestedIds.filter((id) => !resolved.has(id)) };
  }

  private getRow(itemId: string): OutstandingItemRow | undefined {
    return this.db.prepare(baseSelect("AND i.id = ?")).get(itemId) as OutstandingItemRow | undefined;
  }
}
