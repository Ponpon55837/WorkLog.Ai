import type { ReportSummary, ReportSummaryBlock } from "./index.js";

export const REPORT_SECTION_KEYS = [
  "themes",
  "highlights",
  "verification",
  "comparison",
  "risks",
  "decisions",
  "nextSteps",
] as const;
export type ReportSectionKey = (typeof REPORT_SECTION_KEYS)[number];
export interface ReportPresentationState {
  pinned: ReportSectionKey[];
  hidden: ReportSectionKey[];
  overrides: Array<{ section: ReportSectionKey; ordinal: number; title: string; detail: string }>;
}
export interface ReportPresentation {
  outcome: "report_presentation";
  summaryId: string;
  revision: number;
  state: ReportPresentationState;
  updatedAt?: string;
  history: Array<{ revision: number; createdAt: string; actor: "web" }>;
}
export interface ProjectedReportSection {
  key: ReportSectionKey;
  blocks: Array<ReportSummaryBlock & { ordinal: number; edited: boolean }>;
  pinned: boolean;
}

export function cloneReportPresentationState(state: ReportPresentationState): ReportPresentationState {
  return {
    pinned: [...state.pinned],
    hidden: [...state.hidden],
    overrides: state.overrides.map((item) => ({ ...item })),
  };
}

export function emptyReportPresentation(): ReportPresentationState {
  return { pinned: [], hidden: [], overrides: [] };
}

/** Both rendering and copy use this immutable projection, with base ordinals and original citations. */
export function projectReportSummary(summary: ReportSummary, state: ReportPresentationState): ProjectedReportSection[] {
  const hidden = new Set(state.hidden),
    pinned = new Set(state.pinned);
  const overrides = new Map(state.overrides.map((item) => [`${item.section}:${item.ordinal}`, item]));
  return [...state.pinned, ...REPORT_SECTION_KEYS.filter((key) => !pinned.has(key))]
    .filter((key) => !hidden.has(key) && summary[key].length > 0)
    .map((key) => ({
      key,
      pinned: pinned.has(key),
      blocks: summary[key].map((block, ordinal) => {
        const override = overrides.get(`${key}:${ordinal}`);
        return {
          ...block,
          title: override?.title ?? block.title,
          detail: override?.detail ?? block.detail,
          sourceSessionIds: [...block.sourceSessionIds],
          ordinal,
          edited: Boolean(override),
        };
      }),
    }));
}
