import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeFiles, UsageCache } from "../../packages/shared/src/agent-usage/index.js";

const SESSION = "11111111-2222-4333-8444-555555555555";

let base = "";
let counter = 0;

function transcript(): string {
  const lines = [
    { type: "user", sessionId: SESSION, timestamp: "2026-03-01T00:00:00Z", message: { role: "user", content: "hi" } },
    {
      type: "assistant",
      sessionId: SESSION,
      timestamp: "2026-03-01T00:00:01Z",
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    },
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function freshPaths(): { log: string; cacheFile: string } {
  counter += 1;
  const log = join(base, `log-${counter}.jsonl`);
  writeFileSync(log, transcript());
  return { log, cacheFile: join(base, `cache-${counter}.json`) };
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "usage-cache-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("UsageCache persistence", () => {
  it("saves owner-only JSON and a fresh cache reuses it after load", async () => {
    const { log, cacheFile } = freshPaths();
    const first = new UsageCache({ file: cacheFile });
    await first.load();
    expect(first.size).toBe(0);
    await summarizeFiles([log], { cache: first });
    await first.save();
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600);

    const second = new UsageCache({ file: cacheFile });
    await second.load();
    expect(second.size).toBe(1);
    const warm = await summarizeFiles([log], { cache: second });
    expect(warm.cache).toEqual({ reused: 1, appended: 0, parsed: 0, bytesRead: 0 });
  });

  it("does not rewrite the file when nothing changed", async () => {
    const { log, cacheFile } = freshPaths();
    const cache = new UsageCache({ file: cacheFile });
    await summarizeFiles([log], { cache });
    await cache.save();
    writeFileSync(cacheFile, "marker");
    await cache.save();
    expect(readFileSync(cacheFile, "utf8")).toBe("marker");
  });

  it("is memory-only without a file", async () => {
    const { log } = freshPaths();
    const cache = new UsageCache();
    await summarizeFiles([log], { cache });
    await cache.load();
    await cache.save();
    expect(cache.size).toBe(1);
    cache.delete(log);
    expect(cache.size).toBe(0);
    expect(cache.get(log)).toBeUndefined();
  });

  it.each([
    ["corrupt JSON", "{not json"],
    ["a non-object", "[1]"],
    ["another version", JSON.stringify({ version: 999, entries: {} })],
    ["missing entries", JSON.stringify({ version: 1 })],
  ])("ignores a cache file with %s", async (_label, body) => {
    const { log, cacheFile } = freshPaths();
    writeFileSync(cacheFile, body);
    const cache = new UsageCache({ file: cacheFile });
    await cache.load();
    expect(cache.size).toBe(0);
    expect((await summarizeFiles([log], { cache })).cache.parsed).toBe(1);
  });

  it("ignores a missing cache file and drops malformed entries", async () => {
    const { log, cacheFile } = freshPaths();
    const missing = new UsageCache({ file: join(base, "nope.json") });
    await missing.load();
    expect(missing.size).toBe(0);

    const source = new UsageCache({ file: cacheFile });
    await summarizeFiles([log], { cache: source });
    await source.save();
    const stored = JSON.parse(readFileSync(cacheFile, "utf8"));
    stored.entries["bad-entry"] = { version: 1 };
    writeFileSync(cacheFile, JSON.stringify(stored));
    const loaded = new UsageCache({ file: cacheFile });
    await loaded.load();
    expect(loaded.size).toBe(1);
  });

  it("swallows a failed save and leaves no temporary file", async () => {
    const { log, cacheFile } = freshPaths();
    // The cache file's parent is a regular file, so creating the directory fails.
    const cache = new UsageCache({ file: join(cacheFile, "inner", "cache.json") });
    await summarizeFiles([log], { cache });
    await expect(cache.save()).resolves.toBeUndefined();
    expect(cache.size).toBe(1);
  });
});
