import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  ATTENTION_KINDS,
  type AttentionCoverage,
  type AttentionItem,
  type AttentionKind,
  type AttentionQuery,
  type AttentionReason,
  type AttentionResult,
  type AttentionPreference,
  type AttentionPreferenceResult,
  type UpdateAttentionPreference,
  type KnowledgePageRecord,
  type KnowledgeSearchResult,
  type PolicyDecision,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { runImmediateTransaction } from "./sqlite-transaction.js";
import { createPageInfo } from "./pagination.js";

export interface AttentionDependencies {
  checkProjectById(projectId: string): PolicyDecision;
  refreshRequests(kind: "synthesis" | "backfill"): void;
  knowledge(projectId?: string): KnowledgeSearchResult;
  pages(projectId?: string): { items: KnowledgePageRecord[]; total: number };
}

type PointerRow = {
  source_id: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  reason: AttentionReason;
  count: number;
  updated_at: string;
  total: number;
  period?: AttentionItem["target"]["period"];
  range_from?: string;
  range_to?: string;
  fingerprint?: string;
};
type PreferenceRow = {
  project_id: string;
  kind: AttentionKind;
  source_id: string;
  source_revision: string;
  state: AttentionPreference["state"];
  snoozed_until: string | null;
  revision: number;
};
const SOURCE_LIMIT = 200;
const PRIORITY: Record<AttentionReason, number> = {
  failed: 0,
  review: 0,
  pending: 1,
  stale: 2,
  requested: 3,
  new_data: 4,
  missing: 4,
  open: 5,
  processing: 6,
};

function pointer(
  kind: AttentionKind,
  row: Omit<PointerRow, "total">,
  extra: Partial<AttentionItem["target"]> = {},
  fingerprint?: unknown,
): AttentionItem {
  const project = row.project_id ? { projectId: row.project_id, projectName: row.project_name ?? undefined } : {};
  const target = { kind, sourceId: row.source_id, ...(row.project_id ? { projectId: row.project_id } : {}), ...extra };
  const id = JSON.stringify([kind, row.project_id, row.source_id]);
  const sourceRevision = createHash("sha256")
    .update(JSON.stringify([id, row.reason, row.count, row.updated_at, target, fingerprint ?? row.fingerprint]))
    .digest("hex");
  return {
    id,
    kind,
    sourceId: row.source_id,
    ...project,
    title: row.title.slice(0, 500),
    reason: row.reason,
    ...(row.count > 0 ? { count: row.count } : {}),
    updatedAt: row.updated_at,
    sourceRevision,
    target,
  };
}

/** A stale intent never overwrites another window or hides an unverified source. */
export class AttentionPreferenceError extends Error {
  public constructor(public readonly code: "conflict" | "not_found") {
    super(code);
    this.name = "AttentionPreferenceError";
  }
}

