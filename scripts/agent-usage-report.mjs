#!/usr/bin/env node
/**
 * Prints aggregate usage numbers from local Agent session logs. It never prints message text, tool inputs, file paths,
 * working directories, branch or project names, or error messages: only counts, token sums and timestamps.
 *
 * Usage: node scripts/agent-usage-report.mjs [--since <ISO>] [--until <ISO>] [--json] [--debug-shape] <file-or-directory>...
 *
 * Supported formats: Claude Code session logs (*.jsonl) and, EXPERIMENTALLY, Codex CLI rollouts
 * (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl). The Codex parser was written from reading the openai/codex
 * source, not from real logs: check it with `--debug-shape` (prints key names and JS types only, never values) and by
 * comparing one session with the numbers Codex shows in `/status`. Add a format by pushing another parser onto PARSERS;
 * a parser may define `endFile(state)`, called after each file, and reads per-file context from `state.file`.
 * Lines no parser recognizes (other Claude Code line types, non-objects aside) are ignored.
 *
 * Rules (Claude Code):
 * - A streamed assistant message repeats the same `message.id` over several lines, each carrying the usage. Usage is
 *   counted once per id, using the per-field maximum seen for that id (the last line holds the final output_tokens,
 *   and input/cache fields are identical across lines, so the maximum equals the final value).
 * - tool_use blocks are deduplicated by their `id`; tool_result sizes are deduplicated by `tool_use_id`.
 * - Lines with `isSidechain: true` (subagents) stay in the session aggregate of their `sessionId`; their tokens and
 *   tool calls count, but their prompts are not turns. `turns` counts main-thread human prompts only (no `isMeta`).
 * - Time ranges filter by each line's `timestamp`; with a range, lines without a valid timestamp are excluded.
 *
 * Rules (Codex, experimental): lines look like `{timestamp, type, payload}`.
 * - One file is one session, keyed by the UUID in the file name (else the first session_meta id, else the path); keys
 *   are only ever hashed. Only the first session_meta is used.
 * - Tokens are the delta of the cumulative `token_count.info.total_token_usage`. A repeated total is a duplicate and is
 *   skipped; a total with any lower field is a counter reset and counts `last_token_usage` (else the total). Tracking
 *   always advances, even outside the time range; only in-range deltas are credited. `assistantMessages` is the
 *   number of credited deltas. `token_usage_record` lines (deduplicated by response_id) are a fallback used only when a
 *   file has no token_count; both are never added. Canary counters (`codexTokenMismatches`,
 *   `codexTokenSourceDisagreements`) flag credited deltas that disagree with `last_token_usage` or the other source.
 *   The first total of a file that starts after compaction or a resume already holds earlier usage; that gap is
 *   counted (it is real usage of the thread) but is not a canary hit, and it is left out of the source comparison.
 * - Compaction chains: after compaction Codex may start a new thread in a new rollout whose leading `compacted` line
 *   names the previous thread (`latest_token_usage_record.thread_id`) and whose first total repeats that thread's
 *   total. When the previous thread's rollout is among the inputs, its credited usage is subtracted from the new
 *   rollout's first delta after all files are read (file order does not matter) and the replayed response is not an
 *   assistant message (`codexCompactionLinked`). When it is not among the inputs, the carried usage stays counted
 *   (`codexCompactionCarryovers`). The whole first delta of such a rollout is left out of the source comparison.
 * - function_call_output lines without a call_id that Codex marks `additional_context_tool_output: true` answer no
 *   tool call; they are skipped and counted in `codexContextOutputs`.
 * - Codex input is normalised to Anthropic semantics: input = input_tokens - cached_input_tokens (uncached only),
 *   cacheRead = cached_input_tokens, cacheCreation = cache_write_input_tokens (0 when absent). Whether input_tokens
 *   already includes cache writes is unverified. output_tokens already includes reasoning tokens; they are also exposed
 *   as `tokens.reasoningOutput` for Codex sessions only.
 * - Forked sessions (`forked_from_id`) replay their parent's history. Tool calls are deduplicated globally by call_id.
 *   A fork skips token deltas whose cumulative total was already seen under its parent id (`codexForkedSessions` counts
 *   forks). Fork-of-fork chains read in the wrong order (child before parent) can overcount.
 * - Tool calls come from response_item function_call / custom_tool_call / local_shell_call (name `local_shell`); the
 *   name is namespace + name when a namespace exists. A call is MCP when its name starts with `mcp__`, has a namespace
 *   and contains `__`, or has an `mcp_tool_call_begin` event. Work Intelligence tools match
 *   /(?:^|__)(work_[a-z0-9_]+)$/. Calls without a call_id are counted but cannot be deduplicated.
 * - Code mode (Codex 0.163+): MCP calls made inside `exec` have no function_call and no mcp_tool_call_begin/end; they
 *   leave only an `item_completed` event whose item type is McpToolCall ({id, server, tool, result.content[]}). It is
 *   registered like mcp_tool_call_begin with item.id as the call_id, and its result is used like mcp_tool_call_end.
 *   The `exec` call itself still counts once as an ordinary tool; its output is not MCP.
 * - Result sizes come from function_call_output / custom_tool_call_output (first per call_id wins); an
 *   `mcp_tool_call_end` result is used only when no output item exists for that call_id. Caveat: Codex may store MCP
 *   results as a JSON envelope string, which inflates characters slightly compared with Claude Code.
 * - Turns: the first non-zero of (1) user_message events, (2) item_completed UserMessage items, (3)
 *   task_started/turn_started events, (4) user response_item messages not starting with "<"; never summed, deduplicated
 *   by turn_id when present. Subagent files (session_meta source mentions "subagent") have 0 turns and count their
 *   in-range lines in `sidechainLines`.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import console from "node:console";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const WORK_TOOL_NAME = /^mcp__.*__(work_[a-z_]+)$/;
const CODEX_WORK_TOOL_NAME = /(?:^|__)(work_[a-z0-9_]+)$/;
const CODEX_FILE_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];
const SHAPE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const SHAPE_PATH_CAP = 200;
const SHAPE_MAX_DEPTH = 4;
const TOKEN_FIELDS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cache_read_input_tokens"],
  ["cacheCreation", "cache_creation_input_tokens"],
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyMetrics() {
  return {
    turns: 0,
    assistantMessages: 0,
    sidechainLines: 0,
    toolCalls: 0,
    toolCallsByName: {},
    workIntelligenceTools: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    mcpToolResultChars: 0,
    workIntelligenceToolResultChars: 0,
    unknownToolResultChars: 0,
    firstTimestamp: null,
    lastTimestamp: null,
  };
}

function bump(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function mergeMetrics(target, source) {
  for (const key of ["turns", "assistantMessages", "sidechainLines", "toolCalls"]) target[key] += source[key];
  for (const key of ["mcpToolResultChars", "workIntelligenceToolResultChars", "unknownToolResultChars"]) {
    target[key] += source[key];
  }
  for (const name of Object.keys(source.toolCallsByName))
    bump(target.toolCallsByName, name, source.toolCallsByName[name]);
  for (const name of Object.keys(source.workIntelligenceTools)) {
    bump(target.workIntelligenceTools, name, source.workIntelligenceTools[name]);
  }
  for (const [field] of TOKEN_FIELDS) target.tokens[field] += source.tokens[field];
  if (source.tokens.reasoningOutput !== undefined) {
    target.tokens.reasoningOutput = (target.tokens.reasoningOutput ?? 0) + source.tokens.reasoningOutput;
  }
  if (source.firstTimestamp && (!target.firstTimestamp || source.firstTimestamp < target.firstTimestamp)) {
    target.firstTimestamp = source.firstTimestamp;
  }
  if (source.lastTimestamp && (!target.lastTimestamp || source.lastTimestamp > target.lastTimestamp)) {
    target.lastTimestamp = source.lastTimestamp;
  }
}

/** Length of tool_result content: a string counts fully, an array counts its text blocks only. */
function toolResultLength(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") total += block.text.length;
  }
  return total;
}

