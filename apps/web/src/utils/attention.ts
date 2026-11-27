import type { RouteLocationRaw } from "vue-router";
import type { AttentionItem, AttentionKind } from "@work-intelligence/core";
import type { MessageKey } from "../i18n";

export type GroupedAttentionKind = "decision" | "knowledge" | "knowledge_page";
export type AttentionGroup = { id: string; kind: GroupedAttentionKind; projectId: string; items: AttentionItem[] };
type AttentionEntry = { type: "item"; item: AttentionItem } | { type: "group"; group: AttentionGroup };

/** Rows shown before "show all", and Sources previewed when a group opens. */
export const ATTENTION_INITIAL_ROWS = 8;
export const ATTENTION_GROUP_PREVIEW = 3;

/** Kinds whose pointers are single records; the others already stand for a whole project or request. */
const GROUPED_KINDS: readonly AttentionKind[] = ["decision", "knowledge", "knowledge_page"];

function isGroupedKind(kind: AttentionKind): kind is GroupedAttentionKind {
  return GROUPED_KINDS.includes(kind);
}

export const attentionKindKeys = {
  synthesis: "attention.kinds.synthesis",
  backfill: "attention.kinds.backfill",
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
      return { name: "knowledge", params: { tab: "decisions" }, query: { ...project, decision: target.sourceId } };
    case "knowledge":
      return { name: "knowledge", params: { tab: "list" }, query: { ...project, knowledge: target.sourceId } };
    case "knowledge_page":
      return { name: "knowledge", params: { tab: "pages" }, query: { ...project, knowledgePage: target.sourceId } };
    case "outstanding":
      return { name: "sessions", params: { tab: "outstanding" }, query: { itemProject: target.projectId } };
  }
}

/** The list page that holds a whole group, without pointing at one record. */
export function attentionGroupRoute(group: AttentionGroup): RouteLocationRaw {
  const query = { project: group.projectId };
  if (group.kind === "decision") return { name: "knowledge", params: { tab: "decisions" }, query };
  if (group.kind === "knowledge_page") return { name: "knowledge", params: { tab: "pages" }, query };
  return { name: "knowledge", params: { tab: "list" }, query };
}

/** Folds two or more pointers of one kind and project into one entry, placed where the first of them sat. */
export function groupAttentionItems(items: readonly AttentionItem[]): AttentionEntry[] {
  const members = new Map<string, AttentionItem[]>();
  for (const item of items) {
    if (!item.projectId || !isGroupedKind(item.kind)) continue;
    const key = `${item.kind}:${item.projectId}`;
    members.set(key, [...(members.get(key) ?? []), item]);
  }
  const entries: AttentionEntry[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}:${item.projectId}`;
    const group = members.get(key);
    if (!item.projectId || !isGroupedKind(item.kind) || !group || group.length < 2) {
      entries.push({ type: "item", item });
    } else if (!placed.has(key)) {
      placed.add(key);
      entries.push({ type: "group", group: { id: key, kind: item.kind, projectId: item.projectId, items: group } });
    }
  }
  return entries;
}

/** A decision is waiting for the Agent when its project has an open review request made after the Session finished. */
export function isWaitingForAgent(item: AttentionItem, requestedAtByProject: ReadonlyMap<string, string>): boolean {
  const requestedAt = item.projectId ? requestedAtByProject.get(item.projectId) : undefined;
  return item.kind === "decision" && requestedAt !== undefined && Date.parse(item.updatedAt) <= Date.parse(requestedAt);
}
