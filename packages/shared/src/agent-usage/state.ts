import { prepareGroups, type PreparedGroup, type SessionEvidence } from "./allocation.js";
import type { CodexContext, FirstCredit } from "./codex.js";
import { emptyMetrics, type MetricsAcc } from "./metrics.js";
import type { ToolInfo } from "./tools.js";
import type { TokenCounts, UsageAgentId, UsageEvent, UsageScanOptions } from "./types.js";

interface SessionAcc extends MetricsAcc {
  key: string;
}

export interface ScanState {
  now: number;
  events: UsageEvent[];
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
  codexContinuations: { key: string; previous: string; first: FirstCredit }[];
  messageUsage: Map<string, { model: string; input: number; output: number; cacheRead: number; cacheCreation: number }>;
  toolNames: Map<string, ToolInfo>;
  seenToolResults: Set<string>;
  codexTokenTuples: Set<string>;
  file: { path: string; codex: CodexContext | null; group: number | null; cwd: string };
  groups: PreparedGroup[];
  evidence: Map<string, SessionEvidence>;
  evidenceToolIds: Set<string>;
}

export function createState(options: Pick<UsageScanOptions, "since" | "until" | "now" | "allocation">): ScanState {
  const since = options.since === undefined ? null : Date.parse(options.since);
  const until = options.until === undefined ? null : Date.parse(options.until);
  if ((since !== null && Number.isNaN(since)) || (until !== null && Number.isNaN(until))) {
    throw new Error("Invalid --since/--until value: expected an ISO 8601 date.");
  }
  return {
    now: options.now ?? Date.now(),
    events: [],
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
    file: { path: "", codex: null, group: null, cwd: "" },
    groups: prepareGroups(options.allocation),
    evidence: new Map(),
    evidenceToolIds: new Set(),
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

const EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function recordUsageEvent(
  state: ScanState,
  agent: UsageAgentId,
  time: number | null,
  tokens: TokenCounts,
  key?: string,
): UsageEvent | null {
  if (time === null || time < state.now - EVENT_WINDOW_MS) return null;
  const event: UsageEvent = { agent, time, tokens: { ...tokens }, ...(key === undefined ? {} : { key }) };
  state.events.push(event);
  return event;
}

export function inRange(state: ScanState, time: number | null): boolean {
  if (state.since === null && state.until === null) return true;
  if (time === null) return false;
  return (state.since === null || time >= state.since) && (state.until === null || time <= state.until);
}

export function parseTimestamp(timestamp: unknown): number | null {
  if (typeof timestamp !== "string") return null;
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? null : time;
}
