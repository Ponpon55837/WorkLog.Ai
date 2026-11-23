import type { OperationUsage, UsageMetrics } from "./types.js";

/** Metrics plus the numeric bounds that make first/last timestamp updates cheap; stripped before output. */
export type MetricsAcc = UsageMetrics & { firstMs?: number; lastMs?: number };

export const TOKEN_FIELDS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cache_read_input_tokens"],
  ["cacheCreation", "cache_creation_input_tokens"],
] as const;

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function emptyMetrics(): MetricsAcc {
  return {
    turns: 0,
    assistantMessages: 0,
    sidechainLines: 0,
    toolCalls: 0,
    toolCallsByName: {},
    workIntelligenceTools: {},
    workIntelligenceOperations: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    mcpToolResultChars: 0,
    workIntelligenceToolResultChars: 0,
    unknownToolResultChars: 0,
    firstTimestamp: null,
    lastTimestamp: null,
  };
}

export function bump(map: Record<string, number>, key: string, amount = 1): void {
  map[key] = (map[key] ?? 0) + amount;
}

/** Adds to one operation key's calls or result characters. */
export function bumpOperation(metrics: UsageMetrics, key: string, field: keyof OperationUsage, amount: number): void {
  const entry = (metrics.workIntelligenceOperations[key] ??= { calls: 0, resultChars: 0 });
  entry[field] += amount;
}

/** Records a timestamp (epoch ms) as the session's first/last bound; the ISO string is built only on a new bound. */
export function touchTimestamps(metrics: MetricsAcc, time: number | null): void {
  if (time === null) return;
  if (metrics.firstMs === undefined || time < metrics.firstMs) {
    metrics.firstMs = time;
    metrics.firstTimestamp = new Date(time).toISOString();
  }
  if (metrics.lastMs === undefined || time > metrics.lastMs) {
    metrics.lastMs = time;
    metrics.lastTimestamp = new Date(time).toISOString();
  }
}

export function mergeMetrics(target: MetricsAcc, source: MetricsAcc): void {
  for (const key of ["turns", "assistantMessages", "sidechainLines", "toolCalls"] as const) target[key] += source[key];
  for (const key of ["mcpToolResultChars", "workIntelligenceToolResultChars", "unknownToolResultChars"] as const) {
    target[key] += source[key];
  }
  for (const name of Object.keys(source.toolCallsByName)) {
    bump(target.toolCallsByName, name, source.toolCallsByName[name] ?? 0);
  }
  for (const name of Object.keys(source.workIntelligenceTools)) {
    bump(target.workIntelligenceTools, name, source.workIntelligenceTools[name] ?? 0);
  }
  for (const [key, usage] of Object.entries(source.workIntelligenceOperations)) {
    bumpOperation(target, key, "calls", usage.calls);
    bumpOperation(target, key, "resultChars", usage.resultChars);
  }
  for (const [field] of TOKEN_FIELDS) target.tokens[field] += source.tokens[field];
  if (source.tokens.reasoningOutput !== undefined) {
    target.tokens.reasoningOutput = (target.tokens.reasoningOutput ?? 0) + source.tokens.reasoningOutput;
  }
  if (source.firstTimestamp && (!target.firstTimestamp || source.firstTimestamp < target.firstTimestamp)) {
    target.firstTimestamp = source.firstTimestamp;
    if (source.firstMs !== undefined) target.firstMs = source.firstMs;
  }
  if (source.lastTimestamp && (!target.lastTimestamp || source.lastTimestamp > target.lastTimestamp)) {
    target.lastTimestamp = source.lastTimestamp;
    if (source.lastMs !== undefined) target.lastMs = source.lastMs;
  }
}

/** Drops the internal bounds so they never reach a report. */
export function publicMetrics(metrics: MetricsAcc): UsageMetrics {
  const { firstMs: _firstMs, lastMs: _lastMs, ...rest } = metrics;
  return rest;
}
