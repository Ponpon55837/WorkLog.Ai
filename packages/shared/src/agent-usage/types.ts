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

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export type UsageAgentId = "claude-code" | "codex";

export interface ModelUsage {
  agent: UsageAgentId;
  model: string;
  tokens: TokenCounts;
  responses: number;
}

export interface DayUsage {
  date: string;
  tokens: TokenCounts;
}

export interface UsageEvent {
  agent: UsageAgentId;
  time: number;
  tokens: TokenCounts;
  key?: string;
}

export interface UsageBlock {
  agent: UsageAgentId;
  start: number;
  end: number;
  firstActivity: number;
  lastActivity: number;
  tokens: TokenCounts;
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
  models: ModelUsage[];
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

export interface UsageCacheCounts {
  reused: number;
  appended: number;
  parsed: number;
  bytesRead: number;
}

export type AllocationBasis = "projectRoot" | "filePaths" | "cwd";

export type AllocationBasisCounts = Record<AllocationBasis, number>;

export interface AllocatedProjectUsage {
  projectId: string;
  included: boolean;
  conversations: number;
  tokens: TokenCounts;
  primary: number;
  byBasis: AllocationBasisCounts;
}

export interface UnallocatedUsage {
  included: boolean;
  conversations: number;
  tokens: TokenCounts;
  primary: number;
}

export interface UsageAllocationGroup {
  projects: string[];
  allocated: AllocatedProjectUsage[];
  unallocated: UnallocatedUsage;
}

export interface UsageAllocation {
  groups: UsageAllocationGroup[];
}

export interface UsageAllocationOptions {
  groups: {
    projects: { id: string; root: string; selected: boolean }[];
    paths: string[];
  }[];
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
  blocks: UsageBlock[];
  cache: UsageCacheCounts;
  allocation: UsageAllocation;
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
  cache?: import("./cache.js").UsageCache;
  allocation?: UsageAllocationOptions;
}

export interface ClaudeToolUseRecord {
  id: string;
  n: string;
  k?: string;
  r?: string;
  f?: string;
}

export interface ClaudeToolResultRecord {
  id: string | null;
  length: number;
}

export interface ClaudeRecord {
  s: string;
  t: number | null;
  sc?: 1;
  m?: string;
  /** Model id of the assistant message, only when it passed the allowlist. */
  md?: string;
  u?: [number, number, number, number];
  tu?: ClaudeToolUseRecord[];
  h?: 1;
  tr?: ClaudeToolResultRecord[];
  /** Normalised cwd from this line on ("" = none); present only when it differs from the previous line's. */
  c?: string;
}
