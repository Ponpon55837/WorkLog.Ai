import { describe, expect, it } from "vitest";
import type { ReportSummary } from "../../packages/core/src/index.js";
import {
  cloneReportPresentationState,
  emptyReportPresentation,
  projectReportSummary,
} from "../../packages/core/src/report-presentation.js";

describe("immutable report presentation", () => {
  it("keeps original ordinals and citations while pinning, hiding and editing", () => {
    const block = { title: "Original title", detail: "Original evidence", sourceSessionIds: ["source"] };
    const summary = {
      themes: [block],
      highlights: [block, block],
      verification: [],
      comparison: [],
      risks: [block],
      decisions: [],
      nextSteps: [],
    } as unknown as ReportSummary;
    const state = emptyReportPresentation();
    state.pinned = ["risks", "highlights"];
    state.hidden = ["themes"];
    state.overrides = [{ section: "highlights", ordinal: 1, title: "Revised title", detail: "Revised detail" }];
    const projection = projectReportSummary(summary, state);
    expect(projection.map((section) => section.key)).toEqual(["risks", "highlights"]);
    expect(projection.every((section) => section.pinned)).toBe(true);
    expect(projection[1]?.blocks.map((item) => [item.ordinal, item.edited, item.title, item.detail])).toEqual([
      [0, false, block.title, block.detail],
      [1, true, "Revised title", "Revised detail"],
    ]);
    projection[0]!.blocks[0]!.sourceSessionIds.push("mutated");
    const cloned = cloneReportPresentationState(state);
    cloned.pinned.pop();
    cloned.hidden.pop();
    cloned.overrides[0]!.title = "changed clone";
    expect(block.sourceSessionIds).toEqual(["source"]);
    expect(block.title).toBe("Original title");
    expect(state.pinned).toHaveLength(2);
    expect(state.hidden).toEqual(["themes"]);
    expect(state.overrides[0]?.title).toBe("Revised title");
    const original = projectReportSummary(summary, emptyReportPresentation());
    expect(original.map((section) => section.key)).toEqual(["themes", "highlights", "risks"]);
    expect(original.every((section) => !section.pinned)).toBe(true);
    state.hidden = ["themes", "highlights", "risks"];
    expect(projectReportSummary(summary, state)).toEqual([]);
  });
});
