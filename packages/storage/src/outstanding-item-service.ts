import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BatchUpdateOutstandingItemStatusInput,
  BatchUpdateOutstandingItemStatusResult,
  FinalizeSessionInput,
  ListOutstandingItemsInput,
  OutstandingItem,
  OutstandingItemClosedBy,
  OutstandingItemEventSource,
  OutstandingItemListQueryResult,
  OutstandingItemRejectionCode,
  OutstandingItemRejectionReason,
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
  identifiersIn,
  issueSpansIn,
  rankRelatedPendingWithin,
  RELATED_PENDING_UNIT_LIMIT,
  sharesIdentifier,
  spansOverlap,
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
  excludeItemIds?: readonly string[];
  identifierText?: string;
  nextSteps?: readonly string[];
}

export type RelatedPendingItem = OutstandingItem & { possiblyDone?: true; possibleDuplicateOf?: number };

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
  closed_by?: OutstandingItemClosedBy | null;
  created_at: string;
  updated_at: string;
};

type OutstandingWarnings = NonNullable<
  Extract<ResolveOutstandingItemsResult, { outcome: "outstanding_items_resolved" }>["outstandingItemWarnings"]
>;

const FINALIZE_WARNING_MESSAGE = "部分指定項目無效、已處理、跨專案或正在整理待審，因此未標記完成或不再需要，維持原狀。";

interface RejectedRequest {
  unresolvedIds: readonly string[];
  unsupersededIds: readonly string[];
  ambiguous: ReadonlySet<string>;
  hasNextSteps: boolean;
  later?: { actorSessionId: string; actorCompletedAt: string };
}

type RejectionRow = {
  id: string;
  project_id: string;
  status: OutstandingItemStatus;
  source_session_id: string;
  source_voided_at: string | null;
  source_completed_at: string | null;
  held: number;
};

type RelatedPendingRow = OutstandingItemRow & RelatedPendingCandidate;

interface OutstandingItemDependencies {
  checkProjectById(projectId: string): PolicyDecision;
  checkProjectRoot(projectRoot: string): PolicyDecision;
}

const RELATED_PENDING_LIMIT = 5;
const MAX_LEADING_DUPLICATES = 3;
/** About 45 times the largest real project's pending items. */
const RELATED_PENDING_CANDIDATE_LIMIT = 2_000;

