import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const rendererDirectory = join(repo, "apps/desktop/src/renderer");
const tokensFile = join(repo, "packages/ui-tokens/tokens.css");
const repairCss = join(rendererDirectory, "repair/repair.css");

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const rendererFiles = filesUnder(rendererDirectory).filter((file) => [".css", ".ts", ".html"].includes(extname(file)));

/** A raw colour: a hex value, or a colour function. `transparent`, `currentColor`, `inherit` and var() are fine. */
const RAW_COLOUR =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/;
const NAMED_COLOURS = new Set([
  "white",
  "black",
  "red",
  "green",
  "blue",
  "gray",
  "grey",
  "yellow",
  "orange",
  "purple",
  "pink",
]);

function tokenNames(css: string): Set<string> {
  return new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1] as string));
}

/** The names declared in the first `:root { … }` block: the default (dark) set every other set only overrides. */
function rootTokenNames(css: string): Set<string> {
  const block = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  return tokenNames(block);
}

describe("the App window uses the shared design tokens only", () => {
  it("finds the renderer files it scans", () => {
    // Normalised: on Windows `relative` returns backslashes.
    expect(rendererFiles.map((file) => relative(rendererDirectory, file).replaceAll("\\", "/"))).toContain(
      "repair/repair.css",
    );
    expect(rendererFiles.length).toBeGreaterThan(10);
  });

  it("has no raw hex, rgb(), rgba() or hsl() colour in any renderer css, ts or html file", () => {
    const offenders = rendererFiles.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((text, index) => ({ text, line: index + 1 }))
        .filter(({ text }) => RAW_COLOUR.test(text))
        .map(({ line, text }) => `${relative(repo, file)}:${line}: ${text.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("has no named colour in a css declaration", () => {
    const css = readFileSync(repairCss, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders = [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)]
      .filter(([, property]) => !(property as string).startsWith("--"))
      .filter(([, , value]) => (value as string).split(/[\s,()]+/).some((word) => NAMED_COLOURS.has(word)))
      .map((match) => match[0]);
    expect(offenders).toEqual([]);
  });

  it("declares no token of its own and does not pick the theme itself", () => {
    const css = readFileSync(repairCss, "utf8");
    expect(css).not.toMatch(/^\s*--[a-z0-9-]+\s*:/m);
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).not.toMatch(/:root\s*\{/);
  });

  it("uses only variables that the shared tokens define in their default set", () => {
    const css = readFileSync(repairCss, "utf8");
    const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1] as string));
    const defined = rootTokenNames(readFileSync(tokensFile, "utf8"));
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("has the light set override only names the default set has", () => {
    const css = readFileSync(tokensFile, "utf8");
    const light = /:root\[data-theme="light"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const defined = rootTokenNames(css);
    expect([...tokenNames(light)].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("does not set inline styles by attribute (the page's CSP forbids them)", () => {
    const offenders = rendererFiles
      .filter((file) => extname(file) === ".ts")
      .filter((file) => /setAttribute\(\s*["']style["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(repo, file));
    expect(offenders).toEqual([]);
  });
});
