import { describe, expect, it } from "vitest";
import { SESSION_READ_FIELDS } from "../../packages/core/src/index.js";
import { sessionDetailQuerySchema } from "../../packages/schema/src/index.js";

describe("Session Agent field read input boundary", () => {
  it("keeps full legacy defaults and validates both preset and fixed custom reads", () => {
    expect(sessionDetailQuerySchema.parse({ sessionId: "synthetic" })).toEqual({
      sessionId: "synthetic",
      includeRawSnapshots: false,
    });
    for (const view of ["completion", "handoff"])
      expect(sessionDetailQuerySchema.parse({ sessionId: "synthetic", view })).toMatchObject({
        view,
        includeRawSnapshots: false,
      });
    for (const field of SESSION_READ_FIELDS)
      expect(sessionDetailQuerySchema.parse({ sessionId: "synthetic", select: [field] }).select).toEqual([field]);
    expect(
      sessionDetailQuerySchema.parse({ sessionId: "synthetic", select: [...SESSION_READ_FIELDS] }).select,
    ).toHaveLength(18);
    expect(
      sessionDetailQuerySchema.parse({ sessionId: "synthetic", includeRawSnapshots: true }).includeRawSnapshots,
    ).toBe(true);
    expect(
      sessionDetailQuerySchema.parse({ sessionId: "synthetic", select: ["rawSnapshots"], includeRawSnapshots: true })
        .includeRawSnapshots,
    ).toBe(true);
  });
  it("rejects contradictory modes, duplicates and implicit raw content", () => {
    for (const input of [
      { view: "completion", select: ["events"] },
      { select: ["events", "events"] },
      { view: "handoff", includeRawSnapshots: true },
      { select: ["events"], includeRawSnapshots: true },
      { view: "completion", includeRawSnapshots: true },
    ])
      expect(sessionDetailQuerySchema.safeParse({ sessionId: "synthetic", ...input }).success).toBe(false);
  });
  it("rejects unknown paths, parent groups, empty or oversized selections and invalid scalar types", () => {
    for (const input of [
      { select: [] },
      { select: ["session"] },
      { select: ["session.workSummary"] },
      { select: ["*"] },
      { select: ["events; DROP TABLE sessions"] },
      { select: Array(19).fill("events") },
      { view: "unsupported" },
      { select: "events" },
      { includeRawSnapshots: "true" },
      { sessionId: "" },
    ])
      expect(sessionDetailQuerySchema.safeParse({ sessionId: "synthetic", ...input }).success).toBe(false);
  });
});