/** Aggregates bounded pointers without resolving or duplicating their authoritative domain state. */
export class AttentionService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: AttentionDependencies,
  ) {}

  public list(query: AttentionQuery = {}): AttentionResult {
    if (query.projectId) {
      const decision = this.dependencies.checkProjectById(query.projectId);
      if (!decision.allowed)
        return {
          outcome: "skipped",
          projectId: query.projectId,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
    }
    const items: AttentionItem[] = [];
    const groups: AttentionCoverage[] = [];
    for (const kind of query.kind ? [query.kind] : ATTENTION_KINDS) {
      try {
        const result = this.readKind(kind, query.projectId);
        items.push(...result.items);
        groups.push(result.coverage);
      } catch {
        // A failed source is visible as unknown coverage, never a healthy empty queue.
        groups.push({ kind, state: "failed", total: null, examined: 0, available: 0 });
      }
    }
    items.sort(
      (a, b) =>
        PRIORITY[a.reason] - PRIORITY[b.reason] || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    // One batch read for all examined pointers, including a global view; no per-row SQL.
    const preferences = items.length
      ? (this.db
          .prepare(
            `SELECT a.* FROM attention_preferences a JOIN projects p ON p.id=a.project_id
      WHERE p.status='tracked' AND (a.project_id,a.kind,a.source_id) IN
      (SELECT json_extract(value,'$[1]'),json_extract(value,'$[0]'),json_extract(value,'$[2]') FROM json_each(?))`,
          )
          .all(
            JSON.stringify(
              items.filter((item) => item.projectId).map((item) => [item.kind, item.projectId, item.sourceId]),
            ),
          ) as PreferenceRow[])
      : [];
    const byId = new Map(preferences.map((row) => [JSON.stringify([row.kind, row.project_id, row.source_id]), row]));
    const currentTime = Date.now();
    for (const item of items) {
      if (!item.projectId) continue;
      const stored = byId.get(item.id);
      const applies =
        stored?.source_revision === item.sourceRevision &&
        (stored.state === "hidden" ||
          (stored.state === "snoozed" && Date.parse(stored.snoozed_until ?? "") > currentTime));
      item.preference = {
        revision: stored?.revision ?? 0,
        state: applies ? stored.state : "visible",
        ...(applies && stored.snoozed_until ? { snoozedUntil: stored.snoozed_until } : {}),
      };
    }
    const suppressedCount = items.filter((item) => item.preference && item.preference.state !== "visible").length;
    const visibleItems = items.filter((item) =>
      query.view === "suppressed"
        ? item.preference && item.preference.state !== "visible"
        : !item.preference || item.preference.state === "visible",
    );
    const pageInfo = createPageInfo(query.page, query.pageSize, visibleItems.length, 50);
    const minimumTotal = groups.reduce(
      (sum, group) => sum + (group.total ?? items.filter((item) => item.kind === group.kind).length),
      0,
    );
    return {
      outcome: "attention",
      items: visibleItems.slice((pageInfo.page - 1) * pageInfo.pageSize, pageInfo.page * pageInfo.pageSize),
      suppressedCount,
      groups,
      minimumTotal,
      total: groups.every((group) => group.total !== null) ? minimumTotal : null,
      pageInfo,
    };
  }

  public updatePreference(input: UpdateAttentionPreference): AttentionPreferenceResult {
    return runImmediateTransaction(this.db, () => {
      const decision = this.dependencies.checkProjectById(input.projectId);
      if (!decision.allowed)
        return {
          outcome: "skipped",
          projectId: input.projectId,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      const item = this.readKind(input.kind, input.projectId).items.find(
        (candidate) => candidate.sourceId === input.sourceId && candidate.projectId === input.projectId,
      );
      if (!item) throw new AttentionPreferenceError("not_found");
      if (item.sourceRevision !== input.sourceRevision) throw new AttentionPreferenceError("conflict");
      const stored = this.db
        .prepare("SELECT revision FROM attention_preferences WHERE project_id=? AND kind=? AND source_id=?")
        .get(input.projectId, input.kind, input.sourceId) as { revision: number } | undefined;
      if ((stored?.revision ?? 0) !== input.expectedRevision) throw new AttentionPreferenceError("conflict");
      const revision = (stored?.revision ?? 0) + 1;
      const state = input.action === "hide" ? "hidden" : input.action === "snooze" ? "snoozed" : "visible";
      const updatedAt = nowIso();
      const until =
        state === "snoozed" ? new Date(Date.parse(updatedAt) + 7 * 24 * 60 * 60 * 1000).toISOString() : null;
      this.db
        .prepare(
          `INSERT INTO attention_preferences (id,project_id,kind,source_id,source_revision,state,snoozed_until,revision,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,kind,source_id) DO UPDATE SET
        source_revision=excluded.source_revision,state=excluded.state,snoozed_until=excluded.snoozed_until,revision=excluded.revision,updated_at=excluded.updated_at`,
        )
        .run(
          randomUUID(),
          input.projectId,
          input.kind,
          input.sourceId,
          input.sourceRevision,
          state,
          until,
          revision,
          updatedAt,
        );
      return {
        outcome: "attention_preference",
        preference: { revision, state, ...(until ? { snoozedUntil: until } : {}) },
      };
    });
  }

  private readKind(kind: AttentionKind, projectId?: string): { items: AttentionItem[]; coverage: AttentionCoverage } {
    if (kind === "knowledge") {
      const result = this.dependencies.knowledge(projectId);
      if (result.outcome !== "knowledge") throw new Error("Unavailable source");
      const items = result.items
        .filter((item) => item.review || item.possiblyStale)
        .map((item) =>
          pointer(
            kind,
            {
              source_id: item.id,
              project_id: item.projectId,
              project_name: item.projectName ?? null,
              title: item.title,
              reason: item.review ? "review" : "stale",
              count: item.possiblyStale?.sessionCount ?? 0,
              updated_at: item.review?.at ?? item.possiblyStale?.completedAt ?? item.updatedAt,
            },
            {},
            [item.updatedAt, item.review, item.possiblyStale],
          ),
        );
      const complete = result.pageInfo.total <= result.items.length;
      return {
        items,
        coverage: {
          kind,
          state: complete ? "complete" : "partial",
          total: complete ? items.length : null,
          examined: result.items.length,
          available: result.pageInfo.total,
        },
      };
    }
    if (kind === "knowledge_page") {
      const result = this.dependencies.pages(projectId);
      const revisions = this.db
        .prepare(
          `SELECT kp.id,json_group_array(json_array(s.id,s.updated_at) ORDER BY s.id) AS fingerprint
        FROM knowledge_pages kp JOIN projects p ON p.id=kp.project_id AND p.status='tracked'
        LEFT JOIN sessions s ON s.project_id=kp.project_id AND s.voided_at IS NULL AND s.completed_at>
          COALESCE((SELECT completed_at FROM sessions WHERE id=kp.checked_through_session_id),kp.sourced_through,'')
        WHERE kp.id IN (SELECT value FROM json_each(?)) GROUP BY kp.id`,
        )
        .all(JSON.stringify(result.items.map((page) => page.id))) as Array<{ id: string; fingerprint: string }>;
      const pageFingerprints = new Map(revisions.map((row) => [row.id, row.fingerprint]));
      const items = result.items
        .filter((page) => page.needsReview || page.updateRequestedAt || page.newSessionCount >= 3)
        .map((page) =>
          pointer(
            kind,
            {
              source_id: page.id,
              project_id: page.projectId,
              project_name: null,
              title: page.title,
              reason: page.needsReview ? "review" : page.updateRequestedAt ? "requested" : "new_data",
              count: page.newSessionCount,
              updated_at: page.updateRequestedAt ?? page.updatedAt,
            },
            { slug: page.slug },
            [page.version, page.updatedAt, page.checkedThrough, page.reviewSections, pageFingerprints.get(page.id)],
          ),
        );
      const complete = result.total <= result.items.length;
      return {
        items,
        coverage: {
          kind,
          state: complete ? "complete" : "partial",
          total: complete ? items.length : null,
          examined: result.items.length,
          available: result.total,
        },
      };
    }
    const rows = this.readRows(kind, projectId);
    const total = rows[0]?.total ?? 0;
    const items = rows.map((row) =>
      pointer(kind, row, row.period ? { period: row.period, from: row.range_from, to: row.range_to } : {}),
    );
    return {
      items,
      coverage: {
        kind,
        state: total > rows.length ? "partial" : "complete",
        total,
        examined: rows.length,
        available: total,
      },
    };
  }

  private readRows(kind: Exclude<AttentionKind, "knowledge" | "knowledge_page">, projectId?: string): PointerRow[] {
    const scope = projectId ? "AND p.id = ?" : "";
    const args: SQLInputValue[] = projectId ? [projectId] : [];
    let sql: string;
    if (kind === "synthesis" || kind === "backfill") {
      this.dependencies.refreshRequests(kind);
      const table = kind === "synthesis" ? "report_synthesis_requests" : "metadata_backfill_requests";
      const partition =
        kind === "synthesis" ? "scope_type, project_id, period, range_from, range_to" : "scope_type, project_id";
      // Latest completed requests supersede earlier pending ones; global sources are re-gated as a batch in SQL.
      sql = `WITH ranked AS (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY requested_at DESC, id DESC) AS rank FROM ${table} r), eligible AS (
        SELECT r.id AS source_id, r.project_id, p.name AS project_name, '' AS title, r.status AS reason,
          json_array_length(r.source_session_ids_json) AS count, r.requested_at AS updated_at
          ${kind === "synthesis" ? ", r.period, r.range_from, r.range_to" : ""}
        FROM ranked r LEFT JOIN projects p ON p.id = r.project_id
        WHERE r.rank = 1 AND r.status IN ('pending','processing','failed') AND (r.project_id IS NULL OR p.status = 'tracked') ${scope}
          AND NOT EXISTS (SELECT 1 FROM json_each(r.source_session_ids_json) j LEFT JOIN sessions s ON s.id = j.value LEFT JOIN projects sp ON sp.id = s.project_id WHERE s.id IS NULL OR sp.id IS NULL OR sp.status != 'tracked' OR s.voided_at IS NOT NULL OR (r.project_id IS NOT NULL AND s.project_id != r.project_id))
      ) SELECT *, COUNT(*) OVER () AS total FROM eligible ORDER BY updated_at DESC, source_id DESC LIMIT ?`;
    } else if (kind === "decision") {
      sql = `SELECT d.id AS source_id, d.project_id, p.name AS project_name, substr(d.text,1,500) AS title, 'pending' AS reason, 1 AS count, s.completed_at AS updated_at, COUNT(*) OVER () AS total
        FROM session_decisions d JOIN sessions s ON s.id = d.session_id JOIN projects p ON p.id = d.project_id
        WHERE p.status = 'tracked' AND s.voided_at IS NULL AND d.origin = 'agent_autonomous' AND d.review_status = 'pending' ${scope}
        ORDER BY updated_at DESC, source_id DESC LIMIT ?`;
    } else if (kind === "cleanup") {
      sql = `SELECT r.id AS source_id, r.project_id, p.name AS project_name, '' AS title, 'review' AS reason,
        COALESCE(proposals.count, 0) AS count,
        (SELECT json_group_array(json_array(cp.id,cp.created_at) ORDER BY cp.id) FROM outstanding_cleanup_proposals cp WHERE cp.request_id=r.id AND cp.review_status='pending') AS fingerprint,
        r.requested_at AS updated_at, COUNT(*) OVER () AS total FROM outstanding_cleanup_requests r JOIN projects p ON p.id = r.project_id LEFT JOIN (SELECT request_id, COUNT(*) AS count FROM outstanding_cleanup_proposals WHERE review_status = 'pending' GROUP BY request_id) proposals ON proposals.request_id = r.id
        WHERE p.status = 'tracked' AND r.status = 'awaiting_review' ${scope} ORDER BY updated_at DESC, source_id DESC LIMIT ?`;
    } else {
      const pending = kind === "outstanding";
      const condition = pending
        ? "o.status = 'pending'"
        : "(s.changed_files_confirmed = 0 OR s.verification_json IS NULL)";
      const source = pending ? "outstanding_items o JOIN sessions s ON s.id = o.source_session_id" : "sessions s";
      sql = `WITH counts AS (SELECT p.id AS project_id, p.name AS project_name, COUNT(*) AS count, MAX(s.completed_at) AS updated_at,
        ${pending ? "json_group_array(json_array(o.id,o.updated_at) ORDER BY o.id)" : "json_group_array(json_array(s.id,s.changed_files_confirmed,s.verification_json) ORDER BY s.id)"} AS fingerprint
        FROM ${source} JOIN projects p ON p.id = s.project_id WHERE p.status = 'tracked' AND s.voided_at IS NULL ${scope} AND ${condition}
        GROUP BY p.id) SELECT project_id AS source_id, *, '' AS title, '${pending ? "open" : "missing"}' AS reason, COUNT(*) OVER () AS total FROM counts ORDER BY updated_at DESC, source_id DESC LIMIT ?`;
    }
    return this.db.prepare(sql).all(...args, SOURCE_LIMIT) as PointerRow[];
  }
}
