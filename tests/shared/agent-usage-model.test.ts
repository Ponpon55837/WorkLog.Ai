import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildActiveBlocks,
  formatForAgent,
  safeModelId,
  summarizeFiles,
  UsageCache,
  type UsageEvent,
} from "../../packages/shared/src/agent-usage/index.js";

const CANARY = "MODEL-CANARY-4242";
const SESSION = "11111111-2222-4333-8444-555555555555";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-02-01T00:00:00Z");
const at = (second: number) => new Date(T0 + second * 1000).toISOString();
const dateOf = (time: number) => {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

let base = "";
let counter = 0;

function write(name: string, lines: unknown[]): string {
  counter += 1;
  const dir = join(base, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

const assistant = (second: number, id: string, model: unknown, usage: Record<string, number>, extra = {}) => ({
  type: "assistant",
  sessionId: SESSION,
  timestamp: at(second),
  cwd: `/home/fictional/${CANARY}`,
  message: { id, role: "assistant", ...(model === undefined ? {} : { model }), content: [], usage },
  ...extra,
});

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "usage-model-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("safeModelId", () => {
  it.each(["claude-sonnet-4-5", "gpt-5.1-codex", "openrouter/some-model", "claude-3-5-sonnet@20241022", "a"])(
    "accepts %s",
    (value) => {
      expect(safeModelId(value)).toBe(value);
    },
  );

  it.each([
    "<synthetic>",
    "/Users/a/b",
    "home/x",
    "Users/x",
    "VOLUMES/x",
    "C:foo",
    "a/../b",
    "a..b",
    "a/b/c",
    "x".repeat(97),
    "has space",
    "-leading",
    "seg/-leading",
    "",
  ])("rejects %j", (value) => {
    expect(safeModelId(value)).toBe("");
  });

  it("rejects segments longer than 64 characters and non-strings", () => {
    expect(safeModelId("a".repeat(65))).toBe("");
    expect(safeModelId("a".repeat(64))).toBe("a".repeat(64));
    for (const value of [undefined, null, 5, {}, ["a"]]) expect(safeModelId(value)).toBe("");
  });
});

describe("buildActiveBlocks", () => {
  const event = (agent: UsageEvent["agent"], time: number, input: number, output: number): UsageEvent => ({
    agent,
    time,
    tokens: { input, output, cacheRead: 1000, cacheCreation: 50 },
  });
  const offset330 = () => 330;

  it("starts a block at the local hour of the first event, also in a +05:30 zone", () => {
    // 10:20 UTC is 15:50 at +05:30, so the block starts at 15:00 local = 09:30 UTC.
    const first = Date.parse("2026-02-01T10:20:00Z");
    const [block] = buildActiveBlocks([event("claude-code", first, 10, 5)], first + 30 * 60_000, offset330);
    expect(new Date(block!.start).toISOString()).toBe("2026-02-01T09:30:00.000Z");
    expect(new Date(block!.end).toISOString()).toBe("2026-02-01T14:30:00.000Z");
    expect(block!.elapsedMs).toBe(80 * 60_000);
    expect(block!.remainingMs).toBe(block!.end - (first + 30 * 60_000));
  });

  it("splits at a gap of 5 hours or more and at the block end, keeping only the last block", () => {
    const t = Date.parse("2026-02-01T00:00:00Z");
    const now = t + 11 * HOUR;
    const events = [
      event("codex", t, 1, 1),
      event("codex", t + 2 * HOUR, 2, 2),
      event("codex", t + 7 * HOUR, 4, 4), // 5 hours after the previous usage
      event("codex", t + 10.5 * HOUR, 8, 8),
    ];
    const blocks = buildActiveBlocks(events, now, () => 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.start).toBe(t + 7 * HOUR);
    expect(blocks[0]!.tokens).toMatchObject({ input: 12, output: 12, cacheRead: 2000 });
    expect(blocks[0]!.primary).toBe(24);
    const split = buildActiveBlocks(
      [event("codex", t, 1, 1), event("codex", t + 4.5 * HOUR, 1, 1), event("codex", t + 5 * HOUR, 7, 0)],
      t + 5.5 * HOUR,
      () => 0,
    );
    expect(split[0]!.start).toBe(t + 5 * HOUR);
    expect(split[0]!.primary).toBe(7);
  });

  it("omits blocks that ended or have been idle for 5 hours, per agent", () => {
    const t = Date.parse("2026-02-01T00:00:00Z");
    const events = [event("claude-code", t, 1, 1), event("codex", t + 4 * HOUR, 1, 1)];
    const blocks = buildActiveBlocks(events, t + 5.5 * HOUR, () => 0);
    expect(blocks.map((block) => block.agent)).toEqual(["codex"]);
    expect(buildActiveBlocks(events, t + 9 * HOUR + 1, () => 0)).toEqual([]);
    expect(buildActiveBlocks([], t, () => 0)).toEqual([]);
  });

  it("computes the burn rate from the first activity, and 0 under a minute", () => {
    const t = Date.parse("2026-02-01T00:10:00Z");
    const events = [event("claude-code", t, 100, 50), event("claude-code", t + 10 * 60_000, 100, 50)];
    const [block] = buildActiveBlocks(events, t + 20 * 60_000, () => 0);
    expect(block!.primary).toBe(300);
    expect(block!.primaryPerMinute).toBe(15);
    const [young] = buildActiveBlocks([events[0]!], t + 30_000, () => 0);
    expect(young!.primaryPerMinute).toBe(0);
  });
});

describe("Claude Code models, days and blocks", () => {
  it("credits each message's delta to its model and to local days; primary excludes cache", async () => {
    const file = write("claude.jsonl", [
      assistant(1, "m1", "claude-sonnet-4-5", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 }),
      assistant(2, "m1", "claude-sonnet-4-5", { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 900 }),
      assistant(3, "m2", "<synthetic>", { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 70 }),
      assistant(4, "m3", `/Users/someone/${CANARY}`, { input_tokens: 1, output_tokens: 1 }),
      assistant(5, "m4", undefined, { input_tokens: 3, output_tokens: 0 }),
      assistant(6, "m4", "claude-opus-4-1", { input_tokens: 3, output_tokens: 4 }),
    ]);
    const report = await summarizeFiles([file], { now: T0 + 60_000 });
    const byKey = Object.fromEntries(report.total.models.map((entry) => [`${entry.agent}|${entry.model}`, entry]));
    expect(byKey["claude-code|claude-sonnet-4-5"]).toMatchObject({
      tokens: { input: 10, output: 8, cacheRead: 900, cacheCreation: 0 },
      responses: 1,
    });
    expect(byKey["claude-code|"]).toMatchObject({
      tokens: { input: 6, output: 2, cacheCreation: 70 },
      responses: 3,
    });
    expect(byKey["claude-code|claude-opus-4-1"]).toMatchObject({ tokens: { input: 0, output: 4 }, responses: 0 });
    expect(report.total.models[0]!.model).toBe("claude-sonnet-4-5");
    expect(report.total.tokens).toMatchObject({ input: 16, output: 14, cacheRead: 900, cacheCreation: 70 });
    expect(report.sessions[0]!.models).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain(CANARY);
    expect(formatForAgent(report)).not.toContain(CANARY);
    expect(report.total.daily).toEqual([
      { date: dateOf(T0 + 1000), tokens: { input: 16, output: 14, cacheRead: 900, cacheCreation: 70 } },
    ]);
  });

  it("keeps the model of a cached message after an incremental append", async () => {
    const file = write("cached.jsonl", [
      assistant(1, "m1", "claude-sonnet-4-5", { input_tokens: 4, output_tokens: 6 }),
    ]);
    const cache = new UsageCache();
    const first = await summarizeFiles([file], { cache, now: T0 + 60_000 });
    expect(first.cache.parsed).toBe(1);
    appendFileSync(
      file,
      [
        JSON.stringify(assistant(2, "m1", undefined, { input_tokens: 4, output_tokens: 9 })),
        JSON.stringify(assistant(3, "m2", "gpt-5.1-codex", { input_tokens: 1, output_tokens: 1 })),
      ].join("\n") + "\n",
    );
    const second = await summarizeFiles([file], { cache, now: T0 + 60_000 });
    expect(second.cache.appended).toBe(1);
    const sonnet = second.total.models.find((entry) => entry.model === "claude-sonnet-4-5");
    expect(sonnet).toMatchObject({ tokens: { input: 4, output: 9 }, responses: 1 });
    expect(second.total.models.find((entry) => entry.model === "gpt-5.1-codex")).toMatchObject({ responses: 1 });
    expect(second.total.models.some((entry) => entry.model === "")).toBe(false);
    const cold = await summarizeFiles([file], { now: T0 + 60_000 });
    expect(cold.total.models).toEqual(second.total.models);
  });

  it("groups by local day, leaves lines without a timestamp out of the days and respects the range", async () => {
    const day1 = Date.UTC(2026, 1, 1, 12, 0, 0);
    const day2 = Date.UTC(2026, 1, 3, 12, 0, 0);
    const line = (time: number | null, id: string, input: number) => ({
      ...assistant(0, id, "claude-sonnet-4-5", { input_tokens: input, output_tokens: 1 }),
      timestamp: time === null ? undefined : new Date(time).toISOString(),
    });
    const file = write("days.jsonl", [
      line(day1, "a", 1),
      line(day1 + 1000, "b", 2),
      line(day2, "c", 4),
      line(null, "d", 8),
    ]);
    const report = await summarizeFiles([file], { now: day2 + 1000 });
    expect(report.total.daily.map((day) => [day.date, day.tokens.input])).toEqual([
      [dateOf(day1), 3],
      [dateOf(day2), 4],
    ]);
    expect(report.total.tokens.input).toBe(15);
    expect(report.total.models[0]!.tokens.input).toBe(15);
    const ranged = await summarizeFiles([file], { since: new Date(day2 - 1000).toISOString(), now: day2 + 1000 });
    expect(ranged.total.daily.map((day) => day.tokens.input)).toEqual([4]);
  });

  it("keeps only usage of the last 24 hours for the blocks", async () => {
    const now = Date.parse("2026-02-10T12:00:00Z");
    const line = (offsetMs: number, id: string, input: number) => ({
      ...assistant(0, id, "claude-sonnet-4-5", { input_tokens: input, output_tokens: 1 }),
      timestamp: new Date(now + offsetMs).toISOString(),
    });
    const file = write("blocks.jsonl", [
      line(-30 * HOUR, "old", 1000),
      line(-3 * HOUR, "x", 10),
      line(-2 * HOUR, "y", 20),
    ]);
    const report = await summarizeFiles([file], { now });
    expect(report.blocks).toHaveLength(1);
    const [block] = report.blocks;
    expect(block!.agent).toBe("claude-code");
    expect(block!.tokens).toMatchObject({ input: 30, output: 2 });
    expect(block!.firstActivity).toBe(now - 3 * HOUR);
    expect(block!.lastActivity).toBe(now - 2 * HOUR);
    expect(block!.start % (30 * 60_000)).toBe(0);
    expect(block!.end - block!.start).toBe(5 * HOUR);
    const idle = await summarizeFiles([file], { now: now + 6 * HOUR });
    expect(idle.blocks).toEqual([]);
  });
});

