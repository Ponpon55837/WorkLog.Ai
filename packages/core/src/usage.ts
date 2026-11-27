/**
 * Counts, token sums, ISO timestamps, safe tool names, `work_*` operation ids and `session-N` labels only; never
 * message text, tool input, paths or folder names.
 */

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
  claudeFolders: number;
  codexFiles: number;
}

export interface UsageProjectItem {
  id: string;
  name: string;
  current: boolean;
  sources: UsageProjectSources;
  problem?: UsageProjectProblem;
}

export interface UsageProjectGroup {
  projects: string[];
  claudeFolders: number;
  codexFiles: number;
}

export interface UsageProjectsResponse {
  items: UsageProjectItem[];
  groups: UsageProjectGroup[];
}

/** Body of `POST /api/usage/scan`. Manual folders are absolute paths; the server never echoes them back. */
export interface UsageScanRequest {
  /** Tracked project ids to scan (max 200). */
  projectIds?: string[];
  all?: boolean;
  /** Extra absolute folders to scan (max 20, each at most 1024 characters). */
  manualFolders?: string[];
  range: UsageRange;
  /** ISO timestamps, used when `range` is `custom`. */
  since?: string;
  until?: string;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * `primary` = input + output; cache reads and writes are never added. `cacheReadShare` = cacheRead / (input +
 * cacheRead + cacheCreation), 0..1, null without input-side tokens; not a hit rate.
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
  primary: number;
  responses: number;
}

/** Tokens credited on one local calendar day of the server (`YYYY-MM-DD`). Days without usage are omitted. */
export interface UsageDayItem {
  date: string;
  tokens: UsageTokens;
}

export interface UsageBlockItem {
  agent: UsageAgent;
  /** ISO instants. */
  startAt: string;
  endAt: string;
  firstActivityAt: string;
  lastActivityAt: string;
  tokens: UsageTokens;
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
  resultChars: number;
  avgChars: number;
}

export interface UsageSessionItem {
  /** `session-N`, never a real session id. */
  label: string;
  turns: number;
  toolCalls: number;
  tokens: UsageTokens;
  primary: number;
}

export interface UsageOtherTool {
  name: string;
  calls: number;
}

export interface UsageCacheCounts {
  reused: number;
  appended: number;
  parsed: number;
}

export const USAGE_ALLOCATION_BASES = ["projectRoot", "filePaths", "cwd"] as const;

export type UsageAllocationBasis = (typeof USAGE_ALLOCATION_BASES)[number];

export interface UsageAllocatedProject {
  projectId: string;
  included: boolean;
  conversations: number;
  tokens: UsageTokens;
  primary: number;
  byBasis: Record<UsageAllocationBasis, number>;
}

export interface UsageUnallocated {
  included: boolean;
  conversations: number;
  tokens: UsageTokens;
  primary: number;
}

export interface UsageAllocationGroup {
  projects: string[];
  allocated: UsageAllocatedProject[];
  unallocated: UsageUnallocated;
}

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
  models: UsageModelItem[];
  daily: UsageDayItem[];
  blocks: UsageBlockItem[];
  operations: UsageOperation[];
  /** Top 20 sessions by `primary` (input + output). */
  sessions: UsageSessionItem[];
  /** Top 20 non-Work-Intelligence tools. */
  otherTools: UsageOtherTool[];
  forAgentText: string;
  cache: UsageCacheCounts;
  allocation: UsageAllocation;
  durationMs: number;
  range: { since: string | null; until: string | null };
  problems: UsageScanProblem[];
}
