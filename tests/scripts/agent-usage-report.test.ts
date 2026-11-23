import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeFiles, summarizeShapes } from "../../scripts/agent-usage-report.mjs";

const SECRET = "FICTIONAL-SECRET-CONTENT-123";
const FAKE_PATH = "/home/fictional/project-x";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const SCRIPT = join(__dirname, "..", "..", "scripts", "agent-usage-report.mjs");

let root = "";
let mainFile = "";

function assistant(id: string, timestamp: string, content: unknown[], usage: Record<string, number>, extra = {}) {
  return {
    type: "assistant",
    sessionId: SESSION_ID,
    timestamp,
    cwd: FAKE_PATH,
    gitBranch: "fictional-branch",
    message: { id, model: "fictional-model", role: "assistant", content, usage },
    ...extra,
  };
}

function user(timestamp: string, content: unknown) {
  return { type: "user", sessionId: SESSION_ID, timestamp, cwd: FAKE_PATH, message: { role: "user", content } };
}

const toolUse = (id: string, name: string) => ({
  type: "tool_use",
  id,
  name,
  input: { file_path: `${FAKE_PATH}/a.ts`, note: SECRET },
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "usage-report-"));
  const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 };
  const lines = [
    user("2026-01-01T00:00:00Z", `${SECRET} ${FAKE_PATH}`),
    // Same message id over three streamed lines: usage counts once, output takes the max.
    assistant("msg_1", "2026-01-01T00:00:01Z", [{ type: "text", text: SECRET }], { ...usage, output_tokens: 1 }),
    assistant("msg_1", "2026-01-01T00:00:01Z", [toolUse("tu_1", "Read")], { ...usage, output_tokens: 20 }),
    assistant("msg_1", "2026-01-01T00:00:01Z", [toolUse("tu_2", "mcp__wi__work_search_memory")], {
      ...usage,
      output_tokens: 20,
    }),
    // tool_use repeated on a later line is not counted twice.
    assistant(
      "msg_2",
      "2026-01-01T00:00:02Z",
      [toolUse("tu_2", "mcp__wi__work_search_memory"), toolUse("tu_3", "mcp__other__lookup")],
      {
        input_tokens: 1,
        output_tokens: 2,
      },
    ),
    assistant(
      "msg_3",
      "2026-01-01T00:00:03Z",
      [toolUse("tu_4", "bad name/with slash")],
      { output_tokens: 3 },
      { isSidechain: true },
    ),
    user("2026-01-01T00:00:04Z", [
      { type: "tool_result", tool_use_id: "tu_2", content: "x".repeat(40), is_error: false },
      { type: "tool_result", tool_use_id: "tu_3", content: [{ type: "text", text: "y".repeat(7) }, { type: "image" }] },
      { type: "tool_result", tool_use_id: "tu_1", content: "z".repeat(1000) },
      { type: "tool_result", tool_use_id: "tu_missing", content: "q".repeat(9) },
    ]),
    // A subagent prompt and an injected meta line are not human turns; an array-of-text prompt is.
    { ...user("2026-01-01T00:00:05Z", "subagent prompt"), isSidechain: true },
    { ...user("2026-01-01T00:00:05Z", "injected meta"), isMeta: true },
    user("2026-01-01T00:00:06Z", [{ type: "text", text: SECRET }]),
    user("2026-01-02T00:00:00Z", "second prompt"),
    { type: "attachment", sessionId: SESSION_ID, message: { content: SECRET } },
    "{ not json",
  ];
  mainFile = join(root, "main.jsonl");
  writeFileSync(mainFile, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
  mkdirSync(join(root, "nested", "deeper"), { recursive: true });
  writeFileSync(
    join(root, "nested", "deeper", "other.jsonl"),
    JSON.stringify({ ...user("2026-01-03T00:00:00Z", "hello"), sessionId: "other-session" }),
  );
  writeFileSync(join(root, "nested", "ignored.txt"), JSON.stringify(user("2026-01-03T00:00:00Z", "no")));
  writeFileSync(
    join(root, "codex.jsonl"),
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { cwd: FAKE_PATH } }),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("summarizeFiles", () => {
  it("dedups usage by message id and tool_use by id", async () => {
    const report = await summarizeFiles([mainFile]);
    expect(report.sessions).toHaveLength(1);
    const [session] = report.sessions;
    expect(session.assistantMessages).toBe(3);
    expect(session.tokens).toEqual({ input: 11, output: 25, cacheRead: 100, cacheCreation: 5 });
    expect(session.toolCalls).toBe(4);
    expect(session.turns).toBe(3);
    expect(session.sidechainLines).toBe(2);
    expect(report.skippedLines).toBe(1);
  });

  it("groups tools and splits Work Intelligence tools", async () => {
    const { total } = await summarizeFiles([mainFile]);
    expect(total.workIntelligenceTools).toEqual({ work_search_memory: 1 });
    expect(total.toolCallsByName).toEqual({ Read: 1, mcp__other__lookup: 1, "(other)": 1 });
  });

  it("sums MCP tool_result characters", async () => {
    const { total } = await summarizeFiles([mainFile]);
    expect(total.workIntelligenceToolResultChars).toBe(40);
    expect(total.mcpToolResultChars).toBe(47);
    expect(total.unknownToolResultChars).toBe(9);
  });

  it("filters by time range and excludes lines without a timestamp", async () => {
    const report = await summarizeFiles([mainFile], { since: "2026-01-01T00:00:02Z", until: "2026-01-01T00:00:03Z" });
    expect(report.total.assistantMessages).toBe(2);
    expect(report.total.turns).toBe(0);
    expect(report.sessions[0].firstTimestamp).toBe("2026-01-01T00:00:02.000Z");
    await expect(summarizeFiles([mainFile], { since: "nope" })).rejects.toThrow();
  });

  it("recurses into directories and detects Codex lines without crediting an empty rollout", async () => {
    const report = await summarizeFiles([root]);
    expect(report.sessions).toHaveLength(3);
    expect(report.total.turns).toBe(4);
    expect(report.formats.codexLines).toBe(1);
    expect(report.formats.claudeCodeLines).toBeGreaterThan(10);
    expect(report.codexIgnoredLines).toBe(0);
  });
});

