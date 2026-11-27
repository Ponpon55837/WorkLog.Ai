import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const version = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const status = readFileSync(path.join(ROOT, "docs/status.md"), "utf8");
const headings = status.split("\n").filter((line) => line.startsWith("## "));

describe("docs/status.md follows the release", () => {
  it(`has a section for the current version ${version}`, () => {
    expect(headings.some((line) => line.startsWith(`## ${version}（`))).toBe(true);
  });

  it("lists no older release as still in progress", () => {
    const stale = headings.filter((line) => line.includes("進行中") && !line.startsWith(`## ${version}（`));
    expect(stale).toEqual([]);
  });
});
