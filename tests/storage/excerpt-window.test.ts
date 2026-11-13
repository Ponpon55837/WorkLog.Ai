import { describe, expect, it } from "vitest";
import { windowExcerpt } from "../../packages/storage/src/excerpt-window.js";

// Fictional fixtures only.
const filler = "The fictional heron gate keeps its calibration window steady. ";

describe("windowExcerpt", () => {
  it("returns short text unchanged", () => {
    expect(windowExcerpt("Short heron note.", ["heron"], 100)).toEqual({ text: "Short heron note.", truncated: false });
  });

  it("keeps the start when no term occurs", () => {
    const text = filler.repeat(20);
    const result = windowExcerpt(text, ["osprey"], 120);
    expect(result.truncated).toBe(true);
    expect(text.startsWith(result.text.slice(0, -1))).toBe(true);
    expect(result.text.endsWith("…")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(120);
  });

  it("centers a term in the middle and marks both cuts", () => {
    const text = `${filler.repeat(20)}The osprey latch needs a recheck. ${filler.repeat(20)}`;
    const result = windowExcerpt(text, ["osprey"], 200);
    expect(result.text).toContain("osprey");
    expect(result.text.startsWith("…")).toBe(true);
    expect(result.text.endsWith("…")).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(200);
  });

  it("cuts at a sentence start and end when possible", () => {
    const text = `${filler.repeat(20)}The osprey latch needs a recheck. ${filler.repeat(20)}`;
    const result = windowExcerpt(text, ["osprey"], 300);
    expect(result.text.slice(1).startsWith("The ")).toBe(true);
    expect(result.text.endsWith(".…")).toBe(true);
  });

  it("handles a term at the end without a trailing ellipsis", () => {
    const text = `${filler.repeat(20)}Finally check the osprey`;
    const result = windowExcerpt(text, ["osprey"], 150);
    expect(result.text.startsWith("…")).toBe(true);
    expect(result.text.endsWith("osprey")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(150);
  });

  it("handles a term at the start without a leading ellipsis", () => {
    const text = `Osprey first. ${filler.repeat(20)}`;
    const result = windowExcerpt(text, ["osprey"], 100);
    expect(result.text.startsWith("Osprey first.")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("prefers the densest region over the earliest occurrence", () => {
    const text = `A lone osprey early. ${filler.repeat(15)}The osprey and the lantern and the quokka agree here. ${filler.repeat(15)}`;
    const result = windowExcerpt(text, ["osprey", "lantern", "quokka"], 160);
    expect(result.text).toContain("lantern");
    expect(result.text).toContain("quokka");
  });

  it("windows CJK text without spaces and respects the limit", () => {
    const text = `${"前言說明".repeat(60)}貓頭鷹閘門需要重新校準${"後續說明".repeat(60)}`;
    const result = windowExcerpt(text, ["貓頭鷹"], 80);
    expect(result.text).toContain("貓頭鷹");
    expect(result.text.length).toBeLessThanOrEqual(80);
    expect(result.truncated).toBe(true);
  });

  it("never splits surrogate pairs", () => {
    for (let offset = 0; offset < 4; offset += 1) {
      const text = `${"😀".repeat(100 + offset)}osprey${"😀".repeat(100)}`;
      const result = windowExcerpt(text, ["osprey"], 51);
      expect(result.text).toContain("osprey");
      expect(result.text.length).toBeLessThanOrEqual(51);
      expect(result.text).not.toMatch(
        /(?:[\ud800-\udbff](?![\udc00-\udfff]))|(?:(?<![\ud800-\udbff])[\udc00-\udfff])/u,
      );
    }
  });

  it("stays within the limit across many limits and positions", () => {
    const text = filler.repeat(40);
    for (let limit = 5; limit < 160; limit += 7) {
      for (const term of ["heron", "window", "steady", "zzz"]) {
        expect(windowExcerpt(text, [term], limit).text.length).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("keeps the term when an already windowed text is windowed again", () => {
    const text = `${filler.repeat(20)}The osprey latch needs a recheck. ${filler.repeat(20)}`;
    const first = windowExcerpt(text, ["osprey"], 500);
    const second = windowExcerpt(first.text, ["osprey"], 240);
    expect(second.text).toContain("osprey");
    expect(second.text.length).toBeLessThanOrEqual(240);
    expect(second.truncated).toBe(true);
  });
});