/** Classifies a raw tool name into the map it is counted under, never echoing an unsafe name. */
function classifyTool(rawName) {
  if (typeof rawName !== "string" || !SAFE_TOOL_NAME.test(rawName)) return { name: "(other)", work: false, mcp: false };
  const work = WORK_TOOL_NAME.exec(rawName);
  if (work) return { name: work[1], work: true, mcp: true };
  return { name: rawName, work: false, mcp: rawName.startsWith("mcp__") };
}

function createState(options) {
  const since = options.since === undefined ? null : Date.parse(options.since);
  const until = options.until === undefined ? null : Date.parse(options.until);
  if ((since !== null && Number.isNaN(since)) || (until !== null && Number.isNaN(until))) {
    throw new Error("Invalid --since/--until value: expected an ISO 8601 date.");
  }
  return {
    since,
    until,
    sessions: new Map(),
    total: emptyMetrics(),
    skippedLines: 0,
    formats: { claudeCodeLines: 0, codexLines: 0 },
    codexTokenMismatches: 0,
    codexTokenSourceDisagreements: 0,
    codexForkedSessions: 0,
    codexIgnoredLines: 0,
    codexCompactionLinked: 0,
    codexCompactionCarryovers: 0,
    codexContextOutputs: 0,
    codexThreadCredited: new Map(),
    codexContinuations: [],
    messageUsage: new Map(),
    toolNames: new Map(),
    seenToolResults: new Set(),
    codexTokenTuples: new Set(),
    file: { path: "", codex: null },
  };
}

function sessionFor(state, sessionId) {
  const key = typeof sessionId === "string" && sessionId !== "" ? sessionId : "(unknown)";
  let session = state.sessions.get(key);
  if (!session) {
    session = { key, ...emptyMetrics() };
    state.sessions.set(key, session);
  }
  return session;
}

/** Returns false when the line falls outside the requested time range. */
function inRange(state, timestamp) {
  if (state.since === null && state.until === null) return true;
  const time = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (Number.isNaN(time)) return false;
  return (state.since === null || time >= state.since) && (state.until === null || time <= state.until);
}

