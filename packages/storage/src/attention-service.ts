import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  ATTENTION_KINDS,
  type AttentionCoverage,
  type AttentionItem,
  type AttentionKind,
  type AttentionQuery,
  type AttentionReason,
  type AttentionResult,
  type KnowledgePageRecord,
  type KnowledgeSearchResult,
  type PolicyDecision,
} from "@work-intelligence/core";
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
): AttentionItem {
  const project = row.project_id ? { projectId: row.project_id, projectName: row.project_name ?? undefined } : {};
  const target = { kind, sourceId: row.source_id, ...(row.project_id ? { projectId: row.project_id } : {}), ...extra };
  const id = JSON.stringify([kind, row.project_id, row.source_id]);
  const sourceRevision = createHash("sha256")
    .update(JSON.stringify([id, row.reason, row.count, row.updated_at, target]))
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
    const pageInfo = createPageInfo(query.page, query.pageSize, items.length, 50);
    const minimumTotal = groups.reduce(
      (sum, group) => sum + (group.total ?? items.filter((item) => item.kind === group.kind).length),
      0,
    );
    return {
      outcome: "attention",
      items: items.slice((pageInfo.page - 1) * pageInfo.pageSize, pageInfo.page * pageInfo.pageSize),
      groups,
      minimumTotal,
      total: groups.every((group) => group.total !== null) ? minimumTotal : null,
      pageInfo,
    };
  }

  private readKind(kind: AttentionKind, projectId?: string): { items: AttentionItem[]; coverage: AttentionCoverage } {
    if (kind === "knowledge") {
      const result = this.dependencies.knowledge(projectId);
      if (result.outcome !== "knowledge") throw new Error("Unavailable source");
      const items = result.items
        .filter((item) => item.review || item.possiblyStale)
        .map((item) =>
          pointer(kind, {
            source_id: item.id,
            project_id: item.projectId,
            project_name: item.projectName ?? null,
            title: item.title,
            reason: item.review ? "review" : "stale",
            count: item.possiblyStale?.sessionCount ?? 0,
            updated_at: item.review?.at ?? item.possiblyStale?.completedAt ?? item.updatedAt,
          }),
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
        r.requested_at AS updated_at, COUNT(*) OVER () AS total FROM outstanding_cleanup_requests r JOIN projects p ON p.id = r.project_id LEFT JOIN (SELECT request_id, COUNT(*) AS count FROM outstanding_cleanup_proposals WHERE review_status = 'pending' GROUP BY request_id) proposals ON proposals.request_id = r.id
        WHERE p.status = 'tracked' AND r.status = 'awaiting_review' ${scope} ORDER BY updated_at DESC, source_id DESC LIMIT ?`;
    } else {
      const pending = kind === "outstanding";
      const condition = pending
        ? "o.status = 'pending'"
        : "(s.changed_files_confirmed = 0 OR s.verification_json IS NULL)";
      const source = pending ? "outstanding_items o JOIN sessions s ON s.id = o.source_session_id" : "sessions s";
      sql = `WITH counts AS (SELECT p.id AS project_id, p.name AS project_name, COUNT(*) AS count, MAX(s.completed_at) AS updated_at
        FROM ${source} JOIN projects p ON p.id = s.project_id WHERE p.status = 'tracked' AND s.voided_at IS NULL ${scope} AND ${condition}
        GROUP BY p.id) SELECT project_id AS source_id, *, '' AS title, '${pending ? "open" : "missing"}' AS reason, COUNT(*) OVER () AS total FROM counts ORDER BY updated_at DESC, source_id DESC LIMIT ?`;
    }
    return this.db.prepare(sql).all(...args, SOURCE_LIMIT) as PointerRow[];
  }
}
