import { basename } from "node:path";
import { countPath, createEvidence, type SessionEvidence } from "./allocation.js";
import {
  bump,
  bumpOperation,
  creditBreakdown,
  emptyMetrics,
  modelEntry,
  localDate,
  isRecord,
  mergeMetrics,
  TOKEN_FIELDS,
  touchTimestamps,
  type MetricsAcc,
} from "./metrics.js";
import { safeModelId } from "./model.js";
import { inRange, parseTimestamp, recordUsageEvent, sessionFor, type ScanState } from "./state.js";
import type { UsageEvent } from "./types.js";
import { operationOf, projectRootOf, SAFE_TOOL_NAME, workOperationKey, type ToolInfo } from "./tools.js";

type Raw = Record<string, any>;
type Usage = Record<string, number>;
type Mapped = { input: number; output: number; cacheRead: number; cacheCreation: number; reasoningOutput: number };

export interface FirstCredit {
  mapped: Mapped;
  model: string;
  time: number | null;
  event: UsageEvent | null;
}

interface TurnCounter {
  count: number;
  ids: Set<string>;
}

export interface CodexContext {
  fileId: string | null;
  metaSeen: boolean;
  metaId: string | null;
  forkedFrom: string | null;
  subagent: boolean;
  metrics: MetricsAcc;
  touched: boolean;
  lines: number;
  prev: Usage | null;
  hasTokenCount: boolean;
  tokenCountSum: number;
  carryover: number;
  compactedFrom: string | null;
  model: string;
  firstCredited: FirstCredit | null;
  fallback: {
    count: number;
    ids: Set<string>;
    mapped: Mapped | null;
    entries: { mapped: Mapped; model: string; time: number | null }[];
  };
  stash: Map<string, number>;
  turnCounters: TurnCounter[];
  evidence: SessionEvidence | null;
  eventStart: number;
}

const CODEX_WORK_TOOL_NAME = /(?:^|__)(work_[a-z0-9_]+)$/;
const CODEX_FILE_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readCodexUsage(record: Raw): Usage {
  const usage: Usage = {};
  for (const field of CODEX_USAGE_FIELDS) usage[field] = finiteCount(record[field]);
  return usage;
}

function mapCodexUsage(delta: Usage): Mapped {
  const input = delta.input_tokens ?? 0;
  const cached = delta.cached_input_tokens ?? 0;
  return {
    input: Math.max(0, input - cached),
    output: delta.output_tokens ?? 0,
    cacheRead: cached,
    cacheCreation: delta.cache_write_input_tokens ?? 0,
    reasoningOutput: delta.reasoning_output_tokens ?? 0,
  };
}

function addMappedUsage(metrics: MetricsAcc, mapped: Mapped): void {
  for (const [field] of TOKEN_FIELDS) metrics.tokens[field] += mapped[field];
  metrics.tokens.reasoningOutput = (metrics.tokens.reasoningOutput ?? 0) + mapped.reasoningOutput;
}

function mappedSum(mapped: Mapped): number {
  return mapped.input + mapped.output + mapped.cacheRead + mapped.cacheCreation;
}

function sameUsage(a: Usage, b: Usage): boolean {
  return CODEX_USAGE_FIELDS.every((field) => a[field] === b[field]);
}

function isSubagentSource(source: unknown): boolean {
  if (typeof source === "string") return /subagent/i.test(source);
  if (!isRecord(source)) return false;
  return Object.entries(source).some(
    ([key, value]) => /subagent/i.test(key) || (typeof value === "string" && /subagent/i.test(value)),
  );
}

function createCodexContext(state: ScanState): CodexContext {
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
    model: "",
    firstCredited: null,
    fallback: { count: 0, ids: new Set(), mapped: null, entries: [] },
    stash: new Map(),
    turnCounters: [0, 1, 2, 3].map(() => ({ count: 0, ids: new Set<string>() })),
    evidence: state.file.group === null ? null : createEvidence(state.file.group),
    eventStart: state.events.length,
  };
}

