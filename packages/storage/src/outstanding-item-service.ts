import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BatchUpdateOutstandingItemStatusInput,
  BatchUpdateOutstandingItemStatusResult,
  ListOutstandingItemsInput,
  OutstandingItem,
  OutstandingItemEventSource,
  OutstandingItemListQueryResult,
  OutstandingItemSyncSummary,
  ResolveOutstandingItemsInput,
  ResolveOutstandingItemsResult,
  OutstandingItemStatus,
  PolicyDecision,
  UpdateOutstandingItemStatusResult,
} from "@work-intelligence/core";
import { MAX_OUTSTANDING_ITEM_BATCH_SIZE, OUTSTANDING_ITEM_STATUSES } from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import {
  rankRelatedPendingWithin,
  RELATED_PENDING_UNIT_LIMIT,
  type RelatedPendingCandidate,
} from "./outstanding-item-relevance.js";
import { MAX_STORED_CHANGED_FILES_JSON_BYTES } from "./applies-to-match.js";
import { pairRewordedItems } from "./outstanding-item-matching.js";
import { normalizePath, parseQueryWords } from "./search-text.js";
import { createPageInfo } from "./pagination.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

export interface OutstandingItemFocus {
  projectId?: string;
  task?: string;
  paths?: readonly string[];
  sourceSessionIds?: readonly string[];
  excludeSourceSessionId?: string;
  /** Pending items to leave out, so a caller that reports them elsewhere does not spend ranked slots on them. */
  excludeItemIds?: readonly string[];
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

type RelatedPendingRow = OutstandingItemRow & RelatedPendingCandidate;

interface OutstandingItemDependencies {
  checkProjectById(projectId: string): PolicyDecision;
  checkProjectRoot(projectRoot: string): PolicyDecision;
}

const RELATED_PENDING_LIMIT = 5;
/**
 * Pending items one relatedPending call scores at most, after the SQL prefilter. The real database holds 43 pending
 * items in its largest project; this is about 45 times that and bounds what a scope with runaway pending work loads.
 */
const RELATED_PENDING_CANDIDATE_LIMIT = 2_000;

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

  /**
   * Reads the eligible pending items once and scores them in memory, returning at most five pointers. SQL folds the
   * text fields with lower() so term matching keeps SQLite's case rules; paths are normalized once per Session.
   *
   * At most RELATED_PENDING_CANDIDATE_LIMIT items are read, newest source Sessions first; the scorer sorts what it
   * keeps, so below the limit the read order changes nothing. When more items qualify, or scoring them would pass
   * RELATED_PENDING_UNIT_LIMIT (charged before each candidate is scored), `truncated` says so and `total` counts the
   * scored ones only. (A SQL relevance prefilter was measured and left out: on real data it removed few rows
   * and doubled the call's time.)
   */
  public relatedPending(input: OutstandingItemFocus): { items: OutstandingItem[]; total: number; truncated?: true } {
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
    const excludedIds = [...new Set(input.excludeItemIds ?? [])];
    if (!terms.length && !paths.length && !sources.length) return { items: [], total: 0 };
    const candidates = this.db
      .prepare(
        `${baseSelect(
          `AND i.status = 'pending' ${input.projectId ? "AND i.project_id = ?" : ""} AND i.source_session_id <> ?
           ${excludedIds.length ? "AND i.id NOT IN (SELECT value FROM json_each(?))" : ""}`,
          `i.*, p.name AS project_name, s.title AS source_session_title,
           s.completed_at AS source_session_completed_at,
           ${terms.length ? "lower(i.text)" : "''"} AS text_key,
           ${terms.length ? "lower(s.title)" : "''"} AS title_key,
           ${terms.length ? "lower(substr(s.summary, 1, 2000))" : "''"} AS summary_key`,
        )}
         ORDER BY s.completed_at DESC, i.source_session_id DESC, i.position, i.id
         LIMIT ?`,
      )
      .all(
        ...(input.projectId ? [input.projectId] : []),
        input.excludeSourceSessionId ?? "",
        ...(excludedIds.length ? [JSON.stringify(excludedIds)] : []),
        RELATED_PENDING_CANDIDATE_LIMIT + 1,
      ) as Array<Omit<RelatedPendingRow, "changed_files_json">>;
    const overLimit = candidates.length > RELATED_PENDING_CANDIDATE_LIMIT;
    const read = overLimit ? candidates.slice(0, -1) : candidates;
    // Changed files are read once per source Session (they were copied into every item row: 2,000 rows of a
    // 200 KB list were 400 MB), only when paths are queried, and only within the stored-list load bound.
    const filesBySession = new Map<string, string | null>();
    if (paths.length > 0 && read.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT id, CASE WHEN octet_length(changed_files_json) <= ${MAX_STORED_CHANGED_FILES_JSON_BYTES}
                           THEN changed_files_json END AS changed_files_json
           FROM sessions WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify([...new Set(read.map((row) => row.source_session_id))])) as Array<{
        id: string;
        changed_files_json: string | null;
      }>;
      for (const row of rows) filesBySession.set(row.id, row.changed_files_json);
    }
    const overBound = [...filesBySession.values()].some((json) => json === null);
    const scoring = read.map((row) => ({
      ...row,
      changed_files_json: filesBySession.get(row.source_session_id) ?? "[]",
    }));
    const { ranked, exhausted } = rankRelatedPendingWithin(
      scoring,
      { terms, paths, sources },
      RELATED_PENDING_UNIT_LIMIT,
    );
    const truncated = overLimit || exhausted || overBound;
    return {
      items: ranked.slice(0, RELATED_PENDING_LIMIT).map(toOutstandingItem),
      total: ranked.length,
      ...(truncated ? { truncated: true as const } : {}),
    };
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

