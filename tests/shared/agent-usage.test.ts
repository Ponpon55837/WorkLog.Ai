import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractFile } from "../../packages/shared/src/agent-usage/extract.js";
import { reduceClaudeRecords } from "../../packages/shared/src/agent-usage/claude.js";
import { createState } from "../../packages/shared/src/agent-usage/state.js";
import {
  summarizeFiles,
  UsageCache,
  UsageScanAbortedError,
  UsageScanTimeoutError,
} from "../../packages/shared/src/agent-usage/index.js";

const CANARY = "AGENT-USAGE-CANARY-4242";
const SESSION = "11111111-2222-4333-8444-555555555555";

let base = "";
let counter = 0;

function assistant(id: string, second: number, content: unknown[], usage: Record<string, number>) {
  return {
    type: "assistant",
    sessionId: SESSION,
    timestamp: new Date(Date.UTC(2026, 2, 1, 0, 0, second)).toISOString(),
    message: { id, role: "assistant", content, usage },
  };
}

function user(second: number, content: unknown) {
  return {
    type: "user",
    sessionId: SESSION,
    timestamp: new Date(Date.UTC(2026, 2, 1, 0, 0, second)).toISOString(),
    message: { role: "user", content },
  };
}

const toolUse = (id: string, name: string, input: unknown = { note: CANARY }) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const toolResult = (id: string, length: number) => ({
  type: "tool_result",
  tool_use_id: id,
  content: "x".repeat(length),
});
const jsonl = (lines: unknown[], eol = "\n") => lines.map((line) => JSON.stringify(line)).join(eol) + eol;

function comparable<T extends { cache: unknown }>(report: T): Omit<T, "cache"> {
  const { cache: _cache, ...rest } = report;
  return rest;
}

function fileOf(name: string, text: string): string {
  counter += 1;
  const dir = join(base, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

const FIRST = [
  user(0, `${CANARY} prompt`),
  assistant("m1", 1, [toolUse("t1", "mcp__wi__work_read", { operation: "work_search_memory", q: CANARY })], {
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 100,
  }),
  user(2, [toolResult("t1", 30)]),
];
const MORE = [
  assistant("m2", 3, [toolUse("t2", "Read")], { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 7 }),
  user(4, [toolResult("t2", 9)]),
  user(5, "second prompt"),
];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "usage-shared-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("extract and reduce", () => {
  it("extracts one record per Claude line without deduplication or range filtering", async () => {
    const lines = [...FIRST, FIRST[1], { type: "attachment", note: CANARY }, "{ broken"];
    const path = fileOf(
      "a.jsonl",
      lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n",
    );
    const extracted = await extractFile(path);
    expect(extracted.records).toHaveLength(4);
    expect(extracted.skippedLines).toBe(1);
    expect(extracted.offset).toBe(statSync(path).size);
    expect(extracted.tail.records).toHaveLength(0);
    expect(JSON.stringify(extracted.records)).not.toContain(CANARY);
    expect(extracted.records[1]?.tu).toEqual([{ id: "t1", n: "work_read", k: "work_read/work_search_memory" }]);
  });

  it("reduces records to the same report as scanning the file, for any range", async () => {
    const path = fileOf("a.jsonl", jsonl([...FIRST, ...MORE]));
    const extracted = await extractFile(path);
    for (const range of [{}, { since: "2026-03-01T00:00:02Z" }, { until: "2026-03-01T00:00:03Z" }]) {
      const state = createState(range);
      reduceClaudeRecords(state, extracted.records);
      const report = await summarizeFiles([path], range);
      expect([...state.sessions.values()].map((session) => session.toolCalls)).toEqual(
        report.sessions.map((session) => session.toolCalls),
      );
      expect(state.total.assistantMessages).toBe(0);
      for (const session of state.sessions.values()) state.total.assistantMessages += session.assistantMessages;
      expect(state.total.assistantMessages).toBe(report.sessions.reduce((sum, s) => sum + s.assistantMessages, 0));
    }
  });

  it("deduplicates message ids, tool_use ids and results across files in path order", async () => {
    const one = fileOf("one.jsonl", jsonl([...FIRST, ...MORE]));
    const copy = fileOf("two.jsonl", jsonl([...FIRST, ...MORE]));
    const single = await summarizeFiles([one]);
    const both = await summarizeFiles([one, copy]);
    expect(both.total.tokens).toEqual({ input: 11, output: 6, cacheRead: 100, cacheCreation: 7 });
    expect(both.total.tokens).toEqual(single.total.tokens);
    expect(both.total.toolCalls).toBe(2);
    expect(both.total.turns).toBe(single.total.turns * 2);
    expect(both.total.workIntelligenceOperations).toEqual({
      "work_read/work_search_memory": { calls: 1, resultChars: 30 },
    });
    expect(both.formats.claudeCodeLines).toBe(single.formats.claudeCodeLines * 2);
  });

  it("handles CRLF files and keeps an unterminated last line out of the offset", async () => {
    const complete = jsonl(FIRST, "\r\n");
    const path = fileOf("crlf.jsonl", complete + JSON.stringify(MORE[0]));
    const extracted = await extractFile(path);
    expect(extracted.records).toHaveLength(FIRST.length);
    expect(extracted.offset).toBe(Buffer.byteLength(complete));
    expect(extracted.tail.records).toHaveLength(1);
    const report = await summarizeFiles([path]);
    expect(report.formats.claudeCodeLines).toBe(FIRST.length + 1);
  });

  it("reads from a start offset and counts only the bytes it read", async () => {
    const head = jsonl(FIRST);
    const path = fileOf("start.jsonl", head + jsonl(MORE));
    const extracted = await extractFile(path, { start: Buffer.byteLength(head) });
    expect(extracted.records).toHaveLength(MORE.length);
    expect(extracted.bytesRead).toBe(Buffer.byteLength(jsonl(MORE)));
  });
});

