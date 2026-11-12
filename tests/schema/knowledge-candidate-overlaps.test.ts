import { describe, expect, it } from "vitest";
import { mcpListSessionsInputSchema, storedKnowledgeCandidateOverlapsSchema } from "../../packages/schema/src/index.js";

// Fictional ids only.
const overlap = { relation: "possible_duplicate", type: "knowledge", id: "knowledge-1", status: "active", score: 0.42 };

describe("stored Knowledge candidate overlaps", () => {
  it("accepts the four pairs the server writes, up to three distinct records", () => {
    expect(
      storedKnowledgeCandidateOverlapsSchema.safeParse([
        overlap,
        { relation: "overlaps_archived", type: "knowledge", id: "knowledge-2", status: "archived", score: 0.3 },
        { relation: "overlaps_rejected", type: "candidate", id: "candidate-1", status: "rejected", score: 1 },
      ]).success,
    ).toBe(true);
    expect(
      storedKnowledgeCandidateOverlapsSchema.safeParse([
        { relation: "possible_duplicate", type: "candidate", id: "candidate-2", status: "proposed", score: 0 },
      ]).success,
    ).toBe(true);
    expect(storedKnowledgeCandidateOverlapsSchema.safeParse([]).success).toBe(true);
  });

  it("rejects text, unknown keys, inconsistent relations, duplicates, scores out of range and long lists", () => {
    for (const invalid of [
      [{ ...overlap, title: "Text is never stored" }],
      [{ ...overlap, relation: "overlaps_archived" }],
      [{ ...overlap, type: "candidate" }],
      [overlap, overlap],
      [{ ...overlap, score: 1.5 }],
      [{ ...overlap, id: "" }],
      [1, 2, 3, 4].map((index) => ({ ...overlap, id: `knowledge-${index}` })),
      {},
    ]) {
      expect(storedKnowledgeCandidateOverlapsSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("work_list_sessions commitSha", () => {
  it("accepts 7 to 64 hex characters in either case and nothing else", () => {
    for (const commitSha of ["abc1234", "ABC1234DEF", "a".repeat(40), "f".repeat(64), " abc1234 "]) {
      expect(mcpListSessionsInputSchema.safeParse({ commitSha }).success).toBe(true);
    }
    for (const commitSha of ["abc123", "abc1234g", "abc%123", "a".repeat(65), "abc 1234", ""]) {
      expect(mcpListSessionsInputSchema.safeParse({ commitSha }).success).toBe(false);
    }
  });
});
