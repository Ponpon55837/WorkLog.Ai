import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRegularTextFile } from "../../apps/mcp/src/regular-file-read.js";

const tempDirs: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-hook-read-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("hook payload file reads", () => {
  it("reads a regular file as UTF-8", () => {
    const path = join(tempDirectory(), "transcript.jsonl");
    writeFileSync(path, '{"text":"héllo 世界"}\n', "utf8");
    expect(readRegularTextFile(path, 1_000)).toBe('{"text":"héllo 世界"}\n');
  });

  it("refuses a file over the limit and a directory", () => {
    const directory = tempDirectory();
    const path = join(directory, "large.jsonl");
    writeFileSync(path, "x".repeat(11), "utf8");
    expect(() => readRegularTextFile(path, 10)).toThrow("too large");
    expect(() => readRegularTextFile(directory, 10)).toThrow();
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without blocking", () => {
    const path = join(tempDirectory(), "pipe.jsonl");
    execFileSync("mkfifo", [path]);
    const started = performance.now();
    expect(() => readRegularTextFile(path, 1_000)).toThrow("Not a regular file");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
