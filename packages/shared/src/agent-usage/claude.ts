import { bump, bumpOperation, isRecord, TOKEN_FIELDS, touchTimestamps } from "./metrics.js";
import { inRange, parseTimestamp, sessionFor, type ScanState } from "./state.js";
import { classifyTool } from "./tools.js";
import type { ClaudeRecord, ClaudeToolResultRecord, ClaudeToolUseRecord } from "./types.js";

/** Length of tool_result content: a string counts fully, an array counts its text blocks only. */
function toolResultLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") total += block.text.length;
  }
  return total;
}

/** A turn is a main-thread human prompt: not a subagent prompt, not an injected meta line, not a tool_result. */
function isHumanTurn(line: Record<string, any>): boolean {
  if (line.isSidechain === true || line.isMeta === true) return false;
  const content = line.message.content;
  if (typeof content === "string") return true;
  return (
    Array.isArray(content) &&
    content.some((block) => isRecord(block) && block.type === "text") &&
    !content.some((block) => isRecord(block) && block.type === "tool_result")
  );
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** True for a line the Claude Code parser owns. */
export function isClaudeLine(line: Record<string, any>): boolean {
  return (line.type === "assistant" || line.type === "user") && isRecord(line.message);
}

/**
 * Phase one: turns one Claude Code line into a compact record. No deduplication and no range filter happen here, so
 * the record stays valid for any later range. Only counts, ids, timestamps and safe tool names are kept; `intern`
 * shares session id strings across the lines of a file.
 */
export function extractClaudeLine(line: Record<string, any>, intern: (value: string) => string): ClaudeRecord {
  const message = line.message;
  const record: ClaudeRecord = {
    s: intern(typeof line.sessionId === "string" && line.sessionId !== "" ? line.sessionId : "(unknown)"),
    t: parseTimestamp(line.timestamp),
  };
  if (line.isSidechain === true) record.sc = 1;
  if (line.type === "assistant") {
    if (typeof message.id === "string") {
      record.m = message.id;
      if (isRecord(message.usage)) {
        const usage = TOKEN_FIELDS.map(([, key]) => positiveNumber(message.usage[key])) as [
          number,
          number,
          number,
          number,
        ];
        if (usage.some((value) => value > 0)) record.u = usage;
      }
    }
    if (Array.isArray(message.content)) {
      const uses: ClaudeToolUseRecord[] = [];
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") continue;
        const tool = classifyTool(block.name, block.input);
        const use: ClaudeToolUseRecord = { id: block.id, n: tool.name };
        if (tool.work) use.k = tool.key;
        uses.push(use);
      }
      if (uses.length > 0) record.tu = uses;
    }
    return record;
  }
  if (isHumanTurn(line)) record.h = 1;
  if (Array.isArray(message.content)) {
    const results: ClaudeToolResultRecord[] = [];
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      results.push({
        id: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
        length: toolResultLength(block.content),
      });
    }
    if (results.length > 0) record.tr = results;
  }
  return record;
}

/**
 * Phase two: applies the global deduplication (message id per-field maximum, tool_use id, tool_result id), the range
 * filter and the session grouping to records in file order. Calling it per file in path order gives the same result as
 * parsing every file line by line.
 */
export function reduceClaudeRecords(state: ScanState, records: readonly ClaudeRecord[]): void {
  for (const record of records) {
    if (!inRange(state, record.t)) continue;
    const session = sessionFor(state, record.s);
    touchTimestamps(session, record.t);
    if (record.sc === 1) session.sidechainLines += 1;
    if (record.m !== undefined) {
      let seen = state.messageUsage.get(record.m);
      if (!seen) {
        seen = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        state.messageUsage.set(record.m, seen);
        session.assistantMessages += 1;
      }
      if (record.u) {
        for (const [index, [field]] of TOKEN_FIELDS.entries()) {
          const value = record.u[index] ?? 0;
          if (value <= seen[field]) continue;
          session.tokens[field] += value - seen[field];
          seen[field] = value;
        }
      }
    }
    for (const use of record.tu ?? []) {
      if (state.toolNames.has(use.id)) continue;
      const work = use.k !== undefined;
      state.toolNames.set(use.id, {
        name: use.n,
        work,
        mcp: work || use.n.startsWith("mcp__"),
        key: use.k,
      });
      session.toolCalls += 1;
      bump(work ? session.workIntelligenceTools : session.toolCallsByName, use.n);
      if (use.k !== undefined) bumpOperation(session, use.k, "calls", 1);
    }
    if (record.h === 1) session.turns += 1;
    for (const result of record.tr ?? []) {
      if (result.id !== null) {
        if (state.seenToolResults.has(result.id)) continue;
        state.seenToolResults.add(result.id);
      }
      const tool = result.id === null ? undefined : state.toolNames.get(result.id);
      if (!tool) session.unknownToolResultChars += result.length;
      else if (tool.mcp) {
        session.mcpToolResultChars += result.length;
        if (tool.work) {
          session.workIntelligenceToolResultChars += result.length;
          if (tool.key !== undefined) bumpOperation(session, tool.key, "resultChars", result.length);
        }
      }
    }
  }
}
