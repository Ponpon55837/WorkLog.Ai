import type {
  UsageOperation,
  UsageOtherTool,
  UsageScanResponse,
  UsageSessionItem,
  UsageTokens,
} from "@work-intelligence/core";
import {
  COST_MULTIPLIERS,
  estimateCostShares,
  estimateCostUnits,
  formatForAgent,
  type UsageReport,
} from "@work-intelligence/shared/agent-usage";

const TOP_SESSIONS = 20;
const TOP_OTHER_TOOLS = 20;
const WORK_INTELLIGENCE_TOOL = /^work_/;

function pickTokens(tokens: UsageReport["total"]["tokens"]): UsageTokens {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheCreation: tokens.cacheCreation,
  };
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
      estimatedCostUnits: estimateCostUnits(session.tokens),
    }))
    .sort((a, b) => b.estimatedCostUnits - a.estimatedCostUnits || (a.label < b.label ? -1 : 1))
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
    tokens: pickTokens(total.tokens),
    costShares: estimateCostShares(total.tokens),
    costMultipliers: { ...COST_MULTIPLIERS },
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
