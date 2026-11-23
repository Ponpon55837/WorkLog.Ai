/** Calls and result characters attributed to one Work Intelligence operation key (`work_read/work_search_memory`). */
export interface OperationUsage {
  calls: number;
  resultChars: number;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoningOutput?: number;
}

/** The four counted token kinds (no `reasoningOutput`). */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export type UsageAgentId = "claude-code" | "codex";

/** Tokens credited to one Agent and model; `model` is "" when the log names none or something unsafe. */
export interface ModelUsage {
  agent: UsageAgentId;
  model: string;
  tokens: TokenCounts;
  /** Claude Code assistant messages or Codex credited deltas. */
  responses: number;
}

/** Tokens credited on one local calendar day (`YYYY-MM-DD`). */
export interface DayUsage {
  date: string;
  tokens: TokenCounts;
}

/** One credited usage at an instant; kept only for the last 24 hours, to build the 5-hour blocks. */
export interface UsageEvent {
  agent: UsageAgentId;
  time: number;
  tokens: TokenCounts;
}

/** An active 5-hour block (epoch milliseconds); see `buildActiveBlocks`. */
export interface UsageBlock {
  agent: UsageAgentId;
  start: number;
  end: number;
  firstActivity: number;
  lastActivity: number;
  tokens: TokenCounts;
  /** input + output. */
  primary: number;
  elapsedMs: number;
  remainingMs: number;
  primaryPerMinute: number;
}

export interface UsageMetrics {
  turns: number;
  assistantMessages: number;
  sidechainLines: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  workIntelligenceTools: Record<string, number>;
  workIntelligenceOperations: Record<string, OperationUsage>;
  tokens: UsageTokens;
  /** Tokens by Agent and model, highest input + output first. */
  models: ModelUsage[];
  /** Tokens per local day, oldest first; lines without a timestamp are in no day. */
  daily: DayUsage[];
  mcpToolResultChars: number;
  workIntelligenceToolResultChars: number;
  unknownToolResultChars: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export interface SessionUsage extends UsageMetrics {
  label: string;
  hash: string;
}

/** How a scan used the cache: files reused as is, files read only from their cached offset, files parsed in full. */
export interface UsageCacheCounts {
  reused: number;
  appended: number;
  parsed: number;
  /** Bytes read from disk by this scan (a cache hit reads none). */
  bytesRead: number;
}

export interface UsageReport {
  formats: { claudeCodeLines: number; codexLines: number };
  sessions: SessionUsage[];
  total: UsageMetrics & { sessions: number };
  skippedLines: number;
  codexTokenMismatches: number;
  codexTokenSourceDisagreements: number;
  codexForkedSessions: number;
  codexIgnoredLines: number;
  codexCompactionLinked: number;
  codexCompactionCarryovers: number;
  codexContextOutputs: number;
  /** Active 5-hour blocks at scan time (at most one per Agent). */
  blocks: UsageBlock[];
  cache: UsageCacheCounts;
}

export interface ShapeReport {
  skippedLines: number;
  shapes: { key: string; count: number; paths: { path: string; types: string[] }[] }[];
}

export interface UsageScanOptions {
  /** ISO 8601 lower bound (inclusive). */
  since?: string;
  /** ISO 8601 upper bound (inclusive). */
  until?: string;
  /** Checked between lines and files; an aborted scan throws `UsageScanAbortedError`. */
  signal?: AbortSignal;
  /** Absolute `Date.now()` deadline; a late scan throws `UsageScanTimeoutError`. */
  deadlineMs?: number;
  /** The present as `Date.now()`, for the 5-hour blocks; defaults to the current time. */
  now?: number;
  /** Reuse across scans (Claude Code files only). */
  cache?: import("./cache.js").UsageCache;
}

/** One compact record per Claude Code line, before deduplication and range filtering. */
export interface ClaudeToolUseRecord {
  id: string;
  /** Classified, safe tool name (`work_read`, `Read`, `(other)`). */
  n: string;
  /** Work Intelligence operation key; present only for Work Intelligence tools. */
  k?: string;
}

export interface ClaudeToolResultRecord {
  /** tool_use_id, or null when the block names none. */
  id: string | null;
  length: number;
}

export interface ClaudeRecord {
  /** Session id (`(unknown)` when absent). */
  s: string;
  /** Timestamp in epoch milliseconds, null when missing or invalid. */
  t: number | null;
  /** Sidechain (subagent) line. */
  sc?: 1;
  /** Assistant message id. */
  m?: string;
  /** Model id of the assistant message, only when it passed the allowlist. */
  md?: string;
  /** Usage: input, output, cacheRead, cacheCreation (0 when absent). */
  u?: [number, number, number, number];
  tu?: ClaudeToolUseRecord[];
  /** A main-thread human prompt. */
  h?: 1;
  tr?: ClaudeToolResultRecord[];
}