describe("incremental cache", () => {
  it("reuses an unchanged file without reading it", async () => {
    const path = fileOf("a.jsonl", jsonl(FIRST));
    const cache = new UsageCache();
    const cold = await summarizeFiles([path], { cache });
    expect(cold.cache).toMatchObject({ reused: 0, appended: 0, parsed: 1 });
    expect(cold.cache.bytesRead).toBe(statSync(path).size);
    const warm = await summarizeFiles([path], { cache });
    expect(warm.cache).toEqual({ reused: 1, appended: 0, parsed: 0, bytesRead: 0 });
    expect(comparable(warm)).toEqual(comparable(cold));
  });

  it("reads only the appended bytes of a grown file", async () => {
    const path = fileOf("a.jsonl", jsonl(FIRST));
    const cache = new UsageCache();
    await summarizeFiles([path], { cache });
    appendFileSync(path, jsonl(MORE));
    const grown = await summarizeFiles([path], { cache });
    expect(grown.cache).toEqual({ reused: 0, appended: 1, parsed: 0, bytesRead: Buffer.byteLength(jsonl(MORE)) });
    expect(comparable(grown)).toEqual(comparable(await summarizeFiles([path])));
    expect((await summarizeFiles([path], { cache })).cache.reused).toBe(1);
  });

  it("re-reads an unterminated last line and completes it when the file grows", async () => {
    const whole = jsonl([...FIRST, ...MORE]);
    const cut = whole.length - 40;
    const path = fileOf("partial.jsonl", whole.slice(0, cut));
    const cache = new UsageCache();
    const first = await summarizeFiles([path], { cache });
    expect(first.skippedLines).toBe(1);
    appendFileSync(path, whole.slice(cut));
    const second = await summarizeFiles([path], { cache });
    expect(second.cache.appended).toBe(1);
    expect(second.skippedLines).toBe(0);
    expect(comparable(second)).toEqual(comparable(await summarizeFiles([path])));
    const noNewline = fileOf("tail.jsonl", jsonl(FIRST).trimEnd());
    const tailCache = new UsageCache();
    const before = await summarizeFiles([noNewline], { cache: tailCache });
    appendFileSync(noNewline, "\n");
    const after = await summarizeFiles([noNewline], { cache: tailCache });
    expect(after.cache.appended).toBe(1);
    expect(comparable(after)).toEqual(comparable(before));
  });

  it("re-extracts a truncated or rewritten file", async () => {
    const path = fileOf("a.jsonl", jsonl([...FIRST, ...MORE]));
    const cache = new UsageCache();
    await summarizeFiles([path], { cache });
    writeFileSync(path, jsonl(FIRST));
    const truncated = await summarizeFiles([path], { cache });
    expect(truncated.cache).toMatchObject({ reused: 0, appended: 0, parsed: 1 });
    expect(comparable(truncated)).toEqual(comparable(await summarizeFiles([path])));
  });

  it("re-extracts when the prefix hash no longer matches", async () => {
    const path = fileOf("a.jsonl", jsonl(FIRST));
    const cache = new UsageCache();
    await summarizeFiles([path], { cache });
    const rewritten = jsonl([user(0, "different"), ...FIRST.slice(1), ...MORE]);
    writeFileSync(path, rewritten);
    const next = await summarizeFiles([path], { cache });
    expect(next.cache).toMatchObject({ appended: 0, parsed: 1 });
    expect(comparable(next)).toEqual(comparable(await summarizeFiles([path])));
  });

  it("does not cache files with Codex lines and reparses them every scan", async () => {
    const meta = { timestamp: "2026-03-01T00:00:00Z", type: "session_meta", payload: { id: "a" } };
    const path = fileOf("rollout-2026-03-01T00-00-00-aaaaaaaa-0000-4000-8000-000000000001.jsonl", jsonl([meta]));
    const cache = new UsageCache();
    await summarizeFiles([path], { cache });
    const again = await summarizeFiles([path], { cache });
    expect(cache.size).toBe(0);
    expect(again.cache).toMatchObject({ reused: 0, parsed: 1 });
    expect(again.formats.codexLines).toBe(1);
  });

  it("skips a file older than since without reading it", async () => {
    const path = fileOf("old.jsonl", jsonl(FIRST));
    utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const cache = new UsageCache();
    const report = await summarizeFiles([path], { cache, since: "2026-01-01T00:00:00Z" });
    expect(report.cache).toEqual({ reused: 0, appended: 0, parsed: 0, bytesRead: 0 });
    expect(report.formats.claudeCodeLines).toBe(0);
    expect(report.sessions).toHaveLength(0);
  });

  it("persists to a file with owner-only permissions and ignores a corrupt or foreign file", async () => {
    const path = fileOf("a.jsonl", jsonl(FIRST));
    const cacheFile = join(base, `cache-${counter}`, "nested", "usage-cache.json");
    const cache = new UsageCache({ file: cacheFile });
    await cache.load();
    const cold = await summarizeFiles([path], { cache });
    await cache.save();
    if (process.platform !== "win32") expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
    const reloaded = new UsageCache({ file: cacheFile });
    await reloaded.load();
    const warm = await summarizeFiles([path], { cache: reloaded });
    expect(warm.cache).toMatchObject({ reused: 1, parsed: 0 });
    expect(comparable(warm)).toEqual(comparable(cold));
    for (const body of [
      "{ not json",
      JSON.stringify({ version: 999, entries: {} }),
      JSON.stringify({ version: 1, entries: { x: 1 } }),
    ]) {
      writeFileSync(cacheFile, body);
      const ignored = new UsageCache({ file: cacheFile });
      await ignored.load();
      expect(ignored.size).toBe(0);
    }
    const blocked = new UsageCache({ file: join(path, "cannot", "cache.json") });
    blocked.set("x", {
      version: 1,
      mtimeMs: 0,
      size: 0,
      offset: 0,
      prefixHash: "",
      evidence: false,
      records: [],
      skippedLines: 0,
      tail: { records: [], skippedLines: 0 },
    });
    await expect(blocked.save()).resolves.toBeUndefined();
    chmodSync(cacheFile, 0o600);
  });
});

