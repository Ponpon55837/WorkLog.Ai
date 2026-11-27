import type { KnowledgeRecord } from "@work-intelligence/core";
import { t } from "../i18n";

export type TrustCell = "confirmed" | "contradicted";

/** The most cells one trust bar draws; larger counts are scaled down to fit. */
const MAX_TRUST_CELLS = 12;

export function trustCells(confirmed: number, contradicted: number, max = MAX_TRUST_CELLS): TrustCell[] {
  const total = confirmed + contradicted;
  if (total <= 0) return [];
  let confirmedCells = confirmed;
  let contradictedCells = contradicted;
  if (total > max) {
    contradictedCells = contradicted > 0 ? Math.max(1, Math.round((contradicted / total) * max)) : 0;
    confirmedCells = confirmed > 0 ? Math.max(1, max - contradictedCells) : 0;
    contradictedCells = Math.min(contradictedCells, max - confirmedCells);
  }
  return [
    ...Array.from({ length: confirmedCells }, (): TrustCell => "confirmed"),
    ...Array.from({ length: contradictedCells }, (): TrustCell => "contradicted"),
  ];
}

export interface KnowledgeStaleNotes {
  broadAppliesTo: string | null;
  broadChanges: string | null;
}

export function knowledgeStaleNotes(
  item: Pick<KnowledgeRecord, "possiblyStale" | "broadChangesSince">,
): KnowledgeStaleNotes {
  const stale = item.possiblyStale;
  const breadth = stale?.reason === "broad_applies_to" ? stale.appliesToBreadth : undefined;
  return {
    broadAppliesTo: breadth
      ? t("knowledge.broadAppliesToWeakSignal", {
          sessions: breadth.sessions,
          percent: Math.round(breadth.share * 100),
        })
      : null,
    broadChanges:
      item.broadChangesSince && item.broadChangesSince > 0
        ? t("knowledge.broadChangesSince", { count: item.broadChangesSince })
        : null,
  };
}

export function appliesToBreadthNotice(result: {
  warnings?: string[];
  appliesToBreadth?: { share: number; sessions: number; broad: boolean };
}): string | null {
  if (!result.appliesToBreadth?.broad) return null;
  return t("knowledge.appliesToTooBroad", {
    sessions: result.appliesToBreadth.sessions,
    percent: Math.round(result.appliesToBreadth.share * 100),
  });
}
