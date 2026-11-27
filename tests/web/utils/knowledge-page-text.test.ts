import { describe, expect, it } from "vitest";
import { pageTextBlocks } from "../../../apps/web/src/utils/knowledge-page-text.js";

describe("pageTextBlocks", () => {
  it("makes one paragraph per non-empty line", () => {
    expect(pageTextBlocks("First\n\n  Second  \r\nThird")).toEqual([
      { kind: "paragraph", text: "First" },
      { kind: "paragraph", text: "Second" },
      { kind: "paragraph", text: "Third" },
    ]);
  });

  it("groups consecutive list lines and separates ordered from unordered", () => {
    expect(pageTextBlocks("Intro\n- a\n* b\n• c\n1. one\n2) two")).toEqual([
      { kind: "paragraph", text: "Intro" },
      { kind: "list", ordered: false, items: ["a", "b", "c"] },
      { kind: "list", ordered: true, items: ["one", "two"] },
    ]);
  });

  it("treats a dash without a following space as plain text", () => {
    expect(pageTextBlocks("-1 degrees")).toEqual([{ kind: "paragraph", text: "-1 degrees" }]);
  });

  it("returns nothing for blank text", () => {
    expect(pageTextBlocks(" \n\n")).toEqual([]);
  });
});
