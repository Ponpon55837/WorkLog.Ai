import { describe, expect, it } from "vitest";
import {
  outstandingTextSimilarity,
  pairRewordedItems,
  REWORD_SIMILARITY_THRESHOLD,
} from "../../packages/storage/src/outstanding-item-matching.js";

describe("outstandingTextSimilarity", () => {
  it("is 1 for texts identical after normalization", () => {
    expect(outstandingTextSimilarity("尚未驗證。", "尚未驗證")).toBe(1);
    expect(outstandingTextSimilarity("Run  CI, then Merge!", "run ci then merge")).toBe(1);
  });

  it("keeps a close CJK rewording above the threshold and different items below it", () => {
    expect(outstandingTextSimilarity("PR #12 尚未合併", "PR #12 已開啟但尚未合併")).toBeGreaterThanOrEqual(
      REWORD_SIMILARITY_THRESHOLD,
    );
    expect(outstandingTextSimilarity("Windows 尚未驗證", "macOS 尚未驗證")).toBeLessThan(REWORD_SIMILARITY_THRESHOLD);
  });

  it("works for Latin text", () => {
    expect(
      outstandingTextSimilarity("Verify Orbit cache lock", "Verify the Orbit cache lock behavior"),
    ).toBeGreaterThan(REWORD_SIMILARITY_THRESHOLD);
    expect(outstandingTextSimilarity("Verify Orbit cache lock", "Rotate the signing certificate")).toBeLessThan(
      REWORD_SIMILARITY_THRESHOLD,
    );
  });

  it("never matches empty or punctuation-only text", () => {
    expect(outstandingTextSimilarity("", "")).toBe(0);
    expect(outstandingTextSimilarity("。。。 !!", "…… ??")).toBe(0);
    expect(outstandingTextSimilarity("。。。", "尚未驗證")).toBe(0);
  });

  it("treats a one-character text as its own bigram", () => {
    expect(outstandingTextSimilarity("A", "a!")).toBe(1);
    expect(outstandingTextSimilarity("A", "B")).toBe(0);
  });
});

describe("pairRewordedItems", () => {
  it("pairs the best candidates one to one", () => {
    const pairs = pairRewordedItems(
      [
        { id: "a", position: 0, text: "Verify Orbit cache lock" },
        { id: "b", position: 1, text: "Rotate signing certificate" },
      ],
      [
        { index: 0, text: "Rotate the signing certificate before release" },
        { index: 1, text: "Verify the Orbit cache lock behavior" },
      ],
    );
    expect(pairs.map(({ id, index }) => ({ id, index }))).toEqual(
      expect.arrayContaining([
        { id: "a", index: 1 },
        { id: "b", index: 0 },
      ]),
    );
    expect(pairs).toHaveLength(2);
  });

  it("lets two candidates compete for one entry deterministically", () => {
    const previous = [
      { id: "far", position: 5, text: "PR #12 尚未合併" },
      { id: "near", position: 0, text: "PR #12 尚未合併" },
    ];
    const next = [{ index: 0, text: "PR #12 已開啟但尚未合併" }];
    const first = pairRewordedItems(previous, next);
    expect(first).toEqual([expect.objectContaining({ id: "near", index: 0 })]);
    expect(pairRewordedItems([...previous].reverse(), next)).toEqual(first);
  });

  it("breaks full ties by id", () => {
    const pairs = pairRewordedItems(
      [
        { id: "b", position: 0, text: "同一件事 尚未處理" },
        { id: "a", position: 0, text: "同一件事 尚未處理" },
      ],
      [{ index: 0, text: "同一件事 尚未處理完成" }],
    );
    expect(pairs[0]?.id).toBe("a");
  });

  it("returns nothing for empty input, empty text, or oversized input", () => {
    expect(pairRewordedItems([], [{ index: 0, text: "尚未驗證" }])).toEqual([]);
    expect(pairRewordedItems([{ id: "a", position: 0, text: "。" }], [{ index: 0, text: "。" }])).toEqual([]);
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `i${index}`,
      position: index,
      text: "same text here",
    }));
    expect(
      pairRewordedItems(
        many,
        many.map((item) => ({ index: item.position, text: item.text })),
      ),
    ).toEqual([]);
  });
});
