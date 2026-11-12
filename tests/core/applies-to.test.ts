import { describe, expect, it } from "vitest";
import {
  appliesToGlobStarCount,
  isAppliesToGlob,
  isOverComplexAppliesToGlob,
  MAX_APPLIES_TO_GLOB_STARS,
  tokenizeAppliesToGlob,
} from "../../packages/core/src/index.js";

// Fictional scopes only.
describe("appliesTo glob syntax", () => {
  it("tells globs from plain paths", () => {
    expect(isAppliesToGlob("src/a.ts")).toBe(false);
    expect(isAppliesToGlob("src/*.ts")).toBe(true);
    expect(isAppliesToGlob("docs/?.md")).toBe(true);
  });

  it("tokenizes literals, ?, *, and ** with its slash, folding adjacent stars of one kind", () => {
    expect(tokenizeAppliesToGlob("a?*/**/b")).toEqual([
      { kind: "literal", char: "a" },
      { kind: "one" },
      { kind: "segment" },
      { kind: "literal", char: "/" },
      { kind: "any" },
      { kind: "literal", char: "b" },
    ]);
    expect(tokenizeAppliesToGlob("a****b")).toEqual([
      { kind: "literal", char: "a" },
      { kind: "any" },
      { kind: "literal", char: "b" },
    ]);
    expect(tokenizeAppliesToGlob("***")).toEqual([{ kind: "any" }, { kind: "segment" }]);
  });

  it("counts stars and bounds them only for globs", () => {
    expect(appliesToGlobStarCount(tokenizeAppliesToGlob("packages/*/src/**/*-service.ts"))).toBe(3);
    expect(isOverComplexAppliesToGlob("*a".repeat(MAX_APPLIES_TO_GLOB_STARS))).toBe(false);
    expect(isOverComplexAppliesToGlob("*a".repeat(MAX_APPLIES_TO_GLOB_STARS + 1))).toBe(true);
    expect(isOverComplexAppliesToGlob("plain/path".repeat(30))).toBe(false);
  });
});
