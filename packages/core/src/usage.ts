/**
 * Agent usage: the REST contract of `GET /api/usage/projects` and `POST /api/usage/scan`.
 * Everything here is counts, token sums, ISO timestamps, safe tool names, `work_*` operation ids and
 * `session-N` labels. No message text, tool input, path, cwd or Claude folder name ever appears.
 */

/** Why a project's agent sources could not be used. */
export const USAGE_PROJECT_PROBLEMS = [
  "claude-dir-missing",
  "codex-dir-missing",
  "permission-denied",
  "none-found",
] as const;

export type UsageProjectProblem = (typeof USAGE_PROJECT_PROBLEMS)[number];

export const USAGE_RANGES = ["7d", "30d", "custom"] as const;

export type UsageRange = (typeof USAGE_RANGES)[number];

export interface UsageProjectSources {
  /** Claude Code project folders (including worktrees) matched to the project root. */
  claudeFolders: number;
  /** Codex rollout files whose session cwd is inside the project root. */
  codexFiles: number;
}

export interface UsageProjectItem {
  id: string;
  name: string;
  /** True for the project whose root contains the server's launch directory, when there is one. */
  current: boolean;
  sources: UsageProjectSources;
  problem?: UsageProjectProblem;
}

/**
 * Tracked projects that share a source: Claude Code or Codex sessions opened at a folder above all of them (a monorepo
 * root). Ids and counts only; the folder is never named.
 */
export interface UsageProjectGroup {
  /** Tracked project ids below the shared folder. */
  projects: string[];
  claudeFolders: number;
  codexFiles: number;
}

export interface UsageProjectsResponse {
  items: UsageProjectItem[];
  /** Shared sources; empty when no session was opened above a tracked project. */
  groups: UsageProjectGroup[];
}

/** Body of `POST /api/usage/scan`. Manual folders are absolute paths; the server never echoes them back. */
export interface UsageScanRequest {
  /** Tracked project ids to scan (max 200). */
  projectIds?: string[];
  /** Scan every tracked project; wins over `projectIds`. */
  all?: boolean;
  /** Extra absolute folders to scan (max 20, each at most 1024 characters). */
  manualFolders?: string[];
  range: UsageRange;
  /** ISO timestamps, used when `range` is `custom`. */
  since?: string;
  until?: string;
}

