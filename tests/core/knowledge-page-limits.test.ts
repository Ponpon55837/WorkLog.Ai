import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_PAGE_MAX_CONTENT_CHARS,
  KNOWLEDGE_PAGE_MAX_SECTIONS,
  KNOWLEDGE_PAGE_NEAR_CONTENT_CHARS,
  KNOWLEDGE_PAGE_NEAR_SECTIONS,
  KNOWLEDGE_PAGE_SPLIT_GUIDANCE,
  knowledgePageLimits,
} from "../../packages/core/src/index.js";

// Fictional sections only.
const sections = (lengths: readonly number[]) =>
  lengths.map((length, index) => ({ heading: `Topic ${index}`, content: "x".repeat(length) }));

describe("knowledgePageLimits", () => {
  it("keeps the limits, and calls a page near them one section slot or 90% of the content before the limit", () => {
    expect(KNOWLEDGE_PAGE_MAX_SECTIONS).toBe(12);
    expect(KNOWLEDGE_PAGE_MAX_CONTENT_CHARS).toBe(8_000);
    expect(KNOWLEDGE_PAGE_NEAR_SECTIONS).toBe(11);
    expect(KNOWLEDGE_PAGE_NEAR_CONTENT_CHARS).toBe(7_200);
  });

  it("returns only the size for a page below both thresholds", () => {
    const limits = knowledgePageLimits(sections([3_000, 4_000, 199]));
    expect(limits).toEqual({
      size: { sectionCount: 3, maxSections: 12, contentChars: 7_199, maxContentChars: 8_000 },
    });
    expect(knowledgePageLimits(sections(Array.from({ length: 10 }, () => 10)))).not.toHaveProperty("splitSuggestion");
  });

  it("suggests the largest sections when the content is near the limit", () => {
    expect(knowledgePageLimits(sections([1_000, 3_000, 200, 3_000])).splitSuggestion).toEqual({
      near: ["content"],
      headings: ["Topic 1", "Topic 3", "Topic 0"],
      splitWith: KNOWLEDGE_PAGE_SPLIT_GUIDANCE,
    });
  });

  it("suggests the largest sections when the section count is near the limit", () => {
    const lengths = Array.from({ length: 11 }, (_, index) => (index === 4 ? 90 : index === 9 ? 80 : 10));
    expect(knowledgePageLimits(sections(lengths)).splitSuggestion).toEqual({
      near: ["sections"],
      headings: ["Topic 4", "Topic 9", "Topic 0"],
      splitWith: KNOWLEDGE_PAGE_SPLIT_GUIDANCE,
    });
  });

  it("names both limits when both are near, and over the limits as well", () => {
    expect(knowledgePageLimits(sections(Array.from({ length: 12 }, () => 640))).splitSuggestion?.near).toEqual([
      "sections",
      "content",
    ]);
    const over = knowledgePageLimits(sections(Array.from({ length: 13 }, () => 700)));
    expect(over.size).toMatchObject({ sectionCount: 13, contentChars: 9_100 });
    expect(over.splitSuggestion?.near).toEqual(["sections", "content"]);
  });

  it("never suggests moving every section, and nothing for an empty page", () => {
    expect(knowledgePageLimits(sections([4_000, 3_500])).splitSuggestion?.headings).toEqual(["Topic 0"]);
    expect(knowledgePageLimits([])).toEqual({
      size: { sectionCount: 0, maxSections: 12, contentChars: 0, maxContentChars: 8_000 },
    });
  });
});
