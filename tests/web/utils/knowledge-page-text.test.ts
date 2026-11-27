import { describe, expect, it } from "vitest";
import { pageTextBlocks } from "../../../apps/web/src/utils/knowledge-page-text.js";

function paragraphs(content: string): string[] {
  return pageTextBlocks(content).map((block) =>
    block.kind === "paragraph" ? block.text : `[list ${block.items.length}]`,
  );
}

describe("pageTextBlocks", () => {
  it("makes one paragraph per non-empty line", () => {
    expect(paragraphs("First\n\n  Second  \r\nThird")).toEqual(["First", "Second", "Third"]);
  });

  it("groups consecutive bullet lines and ends a list at a blank line", () => {
    expect(pageTextBlocks("Intro\n- a\n* b\n• c\n\n- d")).toEqual([
      { kind: "paragraph", text: "Intro" },
      { kind: "list", ordered: false, start: 1, items: ["a", "b", "c"] },
      { kind: "list", ordered: false, start: 1, items: ["d"] },
    ]);
  });

  it("keeps the numbers of an ordered list of consecutive numbers", () => {
    expect(pageTextBlocks("3. three\n4) four\n5. five")).toEqual([
      { kind: "list", ordered: true, start: 3, items: ["three", "four", "five"] },
    ]);
  });

  it("keeps a lone numbered line, or numbers that skip, as paragraphs", () => {
    expect(paragraphs("2. only one")).toEqual(["2. only one"]);
    expect(paragraphs("2024. was a year")).toEqual(["2024. was a year"]);
    expect(paragraphs("1. one\n3. three")).toEqual(["1. one", "3. three"]);
  });

  it("treats a dash without a following space as plain text", () => {
    expect(paragraphs("-1 degrees")).toEqual(["-1 degrees"]);
  });

  it("returns nothing for blank text", () => {
    expect(pageTextBlocks(" \n\n ")).toEqual([]);
  });

  it("breaks after a sentence end followed by a space, as old paragraph breaks survive", () => {
    expect(paragraphs("所以 CI 另有 Storage (Node 26) job。 Windows 上長時間執行會逾時。 請改用較短的案例。")).toEqual([
      "所以 CI 另有 Storage (Node 26) job。",
      "Windows 上長時間執行會逾時。",
      "請改用較短的案例。",
    ]);
    expect(paragraphs("Build the packages. Then run the apps. e.g. the web app.")).toEqual([
      "Build the packages.",
      "Then run the apps. e.g. the web app.",
    ]);
  });

  it("does not break inside brackets, versions, paths or URLs", () => {
    expect(
      paragraphs("版本 1.6.54 的行為（見 docs/a.md。 另見）請看 https://example.test/a.b/c 與 src/x.ts。 完成"),
    ).toEqual(["版本 1.6.54 的行為（見 docs/a.md。 另見）請看 https://example.test/a.b/c 與 src/x.ts。", "完成"]);
  });

  describe("a long paragraph without line breaks", () => {
    const sentence = (index: number) =>
      `第${index}項：在虛構的溫室裡，澆水排程分成清晨與傍晚兩輪（每輪約 20 分鐘，見 beds/north-${index}.md），先北後南以維持水壓平均。`;
    const long = Array.from({ length: 12 }, (_, index) => sentence(index + 1)).join("");

    it("is chunked at sentence ends with every chunk under the width cap", () => {
      const chunks = paragraphs(long);

      expect(chunks.length).toBeGreaterThan(2);
      expect(chunks.join("")).toBe(long);
      for (const chunk of chunks) {
        expect(chunk.endsWith("。")).toBe(true);
        expect([...chunk].length).toBeLessThanOrEqual(140);
      }
    });

    it("never cuts a bracketed span, a version number or a path", () => {
      for (const chunk of paragraphs(long)) {
        expect(chunk.split("（")).toHaveLength(chunk.split("）").length);
        expect(chunk).not.toMatch(/beds\/north-\d+\.$/);
      }
    });

    it("leaves one very long sentence whole", () => {
      const single = `${"很長的一句話".repeat(60)}。`;

      expect(paragraphs(single)).toEqual([single]);
    });
  });
});
