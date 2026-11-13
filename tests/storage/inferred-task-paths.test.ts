import { describe, expect, it } from "vitest";
import { weighTaskPaths } from "../../packages/storage/src/inferred-task-paths.js";

const files = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}/f${index}.ts`);

describe("weighTaskPaths", () => {
  it("dampens a Session by the square root of its file count", () => {
    const weights = weighTaskPaths([
      { id: "wide", score: 10, changedFiles: files("wide", 16) },
      { id: "focused", score: 6, changedFiles: ["focused/one.ts"] },
    ]);
    // 6 / sqrt(1) = 6 beats 10 / sqrt(16) = 2.5 for every wide file.
    expect(weights.get("focused/one.ts")?.weight).toBeCloseTo(6);
    expect(weights.get("wide/f0.ts")?.weight).toBeCloseTo(2.5);
    expect(weights.get("wide/f0.ts")?.sourceSessionIds).toEqual(["wide"]);
  });

  it("adds the shares of every Session that changed the same file and names at most two", () => {
    const weights = weighTaskPaths([
      { id: "a", score: 1, changedFiles: ["shared.ts", "a.ts"] },
      { id: "b", score: 1, changedFiles: ["shared.ts"] },
      { id: "c", score: 1, changedFiles: ["shared.ts"] },
    ]);
    const shared = weights.get("shared.ts")!;
    expect(shared.sourceSessionIds).toEqual(["a", "b"]);
    expect(shared.sessionIds).toEqual(["a", "b", "c"]);
    expect(shared.weight).toBeCloseTo(1 / Math.sqrt(2) + 2);
  });

  it("skips Sessions without files or with more than 20 files", () => {
    const weights = weighTaskPaths([
      { id: "empty", score: 9, changedFiles: [] },
      { id: "dirty", score: 9, changedFiles: files("dirty", 21) },
      { id: "ok", score: 1, changedFiles: files("ok", 20) },
    ]);
    expect([...weights.values()].every((entry) => entry.sessionIds.join() === "ok")).toBe(true);
    expect(weighTaskPaths([{ id: "dirty", score: 9, changedFiles: files("dirty", 21) }]).size).toBe(0);
  });

  it("counts a repeated file of one Session once", () => {
    const weights = weighTaskPaths([{ id: "s", score: 2, changedFiles: ["a.ts", "a.ts"] }]);
    expect([...weights]).toEqual([["a.ts", { weight: 2, sourceSessionIds: ["s"], sessionIds: ["s"] }]]);
  });
});
