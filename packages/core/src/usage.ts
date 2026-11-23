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

export interface UsageProjectsResponse {
  items: UsageProjectItem[];
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
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Fractions of the estimated cost (0..1, sum 1 when any tokens exist). */
export interface UsageCostShares {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
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
  /** Relative cost units under the assumed multipliers (uncached input = 1 per token); an estimate. */
  estimatedCostUnits: number;
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

export interface UsageScanProblem {
  projectId: string;
  problem: UsageProjectProblem;
}

export interface UsageScanResponse {
  totals: UsageTotals;
  tokens: UsageTokens;
  /** Estimated shares of cost per token kind; labelled as an estimate in the UI. */
  costShares: UsageCostShares;
  /** The multipliers behind `costShares`, relative to the uncached input price. */
  costMultipliers: UsageCostShares;
  operations: UsageOperation[];
  /** Top 20 sessions by estimated cost. */
  sessions: UsageSessionItem[];
  /** Top 20 non-Work-Intelligence tools. */
  otherTools: UsageOtherTool[];
  /** Plain-text report for an Agent, built on the server. Copy it verbatim. */
  forAgentText: string;
  cache: UsageCacheCounts;
  durationMs: number;
  range: { since: string | null; until: string | null };
  problems: UsageScanProblem[];
}