function touchTimestamps(session, timestamp) {
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) return;
  const iso = new Date(timestamp).toISOString();
  if (!session.firstTimestamp || iso < session.firstTimestamp) session.firstTimestamp = iso;
  if (!session.lastTimestamp || iso > session.lastTimestamp) session.lastTimestamp = iso;
}

function handleAssistant(state, session, message) {
  const id = typeof message.id === "string" ? message.id : null;
  if (id !== null) {
    let seen = state.messageUsage.get(id);
    if (!seen) {
      seen = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      state.messageUsage.set(id, seen);
      session.assistantMessages += 1;
    }
    if (isRecord(message.usage)) {
      for (const [field, key] of TOKEN_FIELDS) {
        const value = message.usage[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value <= seen[field]) continue;
        session.tokens[field] += value - seen[field];
        seen[field] = value;
      }
    }
  }
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") continue;
    if (state.toolNames.has(block.id)) continue;
    const tool = classifyTool(block.name);
    state.toolNames.set(block.id, tool);
    session.toolCalls += 1;
    bump(tool.work ? session.workIntelligenceTools : session.toolCallsByName, tool.name);
  }
}

/** A turn is a main-thread human prompt: not a subagent prompt, not an injected meta line, not a tool_result. */
function isHumanTurn(line) {
  if (line.isSidechain === true || line.isMeta === true) return false;
  const content = line.message.content;
  if (typeof content === "string") return true;
  return (
    Array.isArray(content) &&
    content.some((block) => isRecord(block) && block.type === "text") &&
    !content.some((block) => isRecord(block) && block.type === "tool_result")
  );
}

function handleUser(state, session, line) {
  const message = line.message;
  if (isHumanTurn(line)) session.turns += 1;
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
    if (toolUseId !== null) {
      if (state.seenToolResults.has(toolUseId)) continue;
      state.seenToolResults.add(toolUseId);
    }
    const length = toolResultLength(block.content);
    const tool = toolUseId === null ? undefined : state.toolNames.get(toolUseId);
    if (!tool) session.unknownToolResultChars += length;
    else if (tool.mcp) {
      session.mcpToolResultChars += length;
      if (tool.work) session.workIntelligenceToolResultChars += length;
    }
  }
}

const claudeCodeParser = {
  name: "claude-code",
  formatKey: "claudeCodeLines",
  detect: (line) => (line.type === "assistant" || line.type === "user") && isRecord(line.message),
  handle(state, line) {
    if (!inRange(state, line.timestamp)) return;
    const session = sessionFor(state, line.sessionId);
    touchTimestamps(session, line.timestamp);
    if (line.isSidechain === true) session.sidechainLines += 1;
    if (line.type === "assistant") handleAssistant(state, session, line.message);
    else handleUser(state, session, line);
  },
};

function finiteCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readCodexUsage(record) {
  const usage = {};
  for (const field of CODEX_USAGE_FIELDS) usage[field] = finiteCount(record[field]);
  return usage;
}

/** Maps a raw Codex token delta to Anthropic semantics (input = uncached only). */
function mapCodexUsage(delta) {
  return {
    input: Math.max(0, delta.input_tokens - delta.cached_input_tokens),
    output: delta.output_tokens,
    cacheRead: delta.cached_input_tokens,
    cacheCreation: delta.cache_write_input_tokens,
    reasoningOutput: delta.reasoning_output_tokens,
  };
}

function addMappedUsage(metrics, mapped) {
  for (const [field] of TOKEN_FIELDS) metrics.tokens[field] += mapped[field];
  metrics.tokens.reasoningOutput += mapped.reasoningOutput;
}

function mappedSum(mapped) {
  return mapped.input + mapped.output + mapped.cacheRead + mapped.cacheCreation;
}

function sameUsage(a, b) {
  return CODEX_USAGE_FIELDS.every((field) => a[field] === b[field]);
}

function isSubagentSource(source) {
  if (typeof source === "string") return /subagent/i.test(source);
  if (!isRecord(source)) return false;
  return Object.entries(source).some(
    ([key, value]) => /subagent/i.test(key) || (typeof value === "string" && /subagent/i.test(value)),
  );
}

function createCodexContext(state) {
  const fileId = CODEX_FILE_ID.exec(basename(state.file.path))?.[1] ?? null;
  const metrics = emptyMetrics();
  metrics.tokens.reasoningOutput = 0;
  return {
    fileId,
    metaSeen: false,
    metaId: null,
    forkedFrom: null,
    subagent: false,
    metrics,
    touched: false,
    lines: 0,
    prev: null,
    hasTokenCount: false,
    tokenCountSum: 0,
    carryover: 0,
    compactedFrom: null,
    firstCredited: null,
    fallback: { count: 0, ids: new Set(), mapped: null },
    stash: new Map(),
    turnCounters: [0, 1, 2, 3].map(() => ({ count: 0, ids: new Set() })),
  };
}