export interface UsageTokens {
  /** Fresh (uncached) input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Token totals plus the headline and a derived ratio. `primary` = input + output (fresh input and output); cache reads
 * and cache writes are never added to it. `cacheReadShare` = cacheRead / (input + cacheRead + cacheCreation), the
 * share of input-side tokens read from the cache, 0..1, or null when there are no input-side tokens. Logs carry no
 * per-request hit or miss, so this is not a hit rate.
 */
export interface UsageTokenSummary extends UsageTokens {
  primary: number;
  cacheReadShare: number | null;
}

export const USAGE_AGENTS = ["claude-code", "codex"] as const;

export type UsageAgent = (typeof USAGE_AGENTS)[number];

/** Tokens of one Agent and model. `model` is "" when the log names none or names something that is not a model id. */
export interface UsageModelItem {
  agent: UsageAgent;
  model: string;
  tokens: UsageTokens;
  /** input + output. */
  primary: number;
  /** Assistant responses (Claude Code messages, Codex token deltas) credited to the model. */
  responses: number;
}

/** Tokens credited on one local calendar day of the server (`YYYY-MM-DD`). Days without usage are omitted. */
export interface UsageDayItem {
  date: string;
  tokens: UsageTokens;
}

/**
 * The 5-hour block that is active at scan time for one Agent, with the ccusage `blocks` rules: a block starts at its
 * first usage floored to the local hour and ends 5 hours later; a gap of 5 hours since the previous usage, or reaching
 * the end, starts a new block. Only active blocks are returned, and only when the scan range reaches the present.
 */
export interface UsageBlockItem {
  agent: UsageAgent;
  /** ISO instants. */
  startAt: string;
  endAt: string;
  firstActivityAt: string;
  lastActivityAt: string;
  tokens: UsageTokens;
  /** input + output. */
  primary: number;
  elapsedMs: number;
  remainingMs: number;
  /** primary per minute since the first activity; 0 with under a minute of data. */
  primaryPerMinute: number;
}

export interface UsageTotals {
  sessions: number;
  turns: number;
  assistantMessages: number;
  toolCalls: number;
  workIntelligenceCalls: number;
  /** workIntelligenceCalls / toolCalls, 0..1 (0 when there are no tool calls). */
  workIntelligenceShare: number;
}

export interface UsageOperation {
  /** `<entry tool>/<work_operation>`, or `<entry tool>/(unknown)`, or an old direct tool name. */
  key: string;
  calls: number;
  /** Characters of tool results attributed to the operation. */
  resultChars: number;
  avgChars: number;
}

export interface UsageSessionItem {
  /** `session-N`, never a real session id. */
  label: string;
  turns: number;
  toolCalls: number;
  tokens: UsageTokens;
  /** input + output. */
  primary: number;
}

export interface UsageOtherTool {
  name: string;
  calls: number;
}

export interface UsageCacheCounts {
  /** Files reused unchanged from the cache. */
  reused: number;
  /** Files read only from the previously stored offset. */
  appended: number;
  /** Files parsed from the start. */
  parsed: number;
}

/** What a conversation of a shared source showed about its project; precedence in this order. */
export const USAGE_ALLOCATION_BASES = ["projectRoot", "filePaths", "cwd"] as const;

export type UsageAllocationBasis = (typeof USAGE_ALLOCATION_BASES)[number];

/** Conversations of a shared source given to one project of a group, by the basis that decided it. */
export interface UsageAllocatedProject {
  projectId: string;
  /** The project was selected, so these conversations are in `totals`, `tokens` and the rest of the response. */
  included: boolean;
  conversations: number;
  tokens: UsageTokens;
  /** input + output. */
  primary: number;
  byBasis: Record<UsageAllocationBasis, number>;
}

/** Conversations of a shared source that no basis could give to a project. */
export interface UsageUnallocated {
  /** Every project of the group was selected, so these conversations are in the totals. */
  included: boolean;
  conversations: number;
  tokens: UsageTokens;
  /** input + output. */
  primary: number;
}

export interface UsageAllocationGroup {
  /** Project ids of the group. */
  projects: string[];
  allocated: UsageAllocatedProject[];
  unallocated: UsageUnallocated;
}

/**
 * Conversations opened above several projects, each counted once in exactly one bucket: a project of the group or
 * the group's unallocated bucket. Only groups that have a selected project appear. Counts, ids and tokens only.
 */
export interface UsageAllocation {
  groups: UsageAllocationGroup[];
}

export interface UsageScanProblem {
  projectId: string;
  problem: UsageProjectProblem;
}

export interface UsageScanResponse {
  totals: UsageTotals;
  tokens: UsageTokenSummary;
  /** Tokens by Agent and model, highest `primary` first. */
  models: UsageModelItem[];
  /** Tokens per local day, oldest first; days without usage are omitted. */
  daily: UsageDayItem[];
  /** Active 5-hour blocks at scan time, one per Agent at most; empty when the range ends in the past. */
  blocks: UsageBlockItem[];
  operations: UsageOperation[];
  /** Top 20 sessions by `primary` (input + output). */
  sessions: UsageSessionItem[];
  /** Top 20 non-Work-Intelligence tools. */
  otherTools: UsageOtherTool[];
  /** Plain-text report for an Agent, built on the server. Copy it verbatim. */
  forAgentText: string;
  cache: UsageCacheCounts;
  allocation: UsageAllocation;
  durationMs: number;
  range: { since: string | null; until: string | null };
  problems: UsageScanProblem[];
}