function classifyCodexTool(fullName: unknown, namespaced: boolean, args: unknown): ToolInfo {
  if (typeof fullName !== "string" || !SAFE_TOOL_NAME.test(fullName))
    return { name: "(other)", work: false, mcp: false };
  const entry = CODEX_WORK_TOOL_NAME.exec(fullName)?.[1];
  if (entry !== undefined) {
    return { name: entry, work: true, mcp: true, key: workOperationKey(entry, () => operationOf(args)) };
  }
  return { name: fullName, work: false, mcp: fullName.startsWith("mcp__") || (namespaced && fullName.includes("__")) };
}

function codexCallId(payload: Raw): string | null {
  return typeof payload.call_id === "string" && payload.call_id !== "" ? payload.call_id : null;
}

function registerCodexTool(
  state: ScanState,
  ctx: CodexContext,
  callId: string | null,
  tool: ToolInfo,
  counted: boolean,
  args: unknown,
): void {
  if (tool.work && ctx.evidence) countPath(ctx.evidence.roots, projectRootOf(args));
  if (counted) {
    ctx.metrics.toolCalls += 1;
    bump(tool.work ? ctx.metrics.workIntelligenceTools : ctx.metrics.toolCallsByName, tool.name);
    if (tool.key !== undefined) bumpOperation(ctx.metrics, tool.key, "calls", 1);
  }
  if (callId !== null) state.toolNames.set(callId, { ...tool, counted, owner: ctx.metrics });
}

function handleCodexCall(state: ScanState, ctx: CodexContext, payload: Raw, ranged: boolean): void {
  const callId = codexCallId(payload);
  if (callId !== null && state.toolNames.has(callId)) return;
  const namespace = typeof payload.namespace === "string" && payload.namespace !== "" ? payload.namespace : null;
  const name = payload.type === "local_shell_call" ? "local_shell" : payload.name;
  const full = typeof name === "string" && namespace !== null ? namespace + name : name;
  registerCodexTool(
    state,
    ctx,
    callId,
    classifyCodexTool(full, namespace !== null, payload.arguments),
    ranged,
    payload.arguments,
  );
}

function handleMcpBegin(state: ScanState, ctx: CodexContext, payload: Raw, ranged: boolean): void {
  const callId = codexCallId(payload);
  const invocation: Raw = isRecord(payload.invocation) ? payload.invocation : {};
  const known = callId === null ? undefined : state.toolNames.get(callId);
  const workMatch = typeof invocation.tool === "string" ? CODEX_WORK_TOOL_NAME.exec(invocation.tool) : null;
  if (!known) {
    const full =
      typeof invocation.server === "string" && typeof invocation.tool === "string"
        ? `mcp__${invocation.server}__${invocation.tool}`
        : null;
    registerCodexTool(
      state,
      ctx,
      callId,
      { ...classifyCodexTool(full, true, invocation.arguments), mcp: true },
      ranged,
      invocation.arguments,
    );
    return;
  }
  known.mcp = true;
  const entry = workMatch?.[1];
  if (entry === undefined || known.work) return;
  const key = workOperationKey(entry, () => operationOf(invocation.arguments));
  if (ctx.evidence) countPath(ctx.evidence.roots, projectRootOf(invocation.arguments));
  if (known.counted && known.owner === ctx.metrics) {
    const map = ctx.metrics.toolCallsByName;
    map[known.name] = (map[known.name] ?? 0) - 1;
    if ((map[known.name] ?? 0) <= 0) delete map[known.name];
    bump(ctx.metrics.workIntelligenceTools, entry);
    bumpOperation(ctx.metrics, key, "calls", 1);
  }
  known.name = entry;
  known.work = true;
  known.key = key;
}