/** Classifies a Codex tool name; `namespaced` marks a name that arrived with a namespace. */
function classifyCodexTool(fullName, namespaced) {
  if (typeof fullName !== "string" || !SAFE_TOOL_NAME.test(fullName))
    return { name: "(other)", work: false, mcp: false };
  const work = CODEX_WORK_TOOL_NAME.exec(fullName);
  if (work) return { name: work[1], work: true, mcp: true };
  return { name: fullName, work: false, mcp: fullName.startsWith("mcp__") || (namespaced && fullName.includes("__")) };
}

function codexCallId(payload) {
  return typeof payload.call_id === "string" && payload.call_id !== "" ? payload.call_id : null;
}

function registerCodexTool(state, ctx, callId, tool, counted) {
  if (counted) {
    ctx.metrics.toolCalls += 1;
    bump(tool.work ? ctx.metrics.workIntelligenceTools : ctx.metrics.toolCallsByName, tool.name);
  }
  if (callId !== null) state.toolNames.set(callId, { ...tool, counted, owner: ctx.metrics });
}

function handleCodexCall(state, ctx, payload, ranged) {
  const callId = codexCallId(payload);
  if (callId !== null && state.toolNames.has(callId)) return;
  const namespace = typeof payload.namespace === "string" && payload.namespace !== "" ? payload.namespace : null;
  const name = payload.type === "local_shell_call" ? "local_shell" : payload.name;
  const full = typeof name === "string" && namespace !== null ? namespace + name : name;
  registerCodexTool(state, ctx, callId, classifyCodexTool(full, namespace !== null), ranged);
}

function handleMcpBegin(state, ctx, payload, ranged) {
  const callId = codexCallId(payload);
  const invocation = isRecord(payload.invocation) ? payload.invocation : {};
  const known = callId === null ? undefined : state.toolNames.get(callId);
  const workMatch = typeof invocation.tool === "string" ? CODEX_WORK_TOOL_NAME.exec(invocation.tool) : null;
  if (!known) {
    const full =
      typeof invocation.server === "string" && typeof invocation.tool === "string"
        ? `mcp__${invocation.server}__${invocation.tool}`
        : null;
    registerCodexTool(state, ctx, callId, { ...classifyCodexTool(full, true), mcp: true }, ranged);
    return;
  }
  known.mcp = true;
  if (!workMatch || known.work) return;
  if (known.counted && known.owner === ctx.metrics) {
    const map = ctx.metrics.toolCallsByName;
    map[known.name] -= 1;
    if (map[known.name] <= 0) delete map[known.name];
    bump(ctx.metrics.workIntelligenceTools, workMatch[1]);
  }
  known.name = workMatch[1];
  known.work = true;
}

function textItemsLength(items) {
  let total = 0;
  for (const item of items) {
    if (
      isRecord(item) &&
      (item.type === "text" || item.type === "input_text" || item.type === "output_text") &&
      typeof item.text === "string"
    ) {
      total += item.text.length;
    }
  }
  return total;
}

function codexOutputLength(output) {
  if (typeof output === "string") return output.length;
  if (Array.isArray(output)) return textItemsLength(output);
  if (!isRecord(output)) return 0;
  for (const key of ["body", "content"]) {
    if (typeof output[key] === "string") return output[key].length;
    if (Array.isArray(output[key])) return textItemsLength(output[key]);
  }
  return 0;
}

function mcpResultLength(result) {
  if (!isRecord(result)) return 0;
  if (typeof result.Err === "string") return result.Err.length;
  if (isRecord(result.Ok) && Array.isArray(result.Ok.content)) return textItemsLength(result.Ok.content);
  return 0;
}

function creditCodexResult(state, ctx, callId, length) {
  const tool = callId === null ? undefined : state.toolNames.get(callId);
  if (!tool) ctx.metrics.unknownToolResultChars += length;
  else if (tool.mcp) {
    ctx.metrics.mcpToolResultChars += length;
    if (tool.work) ctx.metrics.workIntelligenceToolResultChars += length;
  }
}

/** Context outputs Codex adds by itself (no call_id, `additional_context_tool_output: true`) answer no tool call. */
function isAdditionalContextOutput(line, payload) {
  const passthrough = payload.internal_chat_message_metadata_passthrough;
  return [line.metadata, payload.metadata, passthrough, isRecord(passthrough) ? passthrough.metadata : null].some(
    (meta) => isRecord(meta) && meta.additional_context_tool_output === true,
  );
}

function handleCodexOutput(state, ctx, payload, ranged, line) {
  const callId = codexCallId(payload);
  if (callId === null && isAdditionalContextOutput(line, payload)) {
    if (ranged) state.codexContextOutputs += 1;
    return;
  }
  if (callId !== null) {
    ctx.stash.delete(callId);
    if (state.seenToolResults.has(callId)) return;
    state.seenToolResults.add(callId);
  }
  if (ranged) creditCodexResult(state, ctx, callId, codexOutputLength(payload.output));
}

function handleMcpEnd(state, ctx, payload, ranged) {
  const callId = codexCallId(payload);
  if (!ranged || callId === null || state.seenToolResults.has(callId) || ctx.stash.has(callId)) return;
  ctx.stash.set(callId, mcpResultLength(payload.result));
}

