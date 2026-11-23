import type { DayUsage, ModelUsage, OperationUsage, TokenCounts, UsageAgentId, UsageMetrics } from "./types.js";

/** Metrics plus the numeric bounds and the keyed breakdowns; converted by `publicMetrics` before output. */
export type MetricsAcc = Omit<UsageMetrics, "models" | "daily"> & {
  firstMs?: number;
  lastMs?: number;
  /** Keyed by `agent|model`. */
  byModel: Record<string, ModelUsage>;
  /** Keyed by local date. */
  byDay: Record<string, TokenCounts>;
};

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
    byModel: {},
    byDay: {},
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
export function bumpOperation(
  metrics: Pick<UsageMetrics, "workIntelligenceOperations">,
  key: string,
  field: keyof OperationUsage,
  amount: number,
): void {
  const entry = (metrics.workIntelligenceOperations[key] ??= { calls: 0, resultChars: 0 });
  entry[field] += amount;
}

function addCounts(target: TokenCounts, source: TokenCounts): void {
  for (const [field] of TOKEN_FIELDS) target[field] += source[field];
}

/** The server's local calendar date of an instant, `YYYY-MM-DD`. */
export function localDate(time: number): string {
  const date = new Date(time);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The model entry of an Agent, created on first use. */
export function modelEntry(metrics: MetricsAcc, agent: UsageAgentId, model: string): ModelUsage {
  return (metrics.byModel[`${agent}|${model}`] ??= {
    agent,
    model,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    responses: 0,
  });
}

/** Credits tokens (and responses) to an Agent and model and to the local day of `time` (none when null). */
export function creditBreakdown(
  metrics: MetricsAcc,
  agent: UsageAgentId,
  model: string,
  time: number | null,
  tokens: TokenCounts,
  responses: number,
): void {
  const entry = modelEntry(metrics, agent, model);
  addCounts(entry.tokens, tokens);
  entry.responses += responses;
  if (time === null) return;
  addCounts((metrics.byDay[localDate(time)] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }), tokens);
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
  for (const entry of Object.values(source.byModel)) {
    const merged = modelEntry(target, entry.agent, entry.model);
    addCounts(merged.tokens, entry.tokens);
    merged.responses += entry.responses;
  }
  for (const [date, tokens] of Object.entries(source.byDay)) {
    addCounts((target.byDay[date] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }), tokens);
  }
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

/** Drops the internal bounds and turns the keyed breakdowns into sorted lists. */
export function publicMetrics(metrics: MetricsAcc): UsageMetrics {
  const { firstMs: _firstMs, lastMs: _lastMs, byModel, byDay, ...rest } = metrics;
  const primary = (entry: ModelUsage): number => entry.tokens.input + entry.tokens.output;
  const models = Object.values(byModel)
    .map((entry) => ({ ...entry, tokens: { ...entry.tokens } }))
    .sort(
      (a, b) =>
        primary(b) - primary(a) || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : a.model < b.model ? -1 : 1),
    );
  const daily: DayUsage[] = Object.keys(byDay)
    .sort()
    .map((date) => ({ date, tokens: { ...(byDay[date] as TokenCounts) } }));
  return { ...rest, models, daily };
}
