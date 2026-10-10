import type { PageInfo, ProjectIdSkippedResult, WorkReportPeriod } from "./index.js";

export const ATTENTION_KINDS = [
  "synthesis",
  "backfill",
  "cleanup",
  "decision",
  "knowledge",
  "knowledge_page",
  "outstanding",
  "metadata",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export type AttentionReason =
  "failed" | "pending" | "processing" | "review" | "stale" | "requested" | "new_data" | "open" | "missing";

export interface AttentionQuery {
  projectId?: string;
  kind?: AttentionKind;
  view?: "visible" | "suppressed";
  page?: number;
  pageSize?: number;
}

/** A read-only pointer; acting on it always uses the owning domain's existing workflow. */
export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  sourceId: string;
  projectId?: string;
  projectName?: string;
  title: string;
  reason: AttentionReason;
  count?: number;
  updatedAt: string;
  sourceRevision: string;
  preference?: AttentionPreference;
  target: {
    kind: AttentionKind;
    sourceId: string;
    projectId?: string;
    period?: WorkReportPeriod;
    from?: string;
    to?: string;
    slug?: string;
  };
}

export interface AttentionCoverage {
  kind: AttentionKind;
  state: "complete" | "partial" | "failed";
  /** Exact matching total, or null when only a bounded sample was examined. */
  total: number | null;
  examined: number;
  available: number;
}

export interface AttentionList {
  outcome: "attention";
  items: AttentionItem[];
  groups: AttentionCoverage[];
  /** Lower bound when total is null; never means everything has been checked. */
  minimumTotal: number;
  total: number | null;
  pageInfo: PageInfo;
  /** Suppressed pointers in the examined window; source totals remain unchanged. */
  suppressedCount: number;
}

export type AttentionResult = AttentionList | ProjectIdSkippedResult;

export interface AttentionPreference {
  revision: number;
  state: "visible" | "hidden" | "snoozed";
  snoozedUntil?: string;
}
export interface UpdateAttentionPreference {
  projectId: string;
  kind: AttentionKind;
  sourceId: string;
  sourceRevision: string;
  expectedRevision: number;
  action: "snooze" | "hide" | "restore";
}
export type AttentionPreferenceResult =
  { outcome: "attention_preference"; preference: AttentionPreference } | ProjectIdSkippedResult;