function handleTokenCount(state, ctx, payload, ranged) {
  const info = payload.info;
  if (!isRecord(info) || !isRecord(info.total_token_usage)) return;
  ctx.hasTokenCount = true;
  const total = readCodexUsage(info.total_token_usage);
  const first = ctx.prev === null;
  const prev = ctx.prev ?? readCodexUsage({});
  if (sameUsage(total, prev)) return;
  const last = isRecord(info.last_token_usage) ? readCodexUsage(info.last_token_usage) : null;
  const delta = {};
  if (CODEX_USAGE_FIELDS.every((field) => total[field] >= prev[field])) {
    for (const field of CODEX_USAGE_FIELDS) delta[field] = total[field] - prev[field];
  } else {
    Object.assign(delta, last ?? total);
  }
  ctx.prev = total;
  const tuple = CODEX_USAGE_FIELDS.map((field) => total[field]).join(",");
  const thread = ctx.metaId ?? ctx.fileId ?? state.file.path;
  const copiedFromParent = ctx.forkedFrom !== null && state.codexTokenTuples.has(`${ctx.forkedFrom}|${tuple}`);
  state.codexTokenTuples.add(`${thread}|${tuple}`);
  if (!ranged || copiedFromParent) return;
  const mapped = mapCodexUsage(delta);
  addMappedUsage(ctx.metrics, mapped);
  ctx.metrics.assistantMessages += 1;
  ctx.tokenCountSum += mappedSum(mapped);
  if (first && ctx.compactedFrom !== null) {
    // A rollout continuing a compacted thread replays that thread's total (and its last response, which has no
    // token_usage_record here). Keep the whole first delta out of the source comparison; summarizeFiles subtracts
    // the previous thread's usage once all files are read, so the order of files does not matter.
    ctx.carryover += mappedSum(mapped);
    ctx.firstCredited = mapped;
    return;
  }
  if (!last || sameUsage(delta, last)) return;
  // A rollout that starts after a resume carries earlier usage in its first cumulative total. That first difference
  // is history, not drift: remember it so the token_usage_record comparison can leave it out.
  if (first && CODEX_USAGE_FIELDS.every((field) => delta[field] >= last[field])) {
    ctx.carryover += mappedSum(mapped) - mappedSum(mapCodexUsage(last));
  } else state.codexTokenMismatches += 1;
}

function handleTokenUsageRecord(ctx, payload, ranged) {
  if (!isRecord(payload.usage)) return;
  const id = typeof payload.response_id === "string" && payload.response_id !== "" ? payload.response_id : null;
  if (id !== null) {
    if (ctx.fallback.ids.has(id)) return;
    ctx.fallback.ids.add(id);
  }
  if (!ranged) return;
  const mapped = mapCodexUsage(readCodexUsage(payload.usage));
  ctx.fallback.count += 1;
  ctx.fallback.mapped ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoningOutput: 0 };
  for (const key of Object.keys(mapped)) ctx.fallback.mapped[key] += mapped[key];
}

function countTurn(ctx, index, turnId, ranged) {
  if (!ranged) return;
  const counter = ctx.turnCounters[index];
  if (typeof turnId === "string" && turnId !== "") {
    if (counter.ids.has(turnId)) return;
    counter.ids.add(turnId);
  }
  counter.count += 1;
}

function isUserMessageItem(item) {
  return (
    isRecord(item) && typeof item.type === "string" && item.type.replaceAll("_", "").toLowerCase() === "usermessage"
  );
}

/** Code mode (Codex 0.163+): an MCP call made inside `exec` leaves only an item_completed McpToolCall item. */
function isMcpToolCallItem(item) {
  return (
    isRecord(item) && typeof item.type === "string" && item.type.replaceAll("_", "").toLowerCase() === "mcptoolcall"
  );
}

function mcpItemResultLength(result) {
  if (isRecord(result) && Array.isArray(result.content)) return textItemsLength(result.content);
  return mcpResultLength(result);
}

/** Registers the call like mcp_tool_call_begin (deduped by item.id) and stashes its result like mcp_tool_call_end. */
function handleMcpItem(state, ctx, item, ranged) {
  const callId = typeof item.id === "string" && item.id !== "" ? item.id : null;
  handleMcpBegin(state, ctx, { call_id: callId, invocation: { server: item.server, tool: item.tool } }, ranged);
  if (!ranged || callId === null || state.seenToolResults.has(callId) || ctx.stash.has(callId)) return;
  ctx.stash.set(callId, mcpItemResultLength(item.result));
}

function isPlainUserPrompt(payload) {
  if (payload.role !== "user" || !Array.isArray(payload.content)) return false;
  const first = payload.content.find((item) => isRecord(item) && typeof item.text === "string");
  return first !== undefined && !first.text.trim().startsWith("<");
}

/** A compacted line before any token_count that names another thread marks this rollout as that thread's sequel. */
function handleCompacted(ctx, payload) {
  const record = payload.latest_token_usage_record;
  if (ctx.hasTokenCount || ctx.compactedFrom !== null || !isRecord(record)) return;
  const threadId = typeof record.thread_id === "string" && record.thread_id !== "" ? record.thread_id : null;
  if (threadId !== null && threadId !== ctx.metaId) ctx.compactedFrom = threadId;
}

