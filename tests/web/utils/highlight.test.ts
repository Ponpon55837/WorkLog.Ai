import { describe, expect, it } from "vitest";
import { highlightSegments, matchExcerpt, searchTerms } from "../../../apps/web/src/utils/highlight.js";

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
  });

  it("reads the query like the server: quoted phrases stay whole, terms are lowercased, deduped and capped", () => {
    expect(searchTerms('  Queen "Honey Flow"  queen ')).toEqual(["queen", "honey flow"]);
    expect(searchTerms("a b c d e f g h i j")).toHaveLength(8);
    expect(highlightSegments("a honey flow b honey", 'Honey "flow b"')).toEqual([
      { text: "a ", match: false },
      { text: "honey", match: true },
      { text: " ", match: false },
      { text: "flow b", match: true },
      { text: " ", match: false },
      { text: "honey", match: true },
    ]);
  });

  it("cuts one line around the first match and marks the cut with an ellipsis", () => {
    const text = `${"before ".repeat(20)}needle${" after".repeat(20)}`;
    const excerpt = matchExcerpt(text, ["needle"]) ?? "";

    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).toContain("needle");
    expect(excerpt.length).toBeLessThan(100);
    expect(excerpt.indexOf("needle")).toBeLessThanOrEqual(11);
    expect(matchExcerpt("short needle\ntext", ["needle"])).toBe("short needle text");
    expect(matchExcerpt("nothing here", ["needle"])).toBeUndefined();
  });
});