describe("limits", () => {
  it("throws UsageScanAbortedError for an aborted signal, without a path in the message", async () => {
    const path = fileOf("a.jsonl", jsonl(FIRST));
    const controller = new AbortController();
    controller.abort();
    const error = await summarizeFiles([path], { signal: controller.signal }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageScanAbortedError);
    expect(String((error as Error).message)).not.toContain(base);
  });

  it("throws UsageScanTimeoutError once the deadline has passed", async () => {
    const path = fileOf("a.jsonl", jsonl(FIRST));
    const error = await summarizeFiles([path], { deadlineMs: Date.now() - 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageScanTimeoutError);
    expect(String((error as Error).message)).not.toContain(base);
  });

  it("stops in the middle of a file when aborted while reading", async () => {
    const lines = Array.from({ length: 2000 }, (_, index) => user(index % 50, "x".repeat(200)));
    const path = fileOf("big.jsonl", jsonl(lines));
    const controller = new AbortController();
    const scan = summarizeFiles([path], { signal: controller.signal });
    controller.abort();
    await expect(scan).rejects.toBeInstanceOf(UsageScanAbortedError);
  });

  it("rejects an invalid range", async () => {
    await expect(summarizeFiles([], { since: "nope" })).rejects.toThrow("expected an ISO 8601 date");
  });
});