function handleSessionMeta(state, ctx, payload) {
  if (ctx.metaSeen) return;
  ctx.metaSeen = true;
  if (typeof payload.id === "string" && payload.id !== "") ctx.metaId = payload.id;
  if (typeof payload.forked_from_id === "string" && payload.forked_from_id !== "") {
    ctx.forkedFrom = payload.forked_from_id;
    state.codexForkedSessions += 1;
  }
  ctx.subagent = isSubagentSource(payload.source);
}

function handleCodexEvent(state, ctx, payload, ranged) {
  switch (payload.type) {
    case "token_count":
      handleTokenCount(state, ctx, payload, ranged);
      return true;
    case "mcp_tool_call_begin":
      handleMcpBegin(state, ctx, payload, ranged);
      return true;
    case "mcp_tool_call_end":
      handleMcpEnd(state, ctx, payload, ranged);
      return true;
    case "user_message":
      countTurn(ctx, 0, payload.turn_id, ranged);
      return true;
    case "item_completed":
      if (isUserMessageItem(payload.item)) countTurn(ctx, 1, payload.turn_id, ranged);
      else if (isMcpToolCallItem(payload.item)) handleMcpItem(state, ctx, payload.item, ranged);
      return true;
    case "task_started":
    case "turn_started":
      countTurn(ctx, 2, payload.turn_id, ranged);
      return true;
    default:
      return false;
  }
}

function handleCodexResponseItem(state, ctx, payload, ranged, line) {
  switch (payload.type) {
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
      handleCodexCall(state, ctx, payload, ranged);
      return true;
    case "function_call_output":
    case "custom_tool_call_output":
      handleCodexOutput(state, ctx, payload, ranged, line);
      return true;
    case "message":
      if (isPlainUserPrompt(payload)) countTurn(ctx, 3, payload.id, ranged);
      return payload.role === "user";
    default:
      return false;
  }
}

/** Codex CLI rollout lines (experimental): tracking state always advances; metrics are credited only in range. */
const codexParser = {
  name: "codex",
  formatKey: "codexLines",
  detect: (line) => typeof line.type === "string" && isRecord(line.payload) && !("message" in line),
  handle(state, line) {
    state.file.codex ??= createCodexContext(state);
    const ctx = state.file.codex;
    const payload = line.payload;
    const ranged = inRange(state, line.timestamp);
    if (ranged) {
      touchTimestamps(ctx.metrics, line.timestamp);
      ctx.touched = true;
      ctx.lines += 1;
    }
    let handled = false;
    if (line.type === "session_meta") {
      handleSessionMeta(state, ctx, payload);
      handled = true;
    } else if (line.type === "compacted") {
      handleCompacted(ctx, payload);
      handled = true;
    } else if (line.type === "token_usage_record" || payload.type === "token_usage_record") {
      handleTokenUsageRecord(ctx, payload, ranged);
      handled = true;
    } else if (line.type === "event_msg") handled = handleCodexEvent(state, ctx, payload, ranged);
    else if (line.type === "response_item") handled = handleCodexResponseItem(state, ctx, payload, ranged, line);
    if (!handled) state.codexIgnoredLines += 1;
  },
  endFile(state) {
    const ctx = state.file.codex;
    if (!ctx) return;
    state.file.codex = null;
    for (const [callId, length] of ctx.stash) {
      if (state.seenToolResults.has(callId)) continue;
      state.seenToolResults.add(callId);
      creditCodexResult(state, ctx, callId, length);
    }
    const fallback = ctx.fallback;
    if (fallback.mapped) {
      if (!ctx.hasTokenCount) {
        addMappedUsage(ctx.metrics, fallback.mapped);
        ctx.metrics.assistantMessages += fallback.count;
      } else if (mappedSum(fallback.mapped) !== ctx.tokenCountSum - ctx.carryover) {
        state.codexTokenSourceDisagreements += 1;
      }
    }
    if (ctx.subagent) {
      ctx.metrics.sidechainLines = ctx.lines;
    } else {
      ctx.metrics.turns = ctx.turnCounters.find((counter) => counter.count > 0)?.count ?? 0;
    }
    const thread = ctx.metaId ?? ctx.fileId ?? state.file.path;
    const credited = state.codexThreadCredited.get(thread) ?? { ...emptyMetrics().tokens, reasoningOutput: 0 };
    for (const field of Object.keys(credited)) credited[field] += ctx.metrics.tokens[field] ?? 0;
    state.codexThreadCredited.set(thread, credited);
    if (!ctx.touched) return;
    const key = ctx.fileId ? `codex:${ctx.fileId}` : ctx.metaId ? `codex:${ctx.metaId}` : `codex:${state.file.path}`;
    if (ctx.compactedFrom !== null && ctx.firstCredited !== null) {
      state.codexContinuations.push({ key, previous: ctx.compactedFrom, first: ctx.firstCredited });
    }
    mergeMetrics(sessionFor(state, key), ctx.metrics);
  },
};