function textItemsLength(items: unknown[]): number {
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

function codexOutputLength(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (Array.isArray(output)) return textItemsLength(output);
  if (!isRecord(output)) return 0;
  for (const key of ["body", "content"]) {
    const value = output[key];
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return textItemsLength(value);
  }
  return 0;
}

function mcpResultLength(result: unknown): number {
  if (!isRecord(result)) return 0;
  if (typeof result.Err === "string") return result.Err.length;
  if (isRecord(result.Ok) && Array.isArray(result.Ok.content)) return textItemsLength(result.Ok.content);
  return 0;
}

function creditCodexResult(state: ScanState, ctx: CodexContext, callId: string | null, length: number): void {
  const tool = callId === null ? undefined : state.toolNames.get(callId);
  if (!tool) ctx.metrics.unknownToolResultChars += length;
  else if (tool.mcp) {
    ctx.metrics.mcpToolResultChars += length;
    if (tool.work) {
      ctx.metrics.workIntelligenceToolResultChars += length;
      if (tool.key !== undefined) bumpOperation(ctx.metrics, tool.key, "resultChars", length);
    }
  }
}

function isAdditionalContextOutput(line: Raw, payload: Raw): boolean {
  const passthrough = payload.internal_chat_message_metadata_passthrough;
  return [line.metadata, payload.metadata, passthrough, isRecord(passthrough) ? passthrough.metadata : null].some(
    (meta) => isRecord(meta) && meta.additional_context_tool_output === true,
  );
}

function handleCodexOutput(state: ScanState, ctx: CodexContext, payload: Raw, ranged: boolean, line: Raw): void {
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

function handleMcpEnd(state: ScanState, ctx: CodexContext, payload: Raw, ranged: boolean): void {
  const callId = codexCallId(payload);
  if (!ranged || callId === null || state.seenToolResults.has(callId) || ctx.stash.has(callId)) return;
  ctx.stash.set(callId, mcpResultLength(payload.result));
}

function handleTokenCount(
  state: ScanState,
  ctx: CodexContext,
  payload: Raw,
  ranged: boolean,
  time: number | null,
): void {
  const info = payload.info;
  if (!isRecord(info) || !isRecord(info.total_token_usage)) return;
  ctx.hasTokenCount = true;
  const total = readCodexUsage(info.total_token_usage);
  const first = ctx.prev === null;
  const prev = ctx.prev ?? readCodexUsage({});
  if (sameUsage(total, prev)) return;
  const last = isRecord(info.last_token_usage) ? readCodexUsage(info.last_token_usage) : null;
  const delta: Usage = {};
  if (CODEX_USAGE_FIELDS.every((field) => (total[field] ?? 0) >= (prev[field] ?? 0))) {
    for (const field of CODEX_USAGE_FIELDS) delta[field] = (total[field] ?? 0) - (prev[field] ?? 0);
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
  creditBreakdown(ctx.metrics, "codex", ctx.model, time, mapped, 1);
  const event = recordUsageEvent(state, "codex", time, mapped);
  ctx.tokenCountSum += mappedSum(mapped);
  if (first && ctx.compactedFrom !== null) {
    // A rollout continuing a compacted thread replays that thread's total: keep its first delta out of the source
    // comparison; the scan subtracts the previous thread's usage after all files are read.
    ctx.carryover += mappedSum(mapped);
    ctx.firstCredited = { mapped, model: ctx.model, time, event };
    return;
  }
  if (!last || sameUsage(delta, last)) return;
  // A rollout that starts after a resume carries earlier usage in its first cumulative total. That first difference
  // is history, not drift: remember it so the token_usage_record comparison can leave it out.
  if (first && CODEX_USAGE_FIELDS.every((field) => (delta[field] ?? 0) >= (last[field] ?? 0))) {
    ctx.carryover += mappedSum(mapped) - mappedSum(mapCodexUsage(last));
  } else state.codexTokenMismatches += 1;
}

function handleTokenUsageRecord(ctx: CodexContext, payload: Raw, ranged: boolean, time: number | null): void {
  if (!isRecord(payload.usage)) return;
  const id = typeof payload.response_id === "string" && payload.response_id !== "" ? payload.response_id : null;
  if (id !== null) {
    if (ctx.fallback.ids.has(id)) return;
    ctx.fallback.ids.add(id);
  }
  if (!ranged) return;
  const mapped = mapCodexUsage(readCodexUsage(payload.usage));
  ctx.fallback.count += 1;
  ctx.fallback.entries.push({ mapped, model: ctx.model, time });
  const sum = (ctx.fallback.mapped ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoningOutput: 0 });
  for (const key of Object.keys(mapped) as (keyof Mapped)[]) sum[key] += mapped[key];
}

function countTurn(ctx: CodexContext, index: number, turnId: unknown, ranged: boolean): void {
  if (!ranged) return;
  const counter = ctx.turnCounters[index];
  if (!counter) return;
  if (typeof turnId === "string" && turnId !== "") {
    if (counter.ids.has(turnId)) return;
    counter.ids.add(turnId);
  }
  counter.count += 1;
}

function isUserMessageItem(item: unknown): boolean {
  return (
    isRecord(item) && typeof item.type === "string" && item.type.replaceAll("_", "").toLowerCase() === "usermessage"
  );
}

/** Code mode (Codex 0.163+): an MCP call made inside `exec` leaves only an item_completed McpToolCall item. */
function isMcpToolCallItem(item: unknown): item is Raw {
  return (
    isRecord(item) && typeof item.type === "string" && item.type.replaceAll("_", "").toLowerCase() === "mcptoolcall"
  );
}

function mcpItemResultLength(result: unknown): number {
  if (isRecord(result) && Array.isArray(result.content)) return textItemsLength(result.content);
  return mcpResultLength(result);
}

function handleMcpItem(state: ScanState, ctx: CodexContext, item: Raw, ranged: boolean): void {
  const callId = typeof item.id === "string" && item.id !== "" ? item.id : null;
  handleMcpBegin(
    state,
    ctx,
    { call_id: callId, invocation: { server: item.server, tool: item.tool, arguments: item.arguments } },
    ranged,
  );
  if (!ranged || callId === null || state.seenToolResults.has(callId) || ctx.stash.has(callId)) return;
  ctx.stash.set(callId, mcpItemResultLength(item.result));
}

function isPlainUserPrompt(payload: Raw): boolean {
  if (payload.role !== "user" || !Array.isArray(payload.content)) return false;
  const first = payload.content.find((item) => isRecord(item) && typeof item.text === "string");
  return first !== undefined && !first.text.trim().startsWith("<");
}

function updateModel(ctx: CodexContext, payload: Raw): void {
  if (!("model" in payload)) return;
  ctx.model = safeModelId(payload.model);
}

function handleCompacted(ctx: CodexContext, payload: Raw): void {
  const record = payload.latest_token_usage_record;
  if (ctx.hasTokenCount || ctx.compactedFrom !== null || !isRecord(record)) return;
  const threadId = typeof record.thread_id === "string" && record.thread_id !== "" ? record.thread_id : null;
  if (threadId !== null && threadId !== ctx.metaId) ctx.compactedFrom = threadId;
}

function handleSessionMeta(state: ScanState, ctx: CodexContext, payload: Raw): void {
  if (ctx.metaSeen) return;
  ctx.metaSeen = true;
  if (typeof payload.id === "string" && payload.id !== "") ctx.metaId = payload.id;
  if (typeof payload.forked_from_id === "string" && payload.forked_from_id !== "") {
    ctx.forkedFrom = payload.forked_from_id;
    state.codexForkedSessions += 1;
  }
  ctx.subagent = isSubagentSource(payload.source);
}

function handleCodexEvent(
  state: ScanState,
  ctx: CodexContext,
  payload: Raw,
  ranged: boolean,
  time: number | null,
): boolean {
  switch (payload.type) {
    case "token_count":
      handleTokenCount(state, ctx, payload, ranged, time);
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

function handleCodexResponseItem(
  state: ScanState,
  ctx: CodexContext,
  payload: Raw,
  ranged: boolean,
  line: Raw,
): boolean {
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

export function isCodexLine(line: Raw): boolean {
  return typeof line.type === "string" && isRecord(line.payload) && !("message" in line);
}

export function handleCodexLine(state: ScanState, line: Raw): void {
  state.file.codex ??= createCodexContext(state);
  const ctx = state.file.codex;
  const payload: Raw = line.payload;
  const time = parseTimestamp(line.timestamp);
  const ranged = inRange(state, time);
  if (ranged) {
    touchTimestamps(ctx.metrics, time);
    ctx.touched = true;
    ctx.lines += 1;
  }
  let handled = false;
  if (line.type === "session_meta") {
    if (ctx.evidence) countPath(ctx.evidence.cwds, payload.cwd);
    updateModel(ctx, payload);
    handleSessionMeta(state, ctx, payload);
    handled = true;
  } else if (line.type === "turn_context") {
    if (ctx.evidence) countPath(ctx.evidence.cwds, payload.cwd);
    updateModel(ctx, payload);
    handled = true;
  } else if (line.type === "compacted") {
    handleCompacted(ctx, payload);
    handled = true;
  } else if (line.type === "token_usage_record" || payload.type === "token_usage_record") {
    handleTokenUsageRecord(ctx, payload, ranged, time);
    handled = true;
  } else if (line.type === "event_msg") handled = handleCodexEvent(state, ctx, payload, ranged, time);
  else if (line.type === "response_item") handled = handleCodexResponseItem(state, ctx, payload, ranged, line);
  if (!handled) state.codexIgnoredLines += 1;
}

export function endCodexFile(state: ScanState): void {
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
      for (const entry of fallback.entries) {
        creditBreakdown(ctx.metrics, "codex", entry.model, entry.time, entry.mapped, 1);
        recordUsageEvent(state, "codex", entry.time, entry.mapped);
      }
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
  const credited = state.codexThreadCredited.get(thread) ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    reasoningOutput: 0,
  };
  for (const field of Object.keys(credited)) {
    credited[field] = (credited[field] ?? 0) + ((ctx.metrics.tokens as unknown as Usage)[field] ?? 0);
  }
  state.codexThreadCredited.set(thread, credited);
  const key = ctx.fileId ? `codex:${ctx.fileId}` : ctx.metaId ? `codex:${ctx.metaId}` : `codex:${state.file.path}`;
  for (const event of state.events.slice(ctx.eventStart)) event.key = key;
  if (!ctx.touched) return;
  if (ctx.evidence) state.evidence.set(key, ctx.evidence);
  if (ctx.compactedFrom !== null && ctx.firstCredited !== null) {
    state.codexContinuations.push({ key, previous: ctx.compactedFrom, first: ctx.firstCredited });
  }
  mergeMetrics(sessionFor(state, key), ctx.metrics);
}

export function linkCodexCompactions(state: ScanState): void {
  for (const { key, previous, first } of state.codexContinuations) {
    const credited = state.codexThreadCredited.get(previous);
    if (!credited) {
      state.codexCompactionCarryovers += 1;
      continue;
    }
    const session = state.sessions.get(key);
    if (!session) continue;
    const tokens = session.tokens as unknown as Usage;
    const model = modelEntry(session, "codex", first.model);
    const day = first.time === null ? undefined : session.byDay[localDate(first.time)];
    for (const field of Object.keys(first.mapped) as (keyof Mapped)[]) {
      const amount = Math.min(Math.max(0, credited[field] ?? 0), first.mapped[field] ?? 0);
      tokens[field] = (tokens[field] ?? 0) - amount;
      if (field === "reasoningOutput") continue;
      model.tokens[field] -= amount;
      if (day) day[field] -= amount;
      if (first.event) first.event.tokens[field] -= amount;
    }
    model.responses = Math.max(0, model.responses - 1);
    session.assistantMessages = Math.max(0, session.assistantMessages - 1);
    state.codexCompactionLinked += 1;
  }
}
