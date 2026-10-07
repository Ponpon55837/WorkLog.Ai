import { describe, expect, it } from "vitest";
import { diffKnowledgePages, diffLines } from "../../../apps/web/src/utils/knowledge-page-diff.js";

const section = (heading: string, content: string, ids: string[] = []) => ({
  heading,
  content,
  sourceSessionIds: ids,
});

describe("diffLines", () => {
  it("marks added, removed and unchanged lines", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });

  it("treats empty text as no lines", () => {
    expect(diffLines("", "")).toEqual([]);
    expect(diffLines("", "a")).toEqual([{ kind: "added", text: "a" }]);
    expect(diffLines("a", "")).toEqual([{ kind: "removed", text: "a" }]);
  });
});

describe("diffKnowledgePages", () => {
  it("reports identical versions as unchanged", () => {
    const sections = [section("Overview", "one\ntwo", ["s1"])];
    const diff = diffKnowledgePages(sections, sections);
    expect(diff).toMatchObject({ added: 0, removed: 0, changed: 0 });
    expect(diff.sections[0]).toMatchObject({ status: "unchanged", lines: [] });
  });

  it("detects added, removed and changed sections", () => {
    const diff = diffKnowledgePages(
      [section("Overview", "old line", ["s1"]), section("Gone", "bye", ["s2"])],
      [section("Overview", "new line", ["s1"]), section("Fresh", "hello\nworld", ["s3"])],
    );
    expect([diff.added, diff.removed, diff.changed]).toEqual([1, 1, 1]);
    expect(diff.sections.map((item) => [item.heading, item.status])).toEqual([
      ["Overview", "changed"],
      ["Fresh", "added"],
      ["Gone", "removed"],
    ]);
    expect(diff.sections[1]!.addedSourceIds).toEqual(["s3"]);
    expect(diff.sections[2]!.removedSourceIds).toEqual(["s2"]);
  });

  it("flags a source-only change as changed with no line diff", () => {
    const diff = diffKnowledgePages([section("A", "same", ["s1", "s2"])], [section("A", "same", ["s2", "s3"])]);
    expect(diff.sections[0]).toMatchObject({
      status: "changed",
      lines: [],
      addedSourceIds: ["s3"],
      removedSourceIds: ["s1"],
    });
    expect(diff.changed).toBe(1);
  });

  it("handles empty sections and empty pages", () => {
    expect(diffKnowledgePages([], [])).toEqual({ sections: [], added: 0, removed: 0, changed: 0 });
    const diff = diffKnowledgePages([section("A", "")], [section("A", "text")]);
    expect(diff.sections[0]).toMatchObject({ status: "changed", lines: [{ kind: "added", text: "text" }] });
  });

  it("pairs duplicate headings in order", () => {
    const diff = diffKnowledgePages([section("A", "1"), section("A", "2")], [section("A", "1"), section("A", "3")]);
    expect(diff.sections.map((item) => item.status)).toEqual(["unchanged", "changed"]);
  });
});
