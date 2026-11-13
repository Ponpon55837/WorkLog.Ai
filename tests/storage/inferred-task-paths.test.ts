import { describe, expect, it } from "vitest";
import { inferTaskPaths } from "../../packages/storage/src/inferred-task-paths.js";

const files = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}/f${index}.ts`);

describe("inferTaskPaths", () => {
  it("dampens a Session by the square root of its file count", () => {
    const result = inferTaskPaths([
      { id: "wide", score: 10, changedFiles: files("wide", 16) },
      { id: "focused", score: 6, changedFiles: ["focused/one.ts"] },
    ]);
    // 6 / sqrt(1) = 6 beats 10 / sqrt(16) = 2.5 for every wide file.
    expect(result[0]).toEqual({ path: "focused/one.ts", sourceSessionIds: ["focused"] });
    expect(result[1]?.sourceSessionIds).toEqual(["wide"]);
  });

  it("adds the shares of every Session that changed the same file and names at most two", () => {
    const result = inferTaskPaths([
      { id: "a", score: 1, changedFiles: ["shared.ts", "a.ts"] },
      { id: "b", score: 1, changedFiles: ["shared.ts"] },
      { id: "c", score: 1, changedFiles: ["shared.ts"] },
    ]);
    expect(result[0]).toEqual({ path: "shared.ts", sourceSessionIds: ["a", "b"] });
  });

  it("skips Sessions without files or with more than 20 files", () => {
    expect(
      inferTaskPaths([
        { id: "empty", score: 9, changedFiles: [] },
        { id: "dirty", score: 9, changedFiles: files("dirty", 21) },
        { id: "ok", score: 1, changedFiles: files("ok", 20) },
      ]).every((entry) => entry.sourceSessionIds.join() === "ok"),
    ).toBe(true);
    expect(inferTaskPaths([{ id: "dirty", score: 9, changedFiles: files("dirty", 21) }])).toEqual([]);
  });

  it("breaks ties by path and honours the limit", () => {
    const result = inferTaskPaths([{ id: "s", score: 1, changedFiles: ["c.ts", "a.ts", "d.ts", "b.ts"] }], 3);
    expect(result.map((entry) => entry.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(inferTaskPaths([{ id: "s", score: 1, changedFiles: ["a.ts"] }], 0)).toEqual([]);
  });

  it("counts a repeated file of one Session once", () => {
    const result = inferTaskPaths([{ id: "s", score: 2, changedFiles: ["a.ts", "a.ts"] }]);
    expect(result).toEqual([{ path: "a.ts", sourceSessionIds: ["s"] }]);
  });
});
