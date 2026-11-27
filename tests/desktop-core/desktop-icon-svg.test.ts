import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDesktopIconSvg, buildTrayGlyphSvg, readFavicon } from "../../apps/desktop/scripts/icon-svg.mjs";
import { verifyIconFiles } from "../../apps/desktop/scripts/icon-files.mjs";

const root = resolve(import.meta.dirname, "../..");
const favicon = readFileSync(resolve(root, "apps/web/public/favicon.svg"), "utf8");
const pluginIcon = readFileSync(resolve(root, "plugins/work-intelligence/assets/icon.svg"), "utf8");
const desktopIcon = readFileSync(resolve(root, "apps/desktop/build/icon.svg"), "utf8");

// Favicon units to desktop pixels: the 32-unit mark fills the 824 px square that starts 100 px inside the 1024 px canvas.
const SCALE = 824 / 32;
const OFFSET = 100;
const at = (value: number) => OFFSET + value * SCALE;

function numbers(source: string, tag: string, name: string): number[] {
  const element = new RegExp(`<${tag}\\b[^>]*>`).exec(source)?.[0] ?? "";
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(element)?.[1] ?? "";
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
}

function text(source: string, tag: string, name: string): string {
  const element = new RegExp(`<${tag}\\b[^>]*>`).exec(source)?.[0] ?? "";
  return new RegExp(`\\s${name}="([^"]*)"`).exec(element)?.[1] ?? "";
}

describe("desktop icon", () => {
  it("keeps the plugin icon and the favicon identical, so the favicon is the one brand source", () => {
    expect(pluginIcon).toBe(favicon);
  });

  it("is the favicon geometry scaled into the 824 px square at offset 100", () => {
    const mark = readFavicon(favicon);
    expect(desktopIcon).toContain('viewBox="0 0 1024 1024"');

    const [x, y, width, height, rx, strokeWidth] = ["x", "y", "width", "height", "rx", "stroke-width"].map(
      (name) => numbers(desktopIcon, "rect", name)[0]!,
    );
    expect([x, y]).toEqual([at(mark.plate.x), at(mark.plate.y)]);
    expect([width, height]).toEqual([mark.plate.width * SCALE, mark.plate.height * SCALE]);
    expect(rx).toBeCloseTo(mark.plate.rx * SCALE, 2);
    expect(strokeWidth).toBeCloseTo(mark.plate.strokeWidth * SCALE, 2);
    // The stroked plate's outer edge is the 824 px square at x/y 100: the 100 px margin stays transparent.
    expect(x! - strokeWidth! / 2).toBeCloseTo(100, 2);
    expect(x! + width! + strokeWidth! / 2).toBeCloseTo(924, 2);

    expect(text(desktopIcon, "rect", "fill")).toBe(mark.plate.fill);
    expect(text(desktopIcon, "rect", "stroke")).toBe(mark.plate.stroke);
    expect(text(desktopIcon, "g", "stroke")).toBe(mark.glyph.stroke);
    expect(mark.plate.fill).toBe("#0d1117");
    expect(mark.glyph.stroke).toBe("#e6edf3");

    const points = numbers(desktopIcon, "polyline", "points");
    expect(points).toHaveLength(mark.glyph.points.length * 2);
    mark.glyph.points.forEach(([px, py], index) => {
      expect(points[index * 2]).toBeCloseTo(at(px!), 2);
      expect(points[index * 2 + 1]).toBeCloseTo(at(py!), 2);
    });
    const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((name) => numbers(desktopIcon, "line", name)[0]!);
    expect([x1, y1, x2, y2]).toEqual([
      at(mark.glyph.line[0]!),
      at(mark.glyph.line[1]!),
      at(mark.glyph.line[2]!),
      at(mark.glyph.line[3]!),
    ]);
    expect(numbers(desktopIcon, "g", "stroke-width")[0]).toBeCloseTo(mark.glyph.strokeWidth * SCALE, 2);
  });

  it("is exactly what generate-icons derives from the favicon (no hand edits)", () => {
    expect(desktopIcon).toBe(buildDesktopIconSvg(favicon));
  });

  it("draws the macOS template glyph in black with the favicon's W and I and no background", () => {
    const glyph = buildTrayGlyphSvg(favicon);
    const mark = readFavicon(favicon);
    expect(glyph).not.toContain("<rect");
    expect(text(glyph, "g", "stroke")).toBe("#000000");
    expect(numbers(glyph, "polyline", "points")).toEqual(mark.glyph.points.flat());
  });

  it("ships icon files that pass the packaging check, tray images included", () => {
    expect(verifyIconFiles().icoSizes).toContain(16);
  });
});
