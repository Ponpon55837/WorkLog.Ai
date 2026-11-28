import { describe, expect, it } from "vitest";
import {
  MAX_LIST_SEARCH_TERM_LENGTH,
  MAX_LIST_SEARCH_TERMS,
  parseListSearchTerms,
} from "../../packages/core/src/list-search-terms.js";

describe("parseListSearchTerms", () => {
  it("lowercases words, keeps quoted phrases whole and drops duplicates", () => {
    expect(parseListSearchTerms('Backup "Data Import" backup')).toEqual({
      terms: ["backup", "data import"],
      warnings: [],
    });
  });

  it("skips empty quotes and stray quote characters", () => {
    expect(parseListSearchTerms('"   " " ok')).toEqual({ terms: ["ok"], warnings: [] });
  });

  it("cuts long words and warns", () => {
    const long = "字".repeat(MAX_LIST_SEARCH_TERM_LENGTH + 5);
    const result = parseListSearchTerms(`short ${long}`);
    expect(result.terms).toEqual(["short", "字".repeat(MAX_LIST_SEARCH_TERM_LENGTH)]);
    expect(result.warnings).toEqual([
      `Search word 2 is longer than ${MAX_LIST_SEARCH_TERM_LENGTH} characters; only its first ${MAX_LIST_SEARCH_TERM_LENGTH} were matched.`,
    ]);
  });

  it("ignores words past the limit with singular and plural warnings", () => {
    const words = (count: number) => Array.from({ length: count }, (_, index) => `w${index}`).join(" ");
    expect(parseListSearchTerms(words(MAX_LIST_SEARCH_TERMS + 1)).warnings).toEqual([
      `Only the first ${MAX_LIST_SEARCH_TERMS} search words were used; 1 more was ignored.`,
    ]);
    const plural = parseListSearchTerms(words(MAX_LIST_SEARCH_TERMS + 2));
    expect(plural.terms).toHaveLength(MAX_LIST_SEARCH_TERMS);
    expect(plural.warnings).toEqual([
      `Only the first ${MAX_LIST_SEARCH_TERMS} search words were used; 2 more were ignored.`,
    ]);
  });
});
