import type {
  UsageBlockItem,
  UsageDayItem,
  UsageModelItem,
  UsageOperation,
  UsageOtherTool,
  UsageScanResponse,
  UsageSessionItem,
  UsageTokenSummary,
  UsageTokens,
} from "@work-intelligence/core";
import { cacheReadShareOf, formatForAgent, primaryOf, type UsageReport } from "@work-intelligence/shared/agent-usage";

const TOP_SESSIONS = 20;
const TOP_OTHER_TOOLS = 20;
const WORK_INTELLIGENCE_TOOL = /^work_/;

function pickTokens(tokens: UsageTokens): UsageTokens {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheCreation: tokens.cacheCreation,
  };
}

function summaryOf(tokens: UsageTokens): UsageTokenSummary {
  const picked = pickTokens(tokens);
  return { ...picked, primary: primaryOf(picked), cacheReadShare: cacheReadShareOf(picked) };
}

function modelsOf(total: UsageReport["total"]): UsageModelItem[] {
  return total.models.map((entry) => ({
    agent: entry.agent,
    model: entry.model,
    tokens: pickTokens(entry.tokens),
    primary: primaryOf(entry.tokens),
    responses: entry.responses,
  }));
}

function dailyOf(total: UsageReport["total"]): UsageDayItem[] {
  return total.daily.map((day) => ({ date: day.date, tokens: pickTokens(day.tokens) }));
}

/** Blocks describe the present, so they are returned only when the range reaches it. */
function blocksOf(report: UsageReport, until: string | null, now: number): UsageBlockItem[] {
  if (until !== null && Date.parse(until) < now) return [];
  return report.blocks.map((block) => ({
    agent: block.agent,
    startAt: new Date(block.start).toISOString(),
    endAt: new Date(block.end).toISOString(),
    firstActivityAt: new Date(block.firstActivity).toISOString(),
    lastActivityAt: new Date(block.lastActivity).toISOString(),
    tokens: pickTokens(block.tokens),
    primary: block.primary,
    elapsedMs: block.elapsedMs,
    remainingMs: block.remainingMs,
    primaryPerMinute: block.primaryPerMinute,
  }));
}

function operationsOf(total: UsageReport["total"]): UsageOperation[] {
  return Object.entries(total.workIntelligenceOperations)
    .map(([key, value]) => ({
      key,
      calls: value.calls,
      resultChars: value.resultChars,
      avgChars: value.calls > 0 ? Math.round(value.resultChars / value.calls) : 0,
    }))
    .sort((a, b) => b.calls - a.calls || (a.key < b.key ? -1 : 1));
}

function otherToolsOf(total: UsageReport["total"]): UsageOtherTool[] {
  return Object.entries(total.toolCallsByName)
    .filter(([name]) => !WORK_INTELLIGENCE_TOOL.test(name))
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1))
    .slice(0, TOP_OTHER_TOOLS);
}

function sessionsOf(report: UsageReport): UsageSessionItem[] {
  return report.sessions
    .map((session) => ({
      label: session.label,
      turns: session.turns,
      toolCalls: session.toolCalls,
      tokens: pickTokens(session.tokens),
      primary: primaryOf(session.tokens),
    }))
    .sort((a, b) => b.primary - a.primary || (a.label < b.label ? -1 : 1))
    .slice(0, TOP_SESSIONS);
}

/** Builds the page's numbers and the Agent text from a report; nothing in it carries a path or a message. */
export function buildUsageResponse(
  report: UsageReport,
  extra: {
    problems: UsageScanResponse["problems"];
    projectNames: string[];
    range: UsageScanResponse["range"];
    durationMs: number;
    locale: "en" | "zh-TW";
    /** The present for the blocks check; defaults to the current time. */
    now?: number;
  },
): UsageScanResponse {
  const { total } = report;
  const workIntelligenceCalls = Object.values(total.workIntelligenceTools).reduce((sum, count) => sum + count, 0);
  return {
    totals: {
      sessions: total.sessions,
      turns: total.turns,
      assistantMessages: total.assistantMessages,
      toolCalls: total.toolCalls,
      workIntelligenceCalls,
      workIntelligenceShare: total.toolCalls > 0 ? workIntelligenceCalls / total.toolCalls : 0,
    },
    tokens: summaryOf(total.tokens),
    models: modelsOf(total),
    daily: dailyOf(total),
    blocks: blocksOf(report, extra.range.until, extra.now ?? Date.now()),
    operations: operationsOf(total),
    sessions: sessionsOf(report),
    otherTools: otherToolsOf(total),
    forAgentText: formatForAgent(report, {
      projectNames: extra.projectNames,
      ...(extra.range.since ? { since: extra.range.since } : {}),
      ...(extra.range.until ? { until: extra.range.until } : {}),
      locale: extra.locale,
    }),
    cache: { reused: report.cache.reused, appended: report.cache.appended, parsed: report.cache.parsed },
    durationMs: extra.durationMs,
    range: extra.range,
    problems: extra.problems,
  };
}
