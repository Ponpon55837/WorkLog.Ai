import type { RouteLocationRaw } from "vue-router";
import type { AttentionItem } from "@work-intelligence/core";
import type { MessageKey } from "../i18n";

export const attentionKindKeys = {
  synthesis: "attention.kinds.synthesis",
  backfill: "attention.kinds.backfill",
  cleanup: "attention.kinds.cleanup",
  decision: "attention.kinds.decision",
  knowledge: "attention.kinds.knowledge",
  knowledge_page: "attention.kinds.knowledgePage",
  outstanding: "attention.kinds.outstanding",
  metadata: "attention.kinds.metadata",
} as const satisfies Record<AttentionItem["kind"], MessageKey>;
export const attentionReasonKeys = {
  failed: "attention.reasons.failed",
  pending: "attention.reasons.pending",
  processing: "attention.reasons.processing",
  review: "attention.reasons.review",
  stale: "attention.reasons.stale",
  requested: "attention.reasons.requested",
  new_data: "attention.reasons.newData",
  open: "attention.reasons.open",
  missing: "attention.reasons.missing",
} as const satisfies Record<AttentionItem["reason"], MessageKey>;

/** Maps a known domain pointer to fixed application routes, never a source-provided URL. */
export function attentionRoute(item: AttentionItem): RouteLocationRaw {
  const target = item.target;
  const project = target.projectId ? { project: target.projectId } : {};
  switch (target.kind) {
    case "synthesis":
      return {
        name: "reports",
        query: {
          period: target.period,
          date: target.from,
          ...(target.period === "custom" ? { from: target.from, to: target.to } : {}),
          ...project,
        },
      };
    case "backfill":
      return { name: "projects", params: { tab: "backfill" }, query: { ...project, backfillRequest: target.sourceId } };
    case "metadata":
      return { name: "projects", params: { tab: "backfill" }, query: project };
    case "decision":
      return { name: "knowledge", params: { tab: "decisions" }, query: project };
    case "knowledge":
      return { name: "knowledge", params: { tab: "list" }, query: { ...project, knowledge: target.sourceId } };
    case "knowledge_page":
      return { name: "knowledge", params: { tab: "pages" }, query: { ...project, knowledgePage: target.sourceId } };
    case "cleanup":
      return {
        name: "sessions",
        params: { tab: "outstanding" },
        query: { itemProject: target.projectId, cleanup: "review", cleanupRequest: target.sourceId },
      };
    case "outstanding":
      return { name: "sessions", params: { tab: "outstanding" }, query: { itemProject: target.projectId } };
  }
}
