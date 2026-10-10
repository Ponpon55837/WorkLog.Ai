import { describe, expect, it } from "vitest";
import {
  reportPresentationStateSchema,
  updateReportPresentationSchema,
} from "../../packages/schema/src/report-presentation.js";

describe("report presentation validation", () => {
  const block = { section: "themes", ordinal: 0, title: "Title", detail: "Detail" };
  it("rejects duplicate identities, arbitrary fields and unsafe revisions", () => {
    const state = { pinned: [], hidden: [], overrides: [block] };
    expect(reportPresentationStateSchema.safeParse(state).success).toBe(true);
    for (const invalid of [
      { ...state, pinned: ["risks", "risks"] },
      { ...state, overrides: [block, block] },
      { ...state, overrides: [{ ...block, sourceSessionIds: ["foreign"] }] },
      { ...state, overrides: [{ ...block, ordinal: 50 }] },
    ])
      expect(reportPresentationStateSchema.safeParse(invalid).success).toBe(false);
    for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(updateReportPresentationSchema.safeParse({ summaryId: "fixture", expectedRevision, state }).success).toBe(
        false,
      );
  });
  it("limits total manual text after trimming", () => {
    const overrides = [0, 1].map((ordinal) => ({ ...block, ordinal, title: " t ", detail: "x".repeat(3999) }));
    const state = { pinned: [], hidden: [], overrides };
    expect(reportPresentationStateSchema.parse(state).overrides[0]?.title).toBe("t");
    expect(
      reportPresentationStateSchema.safeParse({ ...state, overrides: [...overrides, { ...block, ordinal: 2 }] })
        .success,
    ).toBe(false);
  });
});
