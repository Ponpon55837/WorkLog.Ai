import type { ShapeReport, UsageMetrics, UsageReport, UsageTokens } from "./types.js";

export interface ForAgentOptions {
  /** User-chosen tracked project names; the only names that may appear. */
  projectNames?: string[];
  since?: string;
  until?: string;
  locale?: "en" | "zh-TW";
}

export interface CostShares {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

/** Assumed price of each token kind relative to one uncached input token. An estimate, not a bill. */
export const COST_MULTIPLIERS = { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 } as const;

const TOP_SESSIONS = 10;
const TOP_TOOLS = 10;

const LABELS = {
  en: {
    title: "Agent usage report (estimates from local session logs; no message text, paths or inputs)",
    projects: "Projects",
    range: "Range",
    all: "all time",
    totals: "Totals",
    sessions: "sessions",
    turns: "turns",
    toolCalls: "tool calls",
    wiShare: "Work Intelligence share of tool calls",
    tokens: "Tokens",
    input: "uncached input",
    cacheCreation: "cache write",
    cacheRead: "cache read",
    output: "output",
    costTitle: "Estimated cost shares (estimate)",
    costNote: "assumed multipliers relative to uncached input: input 1, cache write 1.25, cache read 0.1, output 5",
    operations: "Work Intelligence operations (calls, result chars, average chars)",
    topSessions: "Top sessions by estimated cost",
    topTools: "Top other tools",
    units: "est. cost units",
    none: "none",
  },
  "zh-TW": {
    title: "Agent 用量報告（依本機 session 紀錄估算；不含訊息內容、路徑或工具輸入）",
    projects: "專案",
    range: "範圍",
    all: "全部時間",
    totals: "總計",
    sessions: "個 session",
    turns: "回合",
    toolCalls: "工具呼叫",
    wiShare: "Work Intelligence 佔工具呼叫比例",
    tokens: "Token",
    input: "未快取輸入",
    cacheCreation: "快取寫入",
    cacheRead: "快取讀取",
    output: "輸出",
    costTitle: "估算成本占比（估算）",
    costNote: "假設倍率（相對未快取輸入）：輸入 1、快取寫入 1.25、快取讀取 0.1、輸出 5",
    operations: "Work Intelligence 操作（呼叫次數、結果字元、平均字元）",
    topSessions: "估算成本最高的 session",
    topTools: "其他常用工具",
    units: "估算成本單位",
    none: "無",
  },
} as const;

/** Weighted token total of one token record, in input-token units (see COST_MULTIPLIERS). */
export function estimateCostUnits(tokens: UsageTokens): number {
  return (
    tokens.input * COST_MULTIPLIERS.input +
    tokens.cacheCreation * COST_MULTIPLIERS.cacheCreation +
    tokens.cacheRead * COST_MULTIPLIERS.cacheRead +
    tokens.output * COST_MULTIPLIERS.output
  );
}

/** Fractions of the estimated cost per token kind; all zero when there are no tokens. */
export function estimateCostShares(tokens: UsageTokens): CostShares {
  const units = {
    input: tokens.input * COST_MULTIPLIERS.input,
    cacheCreation: tokens.cacheCreation * COST_MULTIPLIERS.cacheCreation,
    cacheRead: tokens.cacheRead * COST_MULTIPLIERS.cacheRead,
    output: tokens.output * COST_MULTIPLIERS.output,
  };
  const sum = units.input + units.cacheCreation + units.cacheRead + units.output;
  if (sum === 0) return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
  return {
    input: units.input / sum,
    cacheCreation: units.cacheCreation / sum,
    cacheRead: units.cacheRead / sum,
    output: units.output / sum,
  };
}

export function formatShapes(result: ShapeReport): string {
  const out = ["shape: key paths and JS types only, never values"];
  for (const shape of result.shapes) {
    out.push("", `${shape.key}  lines=${shape.count}`);
    for (const { path, types } of shape.paths) out.push(`  ${path}: ${types.join("|")}`);
  }
  out.push("", `skipped lines: ${result.skippedLines}`);
  return out.join("\n");
}

function sortedOperations(metrics: UsageMetrics): [string, { calls: number; resultChars: number }][] {
  return Object.entries(metrics.workIntelligenceOperations).sort((a, b) =>
    b[1].calls !== a[1].calls ? b[1].calls - a[1].calls : a[0] < b[0] ? -1 : 1,
  );
}

export function formatTable(report: UsageReport): string {
  const rows = [
    ["session", "turns", "msgs", "tools", "wi-tools", "in", "out", "cache-r", "cache-w", "mcp-chars", "first", "last"],
    ...[...report.sessions, { ...report.total, label: "total", hash: "" }].map((s) => [
      s.hash ? `${s.label}/${s.hash}` : s.label,
      s.turns,
      s.assistantMessages,
      s.toolCalls,
      Object.values(s.workIntelligenceTools).reduce((sum, n) => sum + n, 0),
      s.tokens.input,
      s.tokens.output,
      s.tokens.cacheRead,
      s.tokens.cacheCreation,
      s.mcpToolResultChars,
      s.firstTimestamp ?? "-",
      s.lastTimestamp ?? "-",
    ]),
  ].map((row) => row.map(String));
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  const table = rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  const names = (title: string, map: Record<string, number>): string[] => {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    return entries.length === 0 ? [] : [`${title}: ${entries.map(([name, n]) => `${name}=${n}`).join(", ")}`];
  };
  const operations = sortedOperations(report.total);
  return [
    ...table,
    "",
    ...names("tools", report.total.toolCallsByName),
    ...names("work intelligence tools", report.total.workIntelligenceTools),
    ...(operations.length === 0
      ? []
      : [
          `work intelligence operations: ${operations.map(([key, usage]) => `${key}=${usage.calls}/${usage.resultChars}`).join(", ")}`,
        ]),
    `work intelligence result chars: ${report.total.workIntelligenceToolResultChars}; unknown result chars: ${report.total.unknownToolResultChars}`,
    `skipped lines: ${report.skippedLines}; lines by format: claude-code=${report.formats.claudeCodeLines}, codex=${report.formats.codexLines}`,
    ...(report.formats.codexLines > 0
      ? [
          "codex: experimental, not verified against real logs",
          `codex canaries: token mismatches=${report.codexTokenMismatches}, token source disagreements=${report.codexTokenSourceDisagreements}, forked sessions=${report.codexForkedSessions}, ignored lines=${report.codexIgnoredLines}, compactions linked=${report.codexCompactionLinked}, compaction carryovers=${report.codexCompactionCarryovers}, context outputs=${report.codexContextOutputs}`,
        ]
      : []),
  ].join("\n");
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Plain text for pasting into an Agent: totals, token split, estimated cost shares, Work Intelligence operations, top
 * sessions (labels only) and top other tools. Carries only counts, safe tool names, operation ids and the given
 * project names; never a path, folder name, cwd or message text.
 */
export function formatForAgent(report: UsageReport, options: ForAgentOptions = {}): string {
  const text = LABELS[options.locale ?? "en"];
  const total = report.total;
  const shares = estimateCostShares(total.tokens);
  const wiCalls = Object.values(total.workIntelligenceTools).reduce((sum, n) => sum + n, 0);
  const out: string[] = [text.title];
  if (options.projectNames && options.projectNames.length > 0)
    out.push(`${text.projects}: ${options.projectNames.join(", ")}`);
  out.push(`${text.range}: ${options.since ?? text.all} - ${options.until ?? text.all}`);
  out.push(
    "",
    `${text.totals}: ${total.sessions} ${text.sessions}, ${total.turns} ${text.turns}, ${total.toolCalls} ${text.toolCalls}`,
    `${text.wiShare}: ${total.toolCalls === 0 ? "0.0%" : percent(wiCalls / total.toolCalls)} (${wiCalls}/${total.toolCalls})`,
    `${text.tokens}: ${text.input} ${total.tokens.input}, ${text.cacheCreation} ${total.tokens.cacheCreation}, ${text.cacheRead} ${total.tokens.cacheRead}, ${text.output} ${total.tokens.output}`,
    "",
    `${text.costTitle}: ${text.input} ${percent(shares.input)}, ${text.cacheCreation} ${percent(shares.cacheCreation)}, ${text.cacheRead} ${percent(shares.cacheRead)}, ${text.output} ${percent(shares.output)}`,
    text.costNote,
    "",
    `${text.operations}:`,
  );
  const operations = sortedOperations(total);
  if (operations.length === 0) out.push(`  ${text.none}`);
  for (const [key, usage] of operations) {
    const average = usage.calls === 0 ? 0 : Math.round(usage.resultChars / usage.calls);
    out.push(`  ${key}: ${usage.calls}, ${usage.resultChars}, ${average}`);
  }
  out.push("", `${text.topSessions}:`);
  const sessions = report.sessions
    .map((session) => ({ session, units: estimateCostUnits(session.tokens) }))
    .sort((a, b) => b.units - a.units)
    .slice(0, TOP_SESSIONS);
  if (sessions.length === 0) out.push(`  ${text.none}`);
  for (const { session, units } of sessions) {
    out.push(
      `  ${session.label}: ${session.turns} ${text.turns}, ${session.toolCalls} ${text.toolCalls}, ${text.units} ${Math.round(units)}`,
    );
  }
  out.push("", `${text.topTools}:`);
  const tools = Object.entries(total.toolCallsByName)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_TOOLS);
  if (tools.length === 0) out.push(`  ${text.none}`);
  for (const [name, calls] of tools) out.push(`  ${name}: ${calls}`);
  return out.join("\n");
}
