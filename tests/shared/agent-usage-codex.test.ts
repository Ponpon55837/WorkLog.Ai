import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatForAgent,
  formatShapes,
  formatTable,
  summarizeFiles,
  summarizeShapes,
} from "../../packages/shared/src/agent-usage/index.js";

const FAKE_PATH = "/home/fictional/project-x";

// Every Codex text/path/argument/cwd field below carries CANARY, which must never reach any output.
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
    const session = report.sessions[0]!;
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
    expect(report.codexIgnoredLines).toBe(0);
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
    expect(report.sessions[0]!.firstTimestamp).toBe(at(10));
    expect(report.sessions[0]!.lastTimestamp).toBe(at(20));
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
        begin(1, "b1", "wi", "work_get"),
        call(2, "b1", "mcp_call"),
        end(3, "b1", ok("123")),
        output(4, "b1", "12345678"),
        begin(5, "b2", "srv", "ping"),
        end(6, "b2", ok("hello")),
        call(7, "b3", "do_it"),
        begin(8, "b3", "wi", "work_list"),
        end(9, "b3", { Err: "boom boom" }),
        begin(10, "b4", `evil ${CANARY}`, "t"),
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
        call(6, "m3", "mcp__wi__work_search"),
        mcpItem(7, "m3", "wi", "work_search", "12"),
        output(8, "m3", "1234"),
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

  it("subtracts a compacted thread's usage from its sequel rollout, whatever the file order", async () => {
    const A = "cccccccc-0000-4000-8000-000000000003";
    const B = "dddddddd-0000-4000-8000-000000000004";
    const C = "eeeeeeee-0000-4000-8000-000000000005";
    const record = (thread: string, total: Raw, last: Raw) => ({
      timestamp: at(1),
      type: "compacted",
      payload: {
        message: CANARY,
        latest_token_usage_record: { thread_id: thread, response_id: "x", usage: last, thread_token_usage: total },
      },
    });
    const files = {
      // thread A: two responses, final total 150/0/15.
      [rolloutName(A, "2026-02-01T00-00-01")]: [
        codexMeta(0, A),
        tokenCount(1, usageOf(100, 0, 10), usageOf(100, 0, 10)),
        { timestamp: at(1), type: "token_usage_record", payload: { response_id: "a1", usage: usageOf(100, 0, 10) } },
        tokenCount(2, usageOf(150, 0, 15), usageOf(50, 0, 5)),
        { timestamp: at(2), type: "token_usage_record", payload: { response_id: "a2", usage: usageOf(50, 0, 5) } },
      ],
      // thread B continues A: first total repeats A's total, then one new response.
      [rolloutName(B, "2026-02-01T00-00-02")]: [
        codexMeta(10, B),
        record(A, usageOf(150, 0, 15), usageOf(50, 0, 5)),
        tokenCount(11, usageOf(150, 0, 15), usageOf(50, 0, 5)),
        tokenCount(12, usageOf(170, 0, 17), usageOf(20, 0, 2)),
        { timestamp: at(12), type: "token_usage_record", payload: { response_id: "b1", usage: usageOf(20, 0, 2) } },
      ],
      // thread C continues B.
      [rolloutName(C, "2026-02-01T00-00-03")]: [
        codexMeta(20, C),
        record(B, usageOf(170, 0, 17), usageOf(20, 0, 2)),
        tokenCount(21, usageOf(170, 0, 17), usageOf(20, 0, 2)),
        tokenCount(22, usageOf(200, 0, 20), usageOf(30, 0, 3)),
      ],
    };
    // Read C, B, A (reverse) and A, B, C: the totals must equal thread C's final total either way.
    const dir = codexDir(files);
    const reversed = Object.keys(files)
      .sort()
      .reverse()
      .map((name) => join(dir, name));
    for (const inputs of [[dir], reversed]) {
      const report = await summarizeFiles(inputs);
      expect(report.total.tokens).toMatchObject({ input: 200, output: 20 });
      expect(report.total.assistantMessages).toBe(4);
      expect(report.codexCompactionLinked).toBe(2);
      expect(report.codexCompactionCarryovers).toBe(0);
      expect(report.codexTokenMismatches).toBe(0);
      expect(report.codexTokenSourceDisagreements).toBe(0);
    }
    const alone = await summarizeFiles([join(dir, rolloutName(C, "2026-02-01T00-00-03"))]);
    expect(alone.total.tokens).toMatchObject({ input: 200, output: 20 });
    expect(alone.codexCompactionCarryovers).toBe(1);
  });

  it("skips context outputs without a call_id instead of counting them as unknown", async () => {
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        {
          timestamp: at(1),
          type: "response_item",
          metadata: { additional_context_tool_output: true },
          payload: { type: "function_call_output", id: "o1", name: "open_page", namespace: "agent", output: CANARY },
        },
        output(2, "missing", "1234567"),
      ],
    });
    const report = await summarizeFiles([dir]);
    expect(report.codexContextOutputs).toBe(1);
    expect(report.total.unknownToolResultChars).toBe(7);
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

