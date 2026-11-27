/**
 * Never outputs message text, tool inputs, file paths, cwd, branch or project names, or error messages: only counts,
 * token sums and timestamps.
 */
export { UsageCache } from "./cache.js";
export { UsageScanAbortedError, UsageScanTimeoutError } from "./errors.js";
export { summarizeFiles, summarizeShapes } from "./scan.js";
export { buildActiveBlocks } from "./blocks.js";
export { safeModelId } from "./model.js";
export { cacheReadShareOf, formatForAgent, formatShapes, formatTable, primaryOf } from "./report.js";
export type { ForAgentOptions } from "./report.js";
export {
  defaultUsageSourceDirs,
  encodeClaudeProjectDir,
  resolveProjectSources,
  resolveUsageSources,
} from "./sources.js";
export type {
  UsageProjectInput,
  UsageProjectSources,
  UsageSourceDirs,
  UsageSourceGroup,
  UsageSourceProblem,
  UsageSources,
} from "./sources.js";
export type {
  AllocatedProjectUsage,
  AllocationBasis,
  AllocationBasisCounts,
  UnallocatedUsage,
  UsageAllocation,
  UsageAllocationGroup,
  UsageAllocationOptions,
  DayUsage,
  ModelUsage,
  OperationUsage,
  SessionUsage,
  ShapeReport,
  TokenCounts,
  UsageAgentId,
  UsageBlock,
  UsageCacheCounts,
  UsageEvent,
  UsageMetrics,
  UsageReport,
  UsageScanOptions,
  UsageTokens,
} from "./types.js";
