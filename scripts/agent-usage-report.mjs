#!/usr/bin/env node
/**
 * Prints aggregate usage numbers from local Agent session logs. It never prints message text, tool inputs, file paths,
 * working directories, branch or project names, or error messages: only counts, token sums and timestamps.
 *
 * Usage: node scripts/agent-usage-report.mjs [--since <ISO>] [--until <ISO>] [--json] <file-or-directory>...
 *
 * Supported format: Claude Code session logs (*.jsonl). Codex rollout lines are detected and counted as
 * `unsupportedLines` (no guessing). Add a format by pushing another parser onto PARSERS.
 *
 * Rules (Claude Code):
 * - A streamed assistant message repeats the same `message.id` over several lines, each carrying the usage. Usage is
 *   counted once per id, using the per-field maximum seen for that id (the last line holds the final output_tokens,
 *   and input/cache fields are identical across lines, so the maximum equals the final value).
 * - tool_use blocks are deduplicated by their `id`; tool_result sizes are deduplicated by `tool_use_id`.
 * - Lines with `isSidechain: true` (subagents) stay in the session aggregate of their `sessionId`.
 * - Time ranges filter by each line's `timestamp`; with a range, lines without a valid timestamp are excluded.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import console from "node:console";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const WORK_TOOL_NAME = /^mcp__.*__(work_[a-z_]+)$/;
const CODEX_LINE_TYPES = new Set(["session_meta", "response_item", "event_msg", "turn_context"]);
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
    unsupportedLines: 0,
    messageUsage: new Map(),
    toolNames: new Map(),
    seenToolResults: new Set(),
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

function handleUser(state, session, message) {
  if (typeof message.content === "string") {
    session.turns += 1;
    return;
  }
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
  detect: (line) => (line.type === "assistant" || line.type === "user") && isRecord(line.message),
  handle(state, line) {
    if (!inRange(state, line.timestamp)) return;
    const session = sessionFor(state, line.sessionId);
    touchTimestamps(session, line.timestamp);
    if (line.isSidechain === true) session.sidechainLines += 1;
    if (line.type === "assistant") handleAssistant(state, session, line.message);
    else handleUser(state, session, line.message);
  },
};

/** Codex rollout lines are recognized only to be counted as unsupported. */
const codexParser = {
  name: "codex",
  detect: (line) => typeof line.type === "string" && CODEX_LINE_TYPES.has(line.type) && isRecord(line.payload),
  handle(state) {
    state.unsupportedLines += 1;
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
  PARSERS.find((parser) => parser.detect(line))?.handle(state, line);
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

/**
 * Summarizes jsonl session logs. `options`: `{ since?: string, until?: string }` (ISO 8601).
 * Returns `{ format, sessions, total, skippedLines, unsupportedLines }`; sessions carry only a label and a short hash.
 */
export async function summarizeFiles(paths, options = {}) {
  const state = createState(options);
  for (const file of await expandPaths(paths)) {
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const text of lines) consumeLine(state, text);
  }
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
    format: "claude-code",
    sessions,
    total: { sessions: sessions.length, ...state.total },
    skippedLines: state.skippedLines,
    unsupportedLines: state.unsupportedLines,
  };
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
    `skipped lines: ${report.skippedLines}; unsupported lines: ${report.unsupportedLines}`,
  ].join("\n");
}

const HELP = `Usage: node scripts/agent-usage-report.mjs [options] <file-or-directory>...

Prints aggregate usage (turns, tool calls, tokens, MCP result sizes) from local Claude Code session logs.
Directories are searched recursively for *.jsonl. Message text, tool inputs, paths and project names are never printed.

Options:
  --since <ISO>   only lines at or after this timestamp
  --until <ISO>   only lines at or before this timestamp
  --json          machine-readable output
  --help          show this help`;

function parseArgs(argv) {
  const options = { paths: [], json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
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
