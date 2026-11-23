/** Types for scripts/agent-usage-report.mjs, so tests can import it. */
export type {
  OperationUsage,
  SessionUsage,
  ShapeReport as UsageShapes,
  UsageCacheCounts,
  UsageMetrics,
  UsageReport,
} from "../packages/shared/src/agent-usage/index.js";
export declare function summarizeFiles(
  paths: string[],
  options?: { since?: string; until?: string },
): Promise<import("../packages/shared/src/agent-usage/index.js").UsageReport>;
export declare function summarizeShapes(
  paths: string[],
): Promise<import("../packages/shared/src/agent-usage/index.js").ShapeReport>;