describe("Codex models", () => {
  const ID = "aaaaaaaa-0000-4000-8000-000000000001";
  const NEXT = "bbbbbbbb-0000-4000-8000-000000000002";
  const meta = (second: number, id: string, extra = {}) => ({
    timestamp: at(second),
    type: "session_meta",
    payload: { id, cwd: `/home/fictional/${CANARY}`, source: "cli", ...extra },
  });
  const turn = (second: number, model: unknown) => ({
    timestamp: at(second),
    type: "turn_context",
    payload: { cwd: `/home/fictional/${CANARY}`, model },
  });
  const usage = (input: number, cached: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const count = (second: number, total: Record<string, number>, last: Record<string, number>) => ({
    timestamp: at(second),
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
  });
  const rollout = (id: string) => `rollout-2026-02-01T00-00-00-${id}.jsonl`;

  it("credits each delta to the latest turn_context model and never lets cache into primary", async () => {
    const file = write(rollout(ID), [
      meta(0, ID, { model: "gpt-5.1-codex" }),
      count(1, usage(100, 40, 10), usage(100, 40, 10)),
      turn(2, "gpt-5.1-codex-max"),
      count(3, usage(250, 100, 30), usage(150, 60, 20)),
      turn(4, `/Users/x/${CANARY}`),
      count(5, usage(300, 100, 35), usage(50, 0, 5)),
    ]);
    const report = await summarizeFiles([file], { now: T0 + 60_000 });
    const models = Object.fromEntries(report.total.models.map((entry) => [entry.model, entry]));
    expect(models["gpt-5.1-codex"]).toMatchObject({
      agent: "codex",
      tokens: { input: 60, output: 10, cacheRead: 40 },
      responses: 1,
    });
    expect(models["gpt-5.1-codex-max"]).toMatchObject({
      tokens: { input: 90, output: 20, cacheRead: 60 },
      responses: 1,
    });
    expect(models[""]).toMatchObject({ tokens: { input: 50, output: 5, cacheRead: 0 }, responses: 1 });
    expect(report.total.tokens).toMatchObject({ input: 200, output: 35, cacheRead: 100 });
    expect(JSON.stringify(report)).not.toContain(CANARY);
    expect(report.blocks[0]).toMatchObject({ agent: "codex", primary: 235 });
    expect(report.blocks[0]!.tokens.cacheRead).toBe(100);
  });

  it("credits token_usage_record fallback entries to the model of their time", async () => {
    const record = (second: number, id: string, input: number) => ({
      timestamp: at(second),
      type: "token_usage_record",
      payload: { response_id: id, usage: usage(input, 0, 1) },
    });
    const file = write(rollout(ID), [turn(0, "model-a"), record(1, "r1", 5), turn(2, "model-b"), record(3, "r2", 7)]);
    const report = await summarizeFiles([file], { now: T0 + 60_000 });
    expect(report.total.models.map((entry) => [entry.model, entry.tokens.input, entry.responses])).toEqual([
      ["model-b", 7, 1],
      ["model-a", 5, 1],
    ]);
    expect(report.total.daily).toHaveLength(1);
  });

  it("subtracts a compacted thread from the same model, day and block as the first credited delta", async () => {
    const compacted = (thread: string, total: Record<string, number>, last: Record<string, number>) => ({
      timestamp: at(10),
      type: "compacted",
      payload: {
        latest_token_usage_record: { thread_id: thread, response_id: "x", usage: last, thread_token_usage: total },
      },
    });
    const dir = join(base, "compaction");
    mkdirSync(dir, { recursive: true });
    const files: Record<string, unknown[]> = {
      [rollout(ID)]: [
        meta(0, ID),
        turn(0, "model-a"),
        count(1, usage(100, 0, 10), usage(100, 0, 10)),
        count(2, usage(150, 0, 15), usage(50, 0, 5)),
      ],
      [rollout(NEXT)]: [
        meta(10, NEXT),
        compacted(ID, usage(150, 0, 15), usage(50, 0, 5)),
        turn(10, "model-b"),
        count(11, usage(150, 0, 15), usage(50, 0, 5)),
        count(12, usage(170, 0, 17), usage(20, 0, 2)),
      ],
    };
    for (const [name, lines] of Object.entries(files)) {
      writeFileSync(join(dir, name), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    }
    const report = await summarizeFiles([dir], { now: T0 + 60_000 });
    expect(report.codexCompactionLinked).toBe(1);
    const models = Object.fromEntries(report.total.models.map((entry) => [entry.model, entry]));
    expect(models["model-a"]).toMatchObject({ tokens: { input: 150, output: 15 }, responses: 2 });
    expect(models["model-b"]).toMatchObject({ tokens: { input: 20, output: 2 }, responses: 1 });
    expect(report.total.tokens).toMatchObject({ input: 170, output: 17 });
    expect(report.total.daily.reduce((sum, day) => sum + day.tokens.input, 0)).toBe(170);
    expect(report.blocks[0]!.tokens).toMatchObject({ input: 170, output: 17 });
  });
});

describe("formatForAgent privacy", () => {
  it("never carries a cwd or a path-like model even when the log has both", async () => {
    const file = write("private.jsonl", [
      assistant(1, "m1", `/Users/someone/${CANARY}/model`, { input_tokens: 5, output_tokens: 5 }),
      assistant(2, "m2", "claude-sonnet-4-5", { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 50 }),
    ]);
    for (const locale of ["en", "zh-TW"] as const) {
      const text = formatForAgent(await summarizeFiles([file]), { locale });
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("/Users");
      expect(text).not.toContain("fictional");
      expect(text).toContain("claude-sonnet-4-5");
    }
  });
});