describe("CLI output", () => {
  it.each([[["--json"]], [[]]])("never prints content, paths or raw session ids (%j)", (flags) => {
    const output = execFileSync("node", [SCRIPT, ...flags, root], { encoding: "utf8" });
    for (const forbidden of [SECRET, FAKE_PATH, "project-x", "fictional-branch", SESSION_ID, "other-session", root]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain("session-1");
  });

  it("emits a parsable report with --json and usage with --help", () => {
    const parsed = JSON.parse(execFileSync("node", [SCRIPT, "--json", mainFile], { encoding: "utf8" }));
    expect(parsed.formats).toEqual({ claudeCodeLines: 11, codexLines: 0 });
    expect(parsed.skippedLines).toBe(1);
    expect(execFileSync("node", [SCRIPT, "--help"], { encoding: "utf8" })).toContain("Usage:");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Codex (experimental). Every text/path/argument/cwd field carries CANARY, which must never reach any output.
// ---------------------------------------------------------------------------------------------------------------
const CANARY = "CANARY-CODEX-SECRET-777";
const PARENT = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "bbbbbbbb-0000-4000-8000-000000000002";
const T0 = Date.parse("2026-02-01T00:00:00Z");
const at = (second: number) => new Date(T0 + second * 1000).toISOString();

let codexRoot = "";
let codexCase = 0;

type Raw = Record<string, unknown>;
const codexMeta = (second: number, id: string, extra: Raw = {}) => ({
  timestamp: at(second),
  type: "session_meta",
  payload: { id, cwd: `${FAKE_PATH}/${CANARY}`, instructions: CANARY, source: "cli", originator: CANARY, ...extra },
});
const event = (second: number, payload: Raw) => ({ timestamp: at(second), type: "event_msg", payload });
const item = (second: number, payload: Raw) => ({ timestamp: at(second), type: "response_item", payload });
const usageOf = (input: number, cached: number, output: number, extra: Raw = {}) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
  ...extra,
});
const tokenCount = (second: number, total: Raw | null, last?: Raw) =>
  event(second, {
    type: "token_count",
    info: total === null ? null : { total_token_usage: total, last_token_usage: last, model_context_window: 1000 },
    rate_limits: { note: CANARY },
  });
const userEvent = (second: number, extra: Raw = {}) =>
  event(second, { type: "user_message", message: CANARY, images: [], ...extra });
const call = (second: number, callId: string | undefined, name: string, extra: Raw = {}) =>
  item(second, { type: "function_call", name, arguments: JSON.stringify({ cmd: CANARY }), call_id: callId, ...extra });
const output = (second: number, callId: string, out: unknown, type = "function_call_output") =>
  item(second, { type, call_id: callId, output: out });

/** Writes a rollout named like a real Codex file into its own directory and returns that directory. */
function codexDir(files: Record<string, unknown[]>): string {
  codexCase += 1;
  const dir = join(codexRoot, `case-${codexCase}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, name), lines.map((line) => JSON.stringify(line)).join("\n"));
  }
  return dir;
}
const rolloutName = (id: string, stamp = "2026-02-01T00-00-00") => `rollout-${stamp}-${id}.jsonl`;

describe("Codex rollouts", () => {
  beforeAll(() => {
    codexRoot = mkdtempSync(join(tmpdir(), "usage-report-codex-"));
  });
  afterAll(() => {
    rmSync(codexRoot, { recursive: true, force: true });
  });

  it("legacy profile: token_count deltas, duplicates, string output, user_message turns", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        userEvent(1),
        userEvent(2),
        call(3, "c1", "shell"),
        tokenCount(4, usageOf(100, 40, 10), usageOf(100, 40, 10)),
        tokenCount(5, usageOf(100, 40, 10), usageOf(100, 40, 10)),
        output(6, "c1", "x".repeat(12)),
        tokenCount(
          7,
          usageOf(250, 100, 30, { reasoning_output_tokens: 6 }),
          usageOf(150, 60, 20, { reasoning_output_tokens: 6 }),
        ),
        { timestamp: at(8), type: "turn_context", payload: { cwd: CANARY } },
      ],
    });
    const report = await summarizeFiles([dir]);
    expect(report.sessions).toHaveLength(1);
    const [session] = report.sessions;
    expect(session.tokens).toEqual({ input: 150, output: 30, cacheRead: 100, cacheCreation: 0, reasoningOutput: 6 });
    expect(session.assistantMessages).toBe(2);
    expect(session.turns).toBe(2);
    expect(session.toolCalls).toBe(1);
    expect(session.toolCallsByName).toEqual({ shell: 1 });
    expect(session.mcpToolResultChars).toBe(0);
    expect(session.unknownToolResultChars).toBe(0);
    expect(session.firstTimestamp).toBe(at(0));
    expect(report.formats).toEqual({ claudeCodeLines: 0, codexLines: 9 });
    expect(report.codexTokenMismatches).toBe(0);
    expect(report.codexIgnoredLines).toBe(1);
  });

  it("mid profile: {content, success} output, MCP work tool, task_started turns deduped by turn_id", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        event(1, { type: "task_started", turn_id: "t1" }),
        event(2, { type: "task_started", turn_id: "t1" }),
        event(3, { type: "task_started", turn_id: "t2" }),
        item(4, { type: "message", role: "user", content: [{ type: "input_text", text: "<environment>" }] }),
        call(5, "m1", "mcp__wi__work_search_memory"),
        output(6, "m1", { content: "y".repeat(30), success: true }, "custom_tool_call_output"),
        output(7, "unknown", "q".repeat(9)),
      ],
    });
    const { total } = await summarizeFiles([dir]);
    expect(total.turns).toBe(2);
    expect(total.workIntelligenceTools).toEqual({ work_search_memory: 1 });
    expect(total.workIntelligenceToolResultChars).toBe(30);
    expect(total.mcpToolResultChars).toBe(30);
    expect(total.unknownToolResultChars).toBe(9);
  });

  it("current profile: namespace, body, token_usage_record fallback, item_completed turns (never summed)", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        event(1, { type: "item_completed", turn_id: "a", item: { type: "UserMessage", content: [{ text: CANARY }] } }),
        event(2, { type: "item_completed", turn_id: "a", item: { type: "UserMessage" } }),
        event(3, { type: "item_completed", turn_id: "b", item: { type: "user_message" } }),
        event(4, { type: "item_completed", turn_id: "c", item: { type: "AgentMessage" } }),
        item(5, { type: "message", role: "user", content: [{ type: "input_text", text: ` ${CANARY}` }] }),
        item(5, { type: "message", role: "user", content: [{ type: "input_text", text: CANARY }] }),
        item(6, {
          type: "function_call",
          name: "work_get_project",
          namespace: "mcp__wi__",
          arguments: CANARY,
          call_id: "n1",
        }),
        item(7, { type: "function_call", name: "lookup", namespace: "mcp__srv__", call_id: "n2" }),
        item(8, { type: "local_shell_call", call_id: "n3", action: { command: [CANARY] } }),
        output(9, "n1", { body: "z".repeat(7), success: true }),
        output(10, "n2", [
          { type: "input_text", text: "abcd" },
          { type: "input_image", image_url: CANARY },
        ]),
        output(11, "n1", "ignored second output"),
        {
          timestamp: at(12),
          type: "token_usage_record",
          payload: { response_id: "r1", usage: usageOf(50, 10, 5), note: CANARY },
        },
        {
          timestamp: at(13),
          type: "token_usage_record",
          payload: { response_id: "r1", usage: usageOf(50, 10, 5) },
        },
        {
          timestamp: at(14),
          type: "token_usage_record",
          payload: { response_id: "r2", usage: usageOf(20, 0, 3, { cache_write_input_tokens: 4 }) },
        },
      ],
    });
    const { total } = await summarizeFiles([dir]);
    expect(total.turns).toBe(2);
    expect(total.toolCallsByName).toEqual({ mcp__srv__lookup: 1, local_shell: 1 });
    expect(total.workIntelligenceTools).toEqual({ work_get_project: 1 });
    expect(total.workIntelligenceToolResultChars).toBe(7);
    expect(total.mcpToolResultChars).toBe(11);
    expect(total.unknownToolResultChars).toBe(0);
    expect(total.tokens).toEqual({ input: 60, output: 8, cacheRead: 10, cacheCreation: 4, reasoningOutput: 0 });
    expect(total.assistantMessages).toBe(2);
  });

  it("ignores info: null and falls back to token_usage_record only when no token_count was usable", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        tokenCount(1, null),
        { timestamp: at(2), type: "token_usage_record", payload: { response_id: "r1", usage: usageOf(10, 0, 1) } },
      ],
    });
    const report = await summarizeFiles([dir]);
    expect(report.total.tokens.input).toBe(10);
    expect(report.codexTokenSourceDisagreements).toBe(0);
  });

  it("never adds token_usage_record to token_count and flags disagreement", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        tokenCount(1, usageOf(100, 0, 10), usageOf(100, 0, 10)),
        { timestamp: at(2), type: "token_usage_record", payload: { response_id: "r1", usage: usageOf(90, 0, 10) } },
      ],
    });
    const report = await summarizeFiles([dir]);
    expect(report.total.tokens).toMatchObject({ input: 100, output: 10 });
    expect(report.codexTokenSourceDisagreements).toBe(1);
  });

  it("treats a lower counter as a reset and counts last_token_usage; counts mismatches against last", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        tokenCount(1, usageOf(100, 0, 10), usageOf(100, 0, 10)),
        tokenCount(2, usageOf(30, 0, 5), usageOf(30, 0, 5)),
        tokenCount(3, usageOf(50, 0, 9), usageOf(20, 0, 4)),
        tokenCount(4, usageOf(80, 0, 9), usageOf(1, 0, 1)),
      ],
    });
    const report = await summarizeFiles([dir]);
    expect(report.total.tokens).toMatchObject({ input: 100 + 30 + 20 + 30, output: 10 + 5 + 4 });
    expect(report.total.assistantMessages).toBe(4);
    expect(report.codexTokenMismatches).toBe(1);
  });

  it("does not double count a forked session's copied history", async () => {
    const copied = [tokenCount(2, usageOf(100, 0, 10)), call(3, "shared", "shell"), tokenCount(4, usageOf(200, 0, 20))];
    const dir = codexDir({
      [rolloutName(PARENT, "2026-02-01T00-00-00")]: [codexMeta(0, PARENT), ...copied],
      [rolloutName(CHILD, "2026-02-01T00-10-00")]: [
        codexMeta(600, CHILD, { forked_from_id: PARENT }),
        ...copied.map((line) => ({ ...line, timestamp: at(601) })),
        tokenCount(605, usageOf(300, 0, 30)),
      ],
    });
    const report = await summarizeFiles([dir]);
    expect(report.sessions).toHaveLength(2);
    expect(report.total.tokens).toMatchObject({ input: 300, output: 30 });
    expect(report.total.assistantMessages).toBe(3);
    expect(report.total.toolCalls).toBe(1);
    expect(report.codexForkedSessions).toBe(1);
  });

  it("advances tracking outside the range and credits only in-range deltas", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        userEvent(1),
        call(2, "early", "shell"),
        tokenCount(3, usageOf(100, 0, 10)),
        tokenCount(10, usageOf(200, 0, 20)),
        userEvent(11),
        call(12, "late", "mcp__wi__work_x"),
        tokenCount(20, usageOf(300, 0, 30)),
        tokenCount(40, usageOf(900, 0, 90)),
      ],
    });
    const report = await summarizeFiles([dir], { since: at(10), until: at(20) });
    expect(report.total.tokens).toMatchObject({ input: 200, output: 20 });
    expect(report.total.turns).toBe(1);
    expect(report.total.toolCalls).toBe(1);
    expect(report.total.toolCallsByName).toEqual({});
    expect(report.sessions[0].firstTimestamp).toBe(at(10));
    expect(report.sessions[0].lastTimestamp).toBe(at(20));
  });

  it("never echoes an unsafe tool name", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        call(1, "u1", `bad name ${CANARY}/x`),
        call(2, "u2", `${CANARY} x`, { namespace: "mcp__srv__" }),
      ],
    });
    const { total } = await summarizeFiles([dir]);
    expect(total.toolCallsByName).toEqual({ "(other)": 2 });
    expect(JSON.stringify(total)).not.toContain(CANARY);
  });

  it("handles mcp_tool_call_begin before, after and without a function_call, and mcp_tool_call_end results", async () => {
    const begin = (second: number, callId: string, server: string, tool: string) =>
      event(second, { type: "mcp_tool_call_begin", call_id: callId, invocation: { server, tool, arguments: CANARY } });
    const end = (second: number, callId: string, result: unknown) =>
      event(second, { type: "mcp_tool_call_end", call_id: callId, invocation: { server: "wi", tool: "x" }, result });
    const ok = (text: string) => ({ Ok: { content: [{ type: "text", text }, { type: "image" }] } });
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        // begin first, then the function_call with the same id: one call, classified from the begin event.
        begin(1, "b1", "wi", "work_get"),
        call(2, "b1", "mcp_call"),
        end(3, "b1", ok("123")),
        output(4, "b1", "12345678"),
        // begin without any function_call.
        begin(5, "b2", "srv", "ping"),
        end(6, "b2", ok("hello")),
        // function_call first, begin afterwards moves the count into the work map.
        call(7, "b3", "do_it"),
        begin(8, "b3", "wi", "work_list"),
        end(9, "b3", { Err: "boom boom" }),
        // a call that is MCP only because of its begin event, with an unsafe server name.
        begin(10, "b4", `evil ${CANARY}`, "t"),
        // no call_id: counted, not deduplicated.
        call(11, undefined, "shell"),
        call(12, undefined, "shell"),
      ],
    });
    const { total } = await summarizeFiles([dir]);
    expect(total.workIntelligenceTools).toEqual({ work_get: 1, work_list: 1 });
    expect(total.toolCallsByName).toEqual({ mcp__srv__ping: 1, "(other)": 1, shell: 2 });
    expect(total.toolCalls).toBe(6);
    // b1: output item wins over end (8, not 3); b2: end only (5); b3: end Err only (9).
    expect(total.workIntelligenceToolResultChars).toBe(8 + 9);
    expect(total.mcpToolResultChars).toBe(8 + 5 + 9);
    expect(total.unknownToolResultChars).toBe(0);
  });

  it("counts code-mode McpToolCall items that have no function_call", async () => {
    const mcpItem = (second: number, id: string, server: string, tool: string, text: string) =>
      event(second, {
        type: "item_completed",
        turn_id: "t1",
        item: {
          type: "McpToolCall",
          id,
          server,
          tool,
          arguments: CANARY,
          status: "completed",
          result: { content: [{ type: "text", text }], isError: false },
        },
      });
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        // code mode: the MCP call runs inside exec, so only exec is a custom_tool_call.
        item(1, { type: "custom_tool_call", name: "exec", call_id: "x1", input: CANARY }),
        mcpItem(2, "m1", "work-intelligence", "work_read", "1234567890"),
        mcpItem(3, "m1", "work-intelligence", "work_read", "1234567890"),
        mcpItem(4, "m2", "codex", "list_mcp_resources", "abc"),
        output(5, "x1", `${CANARY} exec output`, "custom_tool_call_output"),
        // a direct MCP function_call with the same id as an item: counted once, the output item wins.
        call(6, "m3", "mcp__wi__work_search"),
        mcpItem(7, "m3", "wi", "work_search", "12"),
        output(8, "m3", "1234"),
        // unsafe server name.
        mcpItem(9, "m4", `evil ${CANARY}`, "t", "zz"),
      ],
    });
    const report = await summarizeFiles([dir]);
    const { total } = report;
    expect(total.toolCalls).toBe(5);
    expect(total.workIntelligenceTools).toEqual({ work_read: 1, work_search: 1 });
    expect(total.toolCallsByName).toEqual({ exec: 1, mcp__codex__list_mcp_resources: 1, "(other)": 1 });
    expect(total.workIntelligenceToolResultChars).toBe(10 + 4);
    expect(total.mcpToolResultChars).toBe(10 + 3 + 4 + 2);
    expect(JSON.stringify(report)).not.toContain(CANARY);
  });

  it("does not flag the carried-over history of a rollout that starts after compaction", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        { timestamp: at(1), type: "compacted", payload: { message: CANARY } },
        // the first total already holds 500 input tokens from before compaction.
        tokenCount(2, usageOf(600, 0, 20), usageOf(100, 0, 20)),
        tokenCount(3, usageOf(650, 0, 25), usageOf(50, 0, 5)),
        { timestamp: at(4), type: "token_usage_record", payload: { response_id: "r1", usage: usageOf(100, 0, 20) } },
        { timestamp: at(5), type: "token_usage_record", payload: { response_id: "r2", usage: usageOf(50, 0, 5) } },
      ],
    });
    const report = await summarizeFiles([dir]);
    expect(report.total.tokens).toMatchObject({ input: 650, output: 25 });
    expect(report.codexTokenMismatches).toBe(0);
    expect(report.codexTokenSourceDisagreements).toBe(0);
  });

  it("treats subagent rollouts as sidechain lines without turns", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT, { source: { subagent: { thread_spawn: { parent: CANARY } } } }),
        userEvent(1),
        tokenCount(2, usageOf(10, 0, 1)),
      ],
    });
    const { total } = await summarizeFiles([dir]);
    expect(total.turns).toBe(0);
    expect(total.sidechainLines).toBe(3);
    expect(total.tokens.input).toBe(10);
  });

  it("keys sessions by file UUID, falling back to session_meta id and then path", async () => {
    const dir = codexDir({
      "rollout-no-uuid-a.jsonl": [codexMeta(0, "meta-id-1"), userEvent(1)],
      "rollout-no-uuid-b.jsonl": [codexMeta(0, "meta-id-1"), userEvent(2)],
      "rollout-no-uuid-c.jsonl": [userEvent(3)],
    });
    const report = await summarizeFiles([dir]);
    expect(report.sessions).toHaveLength(2);
    expect(report.total.turns).toBe(3);
  });
});

describe("Codex CLI output", () => {
  it.each([[["--json"]], [[]], [["--debug-shape"]]])("never prints canary content (%j)", async (flags) => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        userEvent(1),
        call(2, "c1", `bad ${CANARY}`),
        { ...call(3, "c2", "shell"), extra: { [`key with ${CANARY}`]: CANARY, ok_key: [1, "a", { deep: CANARY }] } },
        output(4, "c2", CANARY),
        tokenCount(5, usageOf(10, 5, 1)),
        { timestamp: at(6), type: `weird ${CANARY}`, payload: { type: `other ${CANARY}`, data: CANARY } },
      ],
    });
    const out = execFileSync("node", [SCRIPT, ...flags, dir], { encoding: "utf8" });
    for (const forbidden of [CANARY, FAKE_PATH, PARENT, dir]) expect(out).not.toContain(forbidden);
    if (flags[0] === "--debug-shape") {
      expect(out).toContain("session_meta/-");
      expect(out).toContain("(other)/(other)");
      expect(out).toContain("event_msg/token_count");
      expect(out).toContain("payload.info.total_token_usage.input_tokens: number");
      expect(out).toContain("extra.(key): string");
      expect(out).toContain("extra.ok_key[]: number|object|string");
    } else if (flags.length === 0) {
      expect(out).toContain("codex: experimental, not verified against real logs");
      expect(out).toContain("token mismatches=0");
    } else {
      expect(JSON.parse(out).formats.codexLines).toBe(7);
    }
  });

  it("does not print the codex notice for Claude-only input and shapes Claude files too", async () => {
    expect(execFileSync("node", [SCRIPT, mainFile], { encoding: "utf8" })).not.toContain("codex:");
    const shapes = await summarizeShapes([mainFile]);
    expect(shapes.shapes.map((shape) => shape.key)).toEqual(["assistant/-", "attachment/-", "user/-"]);
    const out = execFileSync("node", [SCRIPT, "--debug-shape", mainFile], { encoding: "utf8" });
    expect(out).toContain("message.usage.input_tokens: number");
    expect(out).not.toContain(SECRET);
  });
});
