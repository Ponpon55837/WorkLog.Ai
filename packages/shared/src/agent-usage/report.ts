import type { ShapeReport, TokenCounts, UsageMetrics, UsageReport } from "./types.js";

export interface ForAgentOptions {
  /** User-chosen tracked project names; the only names that may appear. */
  projectNames?: string[];
  since?: string;
  until?: string;
  locale?: "en" | "zh-TW";
}

const TOP_SESSIONS = 10;
const TOP_TOOLS = 10;

const LABELS = {
  en: {
    title: "Agent usage report (estimates from local Agent logs; no message text, paths or inputs)",
    projects: "Projects",
    range: "Range",
    all: "all time",
    totals: "Totals",
    sessions: "conversations",
    turns: "turns",
    toolCalls: "tool calls",
    wiShare: "Work Intelligence share of tool calls",
    tokens: "Tokens",
    input: "uncached input",
    cacheCreation: "cache write",
    cacheRead: "cache read",
    output: "output",
    primary: "input + output (excl. cache)",
    cache: "Cache (reported separately, never added to the headline)",
    cacheShare: "cache read share (of all input-side tokens)",
    models: "Models",
    unlabelled: "unlabelled model",
    responses: "responses",
    operations: "Work Intelligence operations (calls, result chars, average chars)",
    topSessions: "Conversations with the most input + output",
    topTools: "Top other tools",
    perSession: "input + output",
    none: "none",
  },
  "zh-TW": {
    title: "Agent 用量報告（依本機 Agent 紀錄估算；不含訊息內容、路徑或工具輸入）",
    projects: "專案",
    range: "範圍",
    all: "全部時間",
    totals: "總計",
    sessions: "個對話",
    turns: "回合",
    toolCalls: "工具呼叫",
    wiShare: "Work Intelligence 占工具呼叫比例",
    tokens: "Token",
    input: "未快取輸入",
    cacheCreation: "快取寫入",
    cacheRead: "快取讀取",
    output: "輸出",
    primary: "輸入 + 輸出（不含快取）",
    cache: "快取（另列，不計入主要數字）",
    cacheShare: "快取讀取占比（占全部輸入端 token）",
    models: "模型分布",
    unlabelled: "未標示模型",
    responses: "次回應",
    operations: "Work Intelligence 操作（呼叫次數、結果字元、平均字元）",
    topSessions: "輸入 + 輸出最多的對話",
    topTools: "其他常用工具",
    perSession: "輸入 + 輸出",
    none: "無",
  },
} as const;

/** Fresh input + output: the headline number. Cache reads and writes are never part of it. */
export function primaryOf(tokens: Pick<TokenCounts, "input" | "output">): number {
  return tokens.input + tokens.output;
}

/** cacheRead / (input + cacheRead + cacheCreation), 0..1, or null when there are no input-side tokens. */
export function cacheReadShareOf(tokens: TokenCounts): number | null {
  const inputSide = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  return inputSide > 0 ? tokens.cacheRead / inputSide : null;
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
    [
      "session",
      "turns",
      "msgs",
      "tools",
      "wi-tools",
      "primary",
      "in",
      "out",
      "cache-r",
      "cache-w",
      "mcp-chars",
      "first",
      "last",
    ],
    ...[...report.sessions, { ...report.total, label: "total", hash: "" }].map((s) => [
      s.hash ? `${s.label}/${s.hash}` : s.label,
      s.turns,
      s.assistantMessages,
      s.toolCalls,
      Object.values(s.workIntelligenceTools).reduce((sum, n) => sum + n, 0),
      primaryOf(s.tokens),
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
    ...(report.total.models.length === 0
      ? []
      : [
          "models (agent, model: primary = in+out, cache-r, cache-w, responses):",
          ...report.total.models.map(
            (m) =>
              `  ${m.agent} ${m.model === "" ? "(unlabelled)" : m.model}: ${primaryOf(m.tokens)}, ${m.tokens.cacheRead}, ${m.tokens.cacheCreation}, ${m.responses}`,
          ),
          "",
        ]),
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
 * Plain text for pasting into an Agent: totals, the input + output headline, cache numbers on their own line, the model
 * split, Work Intelligence operations, top conversations (labels only, ranked by input + output) and top other tools.
 * Carries only counts, safe tool names, operation ids, allowlisted model ids and the given project names; never a path,
 * folder name, cwd or message text.
 */
export function formatForAgent(report: UsageReport, options: ForAgentOptions = {}): string {
  const text = LABELS[options.locale ?? "en"];
  const total = report.total;
  const wiCalls = Object.values(total.workIntelligenceTools).reduce((sum, n) => sum + n, 0);
  const share = cacheReadShareOf(total.tokens);
  const out: string[] = [text.title];
  if (options.projectNames && options.projectNames.length > 0)
    out.push(`${text.projects}: ${options.projectNames.join(", ")}`);
  out.push(`${text.range}: ${options.since ?? text.all} - ${options.until ?? text.all}`);
  out.push(
    "",
    `${text.totals}: ${total.sessions} ${text.sessions}, ${total.turns} ${text.turns}, ${total.toolCalls} ${text.toolCalls}`,
    `${text.wiShare}: ${total.toolCalls === 0 ? "0.0%" : percent(wiCalls / total.toolCalls)} (${wiCalls}/${total.toolCalls})`,
    `${text.tokens}: ${text.input} ${total.tokens.input}, ${text.output} ${total.tokens.output}`,
    `${text.primary}: ${primaryOf(total.tokens)}`,
    `${text.cache}: ${text.cacheRead} ${total.tokens.cacheRead}, ${text.cacheCreation} ${total.tokens.cacheCreation}, ${text.cacheShare} ${share === null ? "-" : percent(share)}`,
    "",
    `${text.models}:`,
  );
  if (total.models.length === 0) out.push(`  ${text.none}`);
  for (const model of total.models) {
    out.push(
      `  ${model.agent} / ${model.model === "" ? text.unlabelled : model.model}: ${text.primary} ${primaryOf(model.tokens)}, ${text.cacheRead} ${model.tokens.cacheRead}`,
    );
  }
  out.push("", `${text.operations}:`);
  const operations = sortedOperations(total);
  if (operations.length === 0) out.push(`  ${text.none}`);
  for (const [key, usage] of operations) {
    const average = usage.calls === 0 ? 0 : Math.round(usage.resultChars / usage.calls);
    out.push(`  ${key}: ${usage.calls}, ${usage.resultChars}, ${average}`);
  }
  out.push("", `${text.topSessions}:`);
  const sessions = report.sessions
    .map((session) => ({ session, primary: primaryOf(session.tokens) }))
    .sort((a, b) => b.primary - a.primary || (a.session.label < b.session.label ? -1 : 1))
    .slice(0, TOP_SESSIONS);
  if (sessions.length === 0) out.push(`  ${text.none}`);
  for (const { session, primary } of sessions) {
    out.push(
      `  ${session.label}: ${session.turns} ${text.turns}, ${session.toolCalls} ${text.toolCalls}, ${text.perSession} ${primary}`,
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