const PARSERS = [claudeCodeParser, codexParser];

function consumeLine(state, text) {
  if (text.trim() === "") return;
  let line;
  try {
    line = JSON.parse(text);
  } catch {
    state.skippedLines += 1;
    return;
  }
  if (!isRecord(line)) {
    state.skippedLines += 1;
    return;
  }
  // Lines of other types (attachment, summary, ...) match no parser and are ignored.
  const parser = PARSERS.find((candidate) => candidate.detect(line));
  if (!parser) return;
  state.formats[parser.formatKey] += 1;
  parser.handle(state, line);
}

async function expandPaths(paths) {
  const files = [];
  async function visit(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of entries) await visit(join(path, entry.name));
    } else if (path.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  for (const path of paths) {
    const info = await stat(path);
    if (info.isFile()) files.push(path);
    else await visit(path);
  }
  return files;
}

/** Streams every line of every file; `onLine(text)` runs per line, `onFileEnd()` after each file. */
async function forEachLine(paths, onFile, onLine, onFileEnd) {
  for (const file of await expandPaths(paths)) {
    onFile(file);
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const text of lines) onLine(text);
    onFileEnd();
  }
}

/**
 * A rollout that continues a compacted thread starts from that thread's cumulative total. When the previous thread's
 * rollout was read too, its credited usage is already counted: subtract it (never more than the first delta) and drop
 * the replayed response. Otherwise the carried usage stays and `codexCompactionCarryovers` says so.
 */
function linkCodexCompactions(state) {
  for (const { key, previous, first } of state.codexContinuations) {
    const credited = state.codexThreadCredited.get(previous);
    if (!credited) {
      state.codexCompactionCarryovers += 1;
      continue;
    }
    const session = state.sessions.get(key);
    for (const field of Object.keys(first)) {
      session.tokens[field] -= Math.min(Math.max(0, credited[field] ?? 0), first[field]);
    }
    session.assistantMessages = Math.max(0, session.assistantMessages - 1);
    state.codexCompactionLinked += 1;
  }
}

/**
 * Summarizes jsonl session logs. `options`: `{ since?: string, until?: string }` (ISO 8601).
 * Returns `{ formats: {claudeCodeLines, codexLines}, sessions, total, skippedLines, codexTokenMismatches,
 * codexTokenSourceDisagreements, codexForkedSessions, codexIgnoredLines }`; sessions carry only a label and a short hash.
 */
export async function summarizeFiles(paths, options = {}) {
  const state = createState(options);
  await forEachLine(
    paths,
    (path) => {
      state.file = { path, codex: null };
    },
    (text) => consumeLine(state, text),
    () => {
      for (const parser of PARSERS) parser.endFile?.(state);
    },
  );
  linkCodexCompactions(state);
  const ordered = [...state.sessions.values()].sort((a, b) =>
    (a.firstTimestamp ?? "") < (b.firstTimestamp ?? "")
      ? -1
      : (a.firstTimestamp ?? "") > (b.firstTimestamp ?? "")
        ? 1
        : 0,
  );
  const sessions = ordered.map((session, index) => {
    const { key, ...metrics } = session;
    mergeMetrics(state.total, metrics);
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
    return { label: `session-${index + 1}`, hash, ...metrics };
  });
  return {
    formats: state.formats,
    sessions,
    total: { sessions: sessions.length, ...state.total },
    skippedLines: state.skippedLines,
    codexTokenMismatches: state.codexTokenMismatches,
    codexTokenSourceDisagreements: state.codexTokenSourceDisagreements,
    codexForkedSessions: state.codexForkedSessions,
    codexIgnoredLines: state.codexIgnoredLines,
    codexCompactionLinked: state.codexCompactionLinked,
    codexCompactionCarryovers: state.codexCompactionCarryovers,
    codexContextOutputs: state.codexContextOutputs,
  };
}

function shapeKind(value) {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function walkShape(paths, value, path, depth, hops) {
  if (path !== "") {
    let kinds = paths.get(path);
    if (!kinds && paths.size < SHAPE_PATH_CAP) {
      kinds = new Set();
      paths.set(path, kinds);
    }
    kinds?.add(shapeKind(value));
  }
  if (hops > 16) return;
  if (Array.isArray(value)) {
    for (const item of value) walkShape(paths, item, `${path}[]`, depth, hops + 1);
  } else if (isRecord(value) && depth < SHAPE_MAX_DEPTH) {
    for (const key of Object.keys(value)) {
      const safe = SHAPE_KEY.test(key) ? key : "(key)";
      walkShape(paths, value[key], path === "" ? safe : `${path}.${safe}`, depth + 1, hops + 1);
    }
  }
}

function shapeDiscriminator(value) {
  if (value === undefined) return "-";
  return typeof value === "string" && SAFE_TOOL_NAME.test(value) ? value : "(other)";
}

/**
 * Describes the structure of log lines for format debugging: per `type`/`payload.type` pair a count and the key
 * paths (depth 4) with their JS types. Values and JSON embedded in strings are never read or printed.
 */
export async function summarizeShapes(paths) {
  const shapes = new Map();
  let skippedLines = 0;
  await forEachLine(
    paths,
    () => {},
    (text) => {
      if (text.trim() === "") return;
      let line;
      try {
        line = JSON.parse(text);
      } catch {
        skippedLines += 1;
        return;
      }
      if (!isRecord(line)) {
        skippedLines += 1;
        return;
      }
      const key = `${shapeDiscriminator(line.type)}/${isRecord(line.payload) ? shapeDiscriminator(line.payload.type) : "-"}`;
      let entry = shapes.get(key);
      if (!entry) {
        entry = { count: 0, paths: new Map() };
        shapes.set(key, entry);
      }
      entry.count += 1;
      walkShape(entry.paths, line, "", 0, 0);
    },
    () => {},
  );
  return {
    skippedLines,
    shapes: [...shapes.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, entry]) => ({
        key,
        count: entry.count,
        paths: [...entry.paths.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([path, kinds]) => ({ path, types: [...kinds].sort() })),
      })),
  };
}

