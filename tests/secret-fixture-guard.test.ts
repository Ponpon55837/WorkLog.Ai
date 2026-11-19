import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Test fixtures that imitate secrets are assembled at run time ("gh" + "p_" + body), so no source file carries a
 * full-format credential for a secret scanner to report. This guard fails when one is written out in full again.
 */
const FULL_FORMAT_SECRETS: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(?:[cm]?[jt]sx?|json|md)$/.test(name) ? [path] : [];
  });
}

describe("secret-like test fixtures", () => {
  it("never write a full-format credential literal in tests/", () => {
    const offenders = sourceFiles(__dirname).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return FULL_FORMAT_SECRETS.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`);
    });
    expect(offenders).toEqual([]);
  });
});