/** Web edits record the Session as actor but are a person's decision, so only source = 'agent' counts as the Session. A nextSteps removal by the source Session is always not_needed; its own later completion is a resolve like any other Session's. */
const CLOSED_BY_SQL = `CASE WHEN i.status = 'pending' THEN NULL ELSE (
  SELECT CASE
    WHEN e.cleanup_proposal_id IS NOT NULL THEN 'cleanup_review'
    WHEN e.source = 'migration' THEN 'migration'
    WHEN e.source = 'agent' AND e.actor_session_id IS i.source_session_id AND e.to_status = 'not_needed' THEN 'source_session'
    WHEN e.source = 'agent' THEN 'later_session'
    ELSE 'user' END
  FROM outstanding_item_events e
  WHERE e.item_id = i.id AND e.to_status = i.status
  ORDER BY e.created_at DESC, e.id DESC LIMIT 1) END`;

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
    ...(row.closed_by ? { closedBy: row.closed_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function baseSelect(
  where: string,
  columns = `i.*, p.name AS project_name, s.title AS source_session_title,
                 s.completed_at AS source_session_completed_at, ${CLOSED_BY_SQL} AS closed_by`,
): string {
  return `SELECT ${columns}
          FROM outstanding_items i
          JOIN projects p ON p.id = i.project_id
          JOIN sessions s ON s.id = i.source_session_id AND s.project_id = i.project_id
          WHERE p.status = 'tracked' AND s.voided_at IS NULL ${where}`;
}

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
    const closedBy = [...new Set(input.closedBy ?? [])];
    const where = `${projectId ? "AND i.project_id = ?" : ""} AND i.status = ?
      ${closedBy.length ? `AND (${CLOSED_BY_SQL}) IN (SELECT value FROM json_each(?))` : ""}
      ${input.from ? "AND s.completed_at >= ?" : ""} ${input.to ? "AND s.completed_at < ?" : ""}`;
    const params = [
      ...(projectId ? [projectId] : []),
      status,
      ...(closedBy.length ? [JSON.stringify(closedBy)] : []),
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

  public relatedPending(input: OutstandingItemFocus): { items: RelatedPendingItem[]; total: number; truncated?: true } {
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
    const identifiers = identifiersIn(input.identifierText ?? "");
    const nextStepSpans = (input.nextSteps ?? []).map(issueSpansIn);
    if (
      !terms.length &&
      !paths.length &&
      !sources.length &&
      identifiers.size === 0 &&
      !nextStepSpans.some((spans) => spans.length)
    )
      return { items: [], total: 0 };
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
    // Read once per source Session: copied into every item row, 2,000 rows of a 200 KB list were 400 MB.
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
    const rankedIds = new Set(ranked.map((row) => row.id));
    const possiblyDone = new Set(read.filter((row) => sharesIdentifier(row.text, identifiers)).map((row) => row.id));
    const possibleDuplicateOf = new Map<string, number>();
    if (nextStepSpans.some((spans) => spans.length)) {
      for (const row of read) {
        const spans = issueSpansIn(row.text);
        const index = nextStepSpans.findIndex((stepSpans) => spansOverlap(stepSpans, spans));
        if (index >= 0) possibleDuplicateOf.set(row.id, index);
      }
    }
    const prioritized = possiblyDone.size
      ? [
          ...ranked.filter((row) => possiblyDone.has(row.id)),
          ...read.filter((row) => possiblyDone.has(row.id) && !rankedIds.has(row.id)),
          ...ranked.filter((row) => !possiblyDone.has(row.id)),
        ]
      : ranked;
    const leading = read.filter((row) => possibleDuplicateOf.has(row.id)).slice(0, MAX_LEADING_DUPLICATES);
    const leadingIds = new Set(leading.map((row) => row.id));
    const ordered = leading.length
      ? [...leading, ...prioritized.filter((row) => !leadingIds.has(row.id))]
      : prioritized;
    return {
      items: ordered.slice(0, RELATED_PENDING_LIMIT).map((row) => ({
        ...toOutstandingItem(row),
        ...(possiblyDone.has(row.id) ? { possiblyDone: true as const } : {}),
        ...(possibleDuplicateOf.has(row.id) ? { possibleDuplicateOf: possibleDuplicateOf.get(row.id) } : {}),
      })),
      total: ordered.length,
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
      // Re-read so closedBy reflects the events just appended.
      const fresh = new Map(
        (this.db.prepare(baseSelect(`AND i.id IN (${placeholders})`)).all(...itemIds) as OutstandingItemRow[]).map(
          (row) => [row.id, row],
        ),
      );
      return {
        outcome: "outstanding_items_updated",
        items: itemIds.map((id) => toOutstandingItem(fresh.get(id) ?? byId.get(id)!)),
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

  /** Call inside the caller's transaction. */
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
                   WHERE r.project_id = ? AND r.status = 'pending'
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

  public transitionForFinalize(
    request: Pick<FinalizeSessionInput, "resolvedOutstandingItemIds" | "supersededOutstandingItemIds">,
    projectId: string,
    actorSessionId: string,
    updatedAt: string,
  ): { resolvedIds: string[]; supersededIds: string[]; warnings?: OutstandingWarnings } {
    const resolution = this.resolvePendingInTransaction(
      request.resolvedOutstandingItemIds ?? [],
      projectId,
      actorSessionId,
      updatedAt,
    );
    const supersession = this.supersedePendingInTransaction(
      request.supersededOutstandingItemIds ?? [],
      projectId,
      actorSessionId,
      updatedAt,
    );
    const { unresolvedIds } = resolution;
    const unsupersededIds = supersession.unresolvedIds;
    const rejected = unresolvedIds.length > 0 || unsupersededIds.length > 0;
    return {
      resolvedIds: resolution.resolvedIds,
      supersededIds: supersession.resolvedIds,
      ...(rejected
        ? {
            warnings: {
              unresolvedIds,
              unsupersededIds,
              message: FINALIZE_WARNING_MESSAGE,
              reasons: this.explainRejections(projectId, {
                unresolvedIds,
                unsupersededIds,
                ambiguous: new Set(),
                hasNextSteps: true,
              }),
            },
          }
        : {}),
    };
  }

  public explainRejections(projectId: string, rejected: RejectedRequest): OutstandingItemRejectionReason[] {
    const ids = [...new Set([...rejected.unresolvedIds, ...rejected.unsupersededIds])];
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT i.id, i.project_id, i.status, i.source_session_id,
                s.voided_at AS source_voided_at, s.completed_at AS source_completed_at,
                EXISTS (
                  SELECT 1 FROM outstanding_cleanup_requests r
                  JOIN outstanding_cleanup_request_items ci ON ci.request_id = r.id AND ci.project_id = r.project_id
                  WHERE r.project_id = i.project_id AND r.status = 'pending'
                    AND ci.item_id = i.id
                ) AS held
         FROM outstanding_items i
         LEFT JOIN sessions s ON s.id = i.source_session_id
         WHERE i.id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(...ids) as RejectionRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const codeFor = (id: string, list: "resolved" | "superseded"): OutstandingItemRejectionCode | undefined => {
      if (rejected.ambiguous.has(id)) return "both_lists";
      if (list === "superseded" && !rejected.hasNextSteps) return "no_next_steps";
      const row = byId.get(id);
      if (!row) return "not_found";
      if (row.project_id !== projectId) return "other_project";
      if (row.status !== "pending") return "not_pending";
      if (row.source_voided_at) return "source_voided";
      if (row.held) return "held_by_cleanup";
      const { later } = rejected;
      if (!later) return undefined;
      const own = row.source_session_id === later.actorSessionId;
      const notEarlier = own ? list === "superseded" : (row.source_completed_at ?? "") >= later.actorCompletedAt;
      return notEarlier ? "not_earlier" : undefined;
    };
    const reasons: OutstandingItemRejectionReason[] = [];
    for (const [list, listIds] of [
      ["resolved", rejected.unresolvedIds],
      ["superseded", rejected.unsupersededIds],
    ] as const) {
      for (const id of listIds) {
        const code = codeFor(id, list);
        if (code) reasons.push({ id, list, code });
      }
    }
    return reasons;
  }

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
      // Replays: what this Session already moved is reported as applied, not as a warning.
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
        { ...later, allowOwn: true },
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
      const reasons = this.explainRejections(actor.project_id, {
        unresolvedIds,
        unsupersededIds,
        ambiguous,
        hasNextSteps: nextStepCount > 0,
        later: { actorSessionId: sessionId, actorCompletedAt: actor.completed_at },
      });
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
                reasons,
                message:
                  "部分指定項目無效、已處理、跨專案、來源 Session 已作廢、正在整理待審、來源不早於本 Session、要取代本 Session 自己的項目、本 Session 未提供 nextSteps 或同時指定完成與取代，因此維持原狀。",
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
    later?: { actorCompletedAt: string; allowOwn?: boolean },
  ): { resolvedIds: string[]; unresolvedIds: string[] } {
    const requestedIds = [...new Set(itemIds)];
    if (requestedIds.length === 0) return { resolvedIds: [], unresolvedIds: [] };
    const placeholders = requestedIds.map(() => "?").join(", ");
    const laterSql = later
      ? later.allowOwn
        ? "AND (s.id = ? OR s.completed_at < ?)"
        : "AND s.id <> ? AND s.completed_at < ?"
      : "";
    const laterParams = later ? [actorSessionId, later.actorCompletedAt] : [];
    const pending = this.db
      .prepare(
        `SELECT i.id FROM outstanding_items i
         JOIN sessions s ON s.id = i.source_session_id AND s.project_id = i.project_id
         WHERE i.project_id = ? AND i.status = 'pending' AND s.voided_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM outstanding_cleanup_requests r
             JOIN outstanding_cleanup_request_items ci ON ci.request_id = r.id AND ci.project_id = r.project_id
             WHERE r.project_id = i.project_id AND r.status = 'pending'
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
