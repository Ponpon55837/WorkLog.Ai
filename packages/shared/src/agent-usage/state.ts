import type { CodexContext } from "./codex.js";
import { emptyMetrics, type MetricsAcc } from "./metrics.js";
import type { ToolInfo } from "./tools.js";
import type { UsageScanOptions } from "./types.js";

interface SessionAcc extends MetricsAcc {
  key: string;
}

/** Everything a scan accumulates; the Claude reducer and the Codex parser both write into it. */
export interface ScanState {
  since: number | null;
  until: number | null;
  sessions: Map<string, SessionAcc>;
  total: MetricsAcc;
  skippedLines: number;
  formats: { claudeCodeLines: number; codexLines: number };
  codexTokenMismatches: number;
  codexTokenSourceDisagreements: number;
  codexForkedSessions: number;
  codexIgnoredLines: number;
  codexCompactionLinked: number;
  codexCompactionCarryovers: number;
  codexContextOutputs: number;
  codexThreadCredited: Map<string, Record<string, number>>;
  codexContinuations: { key: string; previous: string; first: Record<string, number> }[];
  messageUsage: Map<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>;
  toolNames: Map<string, ToolInfo>;
  seenToolResults: Set<string>;
  codexTokenTuples: Set<string>;
  file: { path: string; codex: CodexContext | null };
}

export function createState(options: Pick<UsageScanOptions, "since" | "until">): ScanState {
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
    formats: { claudeCodeLines: 0, codexLines: 0 },
    codexTokenMismatches: 0,
    codexTokenSourceDisagreements: 0,
    codexForkedSessions: 0,
    codexIgnoredLines: 0,
    codexCompactionLinked: 0,
    codexCompactionCarryovers: 0,
    codexContextOutputs: 0,
    codexThreadCredited: new Map(),
    codexContinuations: [],
    messageUsage: new Map(),
    toolNames: new Map(),
    seenToolResults: new Set(),
    codexTokenTuples: new Set(),
    file: { path: "", codex: null },
  };
}

export function sessionFor(state: ScanState, sessionId: unknown): SessionAcc {
  const key = typeof sessionId === "string" && sessionId !== "" ? sessionId : "(unknown)";
  let session = state.sessions.get(key);
  if (!session) {
    session = { key, ...emptyMetrics() };
    state.sessions.set(key, session);
  }
  return session;
}

/** Returns false when the line falls outside the requested time range (epoch ms; null = no valid timestamp). */
export function inRange(state: ScanState, time: number | null): boolean {
  if (state.since === null && state.until === null) return true;
  if (time === null) return false;
  return (state.since === null || time >= state.since) && (state.until === null || time <= state.until);
}

/** Epoch ms of an ISO timestamp field, null when it is not a valid date string. */
export function parseTimestamp(timestamp: unknown): number | null {
  if (typeof timestamp !== "string") return null;
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? null : time;
}