  /**
   * Synchronizes the compatibility nextSteps array; call inside its caller's transaction. Entries keep an item's
   * identity by exact text first, then by a close rewording of a still-pending item (see pairRewordedItems): the item
   * text mirrors its source Session's nextSteps, whose earlier versions stay in session_work_summary_updates, so a
   * reworded item is updated in place without a status event.
   */
  public syncForSessionInTransaction(
    sessionId: string,
    projectId: string,
    nextSteps: readonly string[],
    source: Exclude<OutstandingItemEventSource, "migration">,
    actorSessionId: string,
    updatedAt: string,
  ): OutstandingItemSyncSummary {
    const existing = this.db
      .prepare(
        "SELECT id, position, text, status FROM outstanding_items WHERE source_session_id = ? ORDER BY position, id",
      )
      .all(sessionId) as Array<{ id: string; position: number; text: string; status: OutstandingItemStatus }>;
    // An Agent's compatibility-array edit must not close obligations awaiting human cleanup review.
    const heldIds =
      source === "agent" && existing.some((row) => row.status === "pending")
        ? new Set(
            (
              this.db
                .prepare(
                  `SELECT ci.item_id FROM outstanding_cleanup_requests r
                   JOIN outstanding_cleanup_request_items ci ON ci.request_id = r.id AND ci.project_id = r.project_id
                   WHERE r.project_id = ? AND r.status IN ('pending', 'awaiting_review')
                     AND ci.source_session_id = ?`,
                )
                .all(projectId, sessionId) as Array<{ item_id: string }>
            ).map((row) => row.item_id),
          )
        : new Set<string>();
    const byText = new Map<string, typeof existing>();
    for (const row of existing) {
      const queue = byText.get(row.text) ?? [];
      queue.push(row);
      byText.set(row.text, queue);
    }
    const updatePosition = this.db.prepare("UPDATE outstanding_items SET position = ?, updated_at = ? WHERE id = ?");
    const updateReworded = this.db.prepare(
      "UPDATE outstanding_items SET text = ?, position = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    );
    const insert = this.db.prepare(
      `INSERT INTO outstanding_items
         (id, source_session_id, project_id, position, text, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    const summary: OutstandingItemSyncSummary = { created: 0, retained: 0, reworded: 0, closed: 0 };
    const retained = new Set<string>();
    const unmatched: Array<{ index: number; text: string }> = [];
    nextSteps.forEach((text, position) => {
      const previous = byText.get(text)?.shift();
      if (previous) {
        retained.add(previous.id);
        summary.retained += 1;
        if (previous.position !== position) updatePosition.run(position, updatedAt, previous.id);
        return;
      }
      unmatched.push({ index: position, text });
    });
    const rewordCandidates = existing.filter(
      (row) => !retained.has(row.id) && row.status === "pending" && !heldIds.has(row.id),
    );
    const paired = new Set<number>();
    for (const pair of pairRewordedItems(rewordCandidates, unmatched)) {
      const text = nextSteps[pair.index]!;
      updateReworded.run(text, pair.index, updatedAt, pair.id);
      retained.add(pair.id);
      paired.add(pair.index);
      summary.reworded += 1;
    }
    for (const { index, text } of unmatched) {
      if (paired.has(index)) continue;
      const id = randomUUID();
      insert.run(id, sessionId, projectId, index, text, updatedAt, updatedAt);
      appendEvent(this.db, id, projectId, null, "pending", source, actorSessionId, updatedAt);
      summary.created += 1;
    }
    const markNotNeeded = this.db.prepare(
      "UPDATE outstanding_items SET status = 'not_needed', updated_at = ? WHERE id = ? AND status = 'pending'",
    );
    for (const row of existing) {
      if (retained.has(row.id) || heldIds.has(row.id) || row.status !== "pending") continue;
      markNotNeeded.run(updatedAt, row.id);
      appendEvent(this.db, row.id, projectId, "pending", "not_needed", source, actorSessionId, updatedAt);
      summary.closed += 1;
    }
    return summary;
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

  /**
   * Closes pending items that a finalized Session's later work directly verified. Everything is re-checked inside one
   * transaction; items that fail a rule stay pending and are reported as warnings.
   */
  public resolveForSession(input: ResolveOutstandingItemsInput): ResolveOutstandingItemsResult {
    const { sessionId } = input;
    const projectRow = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId) as
      { project_id: string } | undefined;
    if (!projectRow) return { outcome: "not_found", sessionId };
    const policy = this.dependencies.checkProjectById(projectRow.project_id);
    if (!policy.allowed || !policy.project) {
      return {
        outcome: "skipped",
        sessionId,
        projectStatus: policy.projectStatus,
        reason: policy.reason ?? "Project recording is not enabled.",
      };
    }
    return runImmediateTransaction(this.db, (): ResolveOutstandingItemsResult => {
      const actor = this.db
        .prepare("SELECT project_id, status, completed_at, voided_at, work_summary_json FROM sessions WHERE id = ?")
        .get(sessionId) as
        | {
            project_id: string;
            status: string;
            completed_at: string;
            voided_at: string | null;
            work_summary_json: string | null;
          }
        | undefined;
      if (!actor) return { outcome: "not_found", sessionId };
      const current = this.dependencies.checkProjectById(actor.project_id);
      if (!current.allowed || !current.project) {
        return {
          outcome: "skipped",
          sessionId,
          projectStatus: current.projectStatus,
          reason: current.reason ?? "Project recording is not enabled.",
        };
      }
      if (actor.voided_at) {
        return {
          outcome: "skipped",
          sessionId,
          projectStatus: current.projectStatus,
          reason: "已作廢的 Session 不可結案未結項；請先還原。",
        };
      }
      if (actor.status !== "finalized") {
        return {
          outcome: "skipped",
          sessionId,
          projectStatus: current.projectStatus,
          reason: "Session 尚未完成 finalize。",
        };
      }
      const resolvedRequested = input.resolvedOutstandingItemIds ?? [];
      const supersededRequested = input.supersededOutstandingItemIds ?? [];
      const supersededSet = new Set(supersededRequested);
      const ambiguous = new Set(resolvedRequested.filter((id) => supersededSet.has(id)));
      // Replays: what this Session already moved is reported as applied, not as a warning (one query per status).
      const completedBefore = new Set(this.transitionedByActorSession(sessionId, "completed"));
      const notNeededBefore = new Set(this.transitionedByActorSession(sessionId, "not_needed"));
      const appliedResolved = resolvedRequested.filter((id) => !ambiguous.has(id) && completedBefore.has(id));
      const appliedSuperseded = supersededRequested.filter((id) => !ambiguous.has(id) && notNeededBefore.has(id));
      let nextStepCount: number;
      try {
        const parsed = JSON.parse(actor.work_summary_json ?? "{}") as { nextSteps?: unknown };
        nextStepCount = Array.isArray(parsed.nextSteps) ? parsed.nextSteps.length : 0;
      } catch {
        nextStepCount = 0;
      }
      const updatedAt = nowIso();
      const later = { actorCompletedAt: actor.completed_at };
      const resolution = this.transitionPendingInTransaction(
        resolvedRequested.filter((id) => !ambiguous.has(id) && !completedBefore.has(id)),
        actor.project_id,
        sessionId,
        updatedAt,
        "completed",
        later,
      );
      const supersession = this.transitionPendingInTransaction(
        nextStepCount > 0 ? supersededRequested.filter((id) => !ambiguous.has(id) && !notNeededBefore.has(id)) : [],
        actor.project_id,
        sessionId,
        updatedAt,
        "not_needed",
        later,
      );
      const unresolvedIds = [...new Set([...resolution.unresolvedIds, ...ambiguous])];
      const unsupersededIds = [
        ...new Set([
          ...supersession.unresolvedIds,
          ...ambiguous,
          ...(nextStepCount > 0
            ? []
            : supersededRequested.filter((id) => !notNeededBefore.has(id) && !ambiguous.has(id))),
        ]),
      ];
      const alreadyAppliedIds = [...new Set([...appliedResolved, ...appliedSuperseded])];
      const changed = resolution.resolvedIds.length + supersession.resolvedIds.length > 0;
      const warned = unresolvedIds.length > 0 || unsupersededIds.length > 0;
      return {
        outcome: "outstanding_items_resolved",
        sessionId,
        resolvedOutstandingItemIds: resolution.resolvedIds,
        supersededOutstandingItemIds: supersession.resolvedIds,
        ...(alreadyAppliedIds.length > 0 ? { alreadyAppliedIds } : {}),
        ...(!changed && !warned && alreadyAppliedIds.length > 0 ? { duplicate: true as const } : {}),
        ...(warned
          ? {
              outstandingItemWarnings: {
                unresolvedIds,
                unsupersededIds,
                message:
                  "部分指定項目無效、已處理、跨專案、來源 Session 已作廢、正在整理待審、來源不早於本 Session、來自本 Session 自己、本 Session 未提供 nextSteps 或同時指定完成與取代，因此維持原狀。",
              },
            }
          : {}),
      };
    });
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
    later?: { actorCompletedAt: string },
  ): { resolvedIds: string[]; unresolvedIds: string[] } {
    const requestedIds = [...new Set(itemIds)];
    if (requestedIds.length === 0) return { resolvedIds: [], unresolvedIds: [] };
    const placeholders = requestedIds.map(() => "?").join(", ");
    // Evidence must be later work by another Session: the source is neither the actor nor completed at/after it.
    const laterSql = later ? "AND s.id <> ? AND s.completed_at < ?" : "";
    const laterParams = later ? [actorSessionId, later.actorCompletedAt] : [];
    const pending = this.db
      .prepare(
        `SELECT i.id FROM outstanding_items i
         JOIN sessions s ON s.id = i.source_session_id AND s.project_id = i.project_id
         WHERE i.project_id = ? AND i.status = 'pending' AND s.voided_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM outstanding_cleanup_requests r
             JOIN outstanding_cleanup_request_items ci ON ci.request_id = r.id AND ci.project_id = r.project_id
             WHERE r.project_id = i.project_id AND r.status IN ('pending', 'awaiting_review')
               AND ci.item_id = i.id
           )
           ${laterSql}
           AND i.id IN (${placeholders})`,
      )
      .all(projectId, ...laterParams, ...requestedIds) as Array<{ id: string }>;
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
    // The selection above already applied the ordering rule inside this same transaction.
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