function formatShapes(result) {
  const out = ["shape: key paths and JS types only, never values"];
  for (const shape of result.shapes) {
    out.push("", `${shape.key}  lines=${shape.count}`);
    for (const { path, types } of shape.paths) out.push(`  ${path}: ${types.join("|")}`);
  }
  out.push("", `skipped lines: ${result.skippedLines}`);
  return out.join("\n");
}

function formatTable(report) {
  const rows = [
    ["session", "turns", "msgs", "tools", "wi-tools", "in", "out", "cache-r", "cache-w", "mcp-chars", "first", "last"],
    ...[...report.sessions, { ...report.total, label: "total", hash: "" }].map((s) => [
      s.hash ? `${s.label}/${s.hash}` : s.label,
      s.turns,
      s.assistantMessages,
      s.toolCalls,
      Object.values(s.workIntelligenceTools).reduce((sum, n) => sum + n, 0),
      s.tokens.input,
      s.tokens.output,
      s.tokens.cacheRead,
      s.tokens.cacheCreation,
      s.mcpToolResultChars,
      s.firstTimestamp ?? "-",
      s.lastTimestamp ?? "-",
    ]),
  ].map((row) => row.map(String));
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const table = rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join("  ")
      .trimEnd(),
  );
  const names = (title, map) => {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    return entries.length === 0 ? [] : [`${title}: ${entries.map(([name, n]) => `${name}=${n}`).join(", ")}`];
  };
  return [
    ...table,
    "",
    ...names("tools", report.total.toolCallsByName),
    ...names("work intelligence tools", report.total.workIntelligenceTools),
    `work intelligence result chars: ${report.total.workIntelligenceToolResultChars}; unknown result chars: ${report.total.unknownToolResultChars}`,
    `skipped lines: ${report.skippedLines}; lines by format: claude-code=${report.formats.claudeCodeLines}, codex=${report.formats.codexLines}`,
    ...(report.formats.codexLines > 0
      ? [
          "codex: experimental, not verified against real logs",
          `codex canaries: token mismatches=${report.codexTokenMismatches}, token source disagreements=${report.codexTokenSourceDisagreements}, forked sessions=${report.codexForkedSessions}, ignored lines=${report.codexIgnoredLines}, compactions linked=${report.codexCompactionLinked}, compaction carryovers=${report.codexCompactionCarryovers}, context outputs=${report.codexContextOutputs}`,
        ]
      : []),
  ].join("\n");
}

const HELP = `Usage: node scripts/agent-usage-report.mjs [options] <file-or-directory>...

Prints aggregate usage (turns, tool calls, tokens, MCP result sizes) from local Claude Code session logs and,
experimentally, Codex CLI rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). The Codex parser is not verified
against real logs: run with --debug-shape to see the key names and types of your logs (never values), and compare one
session with the numbers Codex shows in /status before trusting the totals.
Directories are searched recursively for *.jsonl. Message text, tool inputs, paths and project names are never printed.

Options:
  --since <ISO>   only lines at or after this timestamp
  --until <ISO>   only lines at or before this timestamp
  --json          machine-readable output
  --debug-shape   print per line type the key paths and JS types (no values) instead of a report
  --help          show this help`;

function parseArgs(argv) {
  const options = { paths: [], json: false, help: false, debugShape: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--debug-shape") options.debugShape = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--since" || arg === "--until") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else options.paths.push(arg);
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || options.paths.length === 0) {
    console.log(HELP);
    return options.help ? 0 : 1;
  }
  if (options.debugShape) {
    console.log(formatShapes(await summarizeShapes(options.paths)));
    return 0;
  }
  const report = await summarizeFiles(options.paths, { since: options.since, until: options.until });
  console.log(options.json ? JSON.stringify(report, null, 2) : formatTable(report));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      // Only the error code/kind is printed: messages may embed file paths.
      console.error(`agent-usage-report failed${error?.code ? ` (${error.code})` : ""}.`);
      process.exitCode = 1;
    },
  );
}
