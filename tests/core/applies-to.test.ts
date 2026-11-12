import { describe, expect, it } from "vitest";
import {
  appliesToGlobStarCount,
  isAppliesToGlob,
  isOverComplexAppliesToGlob,
  MAX_APPLIES_TO_GLOB_STARS,
  tokenizeAppliesToGlob,
  tokenizeAppliesToGlobCompact,
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

  it("counts stars the same way when validating without allocating", () => {
    let state = 31;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const alphabet = ["*", "**", "**/", "?", "a", "/", "*a"];
    for (let round = 0; round < 3_000; round += 1) {
      const pattern = Array.from(
        { length: 1 + Math.floor(random() * 40) },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join("");
      const stars = appliesToGlobStarCount(tokenizeAppliesToGlob(pattern));
      expect([pattern, tokenizeAppliesToGlobCompact(pattern).stars]).toEqual([pattern, stars]);
      expect([pattern, isOverComplexAppliesToGlob(pattern)]).toEqual([pattern, stars > MAX_APPLIES_TO_GLOB_STARS]);
    }
  });
});
