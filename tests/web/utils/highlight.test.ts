import { describe, expect, it } from "vitest";
import { hasHighlight, highlightSegments } from "../../../apps/web/src/utils/highlight.js";

describe("search highlighting", () => {
  it("ignores repeated and surrounding whitespace in the query", () => {
    expect(highlightSegments("fix parser", "  fix  parser fix ")).toEqual([
      { text: "fix", match: true },
      { text: " ", match: false },
      { text: "parser", match: true },
    ]);
    expect(highlightSegments("fix", "   ")).toEqual([{ text: "fix", match: false }]);
  });

  it("marks every case-insensitive match and keeps the rest as plain text", () => {
    expect(highlightSegments("Fix the Parser bug", "parser fix")).toEqual([
      { text: "Fix", match: true },
      { text: " the ", match: false },
      { text: "Parser", match: true },
      { text: " bug", match: false },
    ]);
  });

  it("matches Chinese text and treats regex characters in the query literally", () => {
    expect(highlightSegments("修正搜尋 (beta) 結果", "搜尋 (beta)")).toEqual([
      { text: "修正", match: false },
      { text: "搜尋", match: true },
      { text: " ", match: false },
      { text: "(beta)", match: true },
      { text: " 結果", match: false },
    ]);
  });

  it("returns the whole text unmarked without a query", () => {
    expect(highlightSegments("anything", "")).toEqual([{ text: "anything", match: false }]);
    expect(hasHighlight("anything", "")).toBe(false);
    expect(hasHighlight("anything", "thing")).toBe(true);
  });
});