describe("Codex Work Intelligence operations", () => {
  const OP_SECRET = "OPERATION-CANARY-SECRET-999";

  it("groups Codex function_call arguments, MCP begin arguments and code-mode items by operation", async () => {
    const withArgs = (second: number, callId: string, name: string, args: unknown) =>
      item(second, { type: "function_call", name, arguments: args, call_id: callId });
    const dir = codexDir({
      [rolloutName(PARENT)]: [
        codexMeta(0, PARENT),
        withArgs(1, "k1", "mcp__wi__work_read", JSON.stringify({ operation: "work_search_memory", q: OP_SECRET })),
        withArgs(2, "k2", "mcp__wi__work_read", JSON.stringify({ operation: `no ${OP_SECRET}` })),
        withArgs(3, "k3", "mcp__wi__work_write_additive", "{ not json"),
        withArgs(4, "k4", "mcp__wi__work_read", undefined),
        output(5, "k1", "x".repeat(12)),
        output(6, "k2", "x".repeat(4)),
        event(7, {
          type: "mcp_tool_call_begin",
          call_id: "k5",
          invocation: { server: "wi", tool: "work_read", arguments: { operation: "work_get_context", n: OP_SECRET } },
        }),
        event(8, {
          type: "mcp_tool_call_end",
          call_id: "k5",
          invocation: { server: "wi", tool: "work_read" },
          result: { Ok: { content: [{ type: "text", text: "123456" }] } },
        }),
        call(9, "k6", "do_it"),
        event(10, {
          type: "mcp_tool_call_begin",
          call_id: "k6",
          invocation: { server: "wi", tool: "work_write_overwrite", arguments: { operation: OP_SECRET } },
        }),
        event(11, {
          type: "item_completed",
          turn_id: "t1",
          item: {
            type: "McpToolCall",
            id: "k7",
            server: "wi",
            tool: "work_write_idempotent",
            arguments: { operation: "work_set_title" },
            result: { content: [{ type: "text", text: "12" }] },
          },
        }),
        event(12, {
          type: "item_completed",
          turn_id: "t1",
          item: { type: "McpToolCall", id: "k8", server: "wi", tool: "work_read", result: { content: [] } },
        }),
      ],
    });
    const report = await summarizeFiles([dir]);
    expect(report.total.workIntelligenceOperations).toEqual({
      "work_read/work_search_memory": { calls: 1, resultChars: 12 },
      "work_read/(unknown)": { calls: 3, resultChars: 4 },
      "work_write_additive/(unknown)": { calls: 1, resultChars: 0 },
      "work_read/work_get_context": { calls: 1, resultChars: 6 },
      "work_write_overwrite/(unknown)": { calls: 1, resultChars: 0 },
      "work_write_idempotent/work_set_title": { calls: 1, resultChars: 2 },
    });
    for (const out of [JSON.stringify(report), formatTable(report), formatForAgent(report)]) {
      expect(out).not.toContain(OP_SECRET);
    }
  });
});

describe("Codex report output", () => {
  const lines = () => [
    codexMeta(0, PARENT),
    userEvent(1),
    call(2, "c1", `bad ${CANARY}`),
    { ...call(3, "c2", "shell"), extra: { [`key with ${CANARY}`]: CANARY, ok_key: [1, "a", { deep: CANARY }] } },
    output(4, "c2", CANARY),
    tokenCount(5, usageOf(10, 5, 1)),
    { timestamp: at(6), type: `weird ${CANARY}`, payload: { type: `other ${CANARY}`, data: CANARY } },
  ];

  it("never prints canary content in the table, JSON, agent text or shapes", async () => {
    const dir = codexDir({ [rolloutName(PARENT)]: lines() });
    const report = await summarizeFiles([dir]);
    const table = formatTable(report);
    const shapes = formatShapes(await summarizeShapes([dir]));
    for (const out of [
      table,
      JSON.stringify(report),
      formatForAgent(report),
      formatForAgent(report, { locale: "zh-TW" }),
      shapes,
    ]) {
      for (const forbidden of [CANARY, FAKE_PATH, PARENT, dir]) expect(out).not.toContain(forbidden);
    }
    expect(table).toContain("codex: experimental, not verified against real logs");
    expect(table).toContain("token mismatches=0");
    expect(report.formats.codexLines).toBe(7);
    expect(shapes).toContain("session_meta/-");
    expect(shapes).toContain("(other)/(other)");
    expect(shapes).toContain("event_msg/token_count");
    expect(shapes).toContain("payload.info.total_token_usage.input_tokens: number");
    expect(shapes).toContain("extra.(key): string");
    expect(shapes).toContain("extra.ok_key[]: number|object|string");
  });
});
