import { describe, expect, it } from "vitest";
import {
  cacheReadShareOf,
  formatForAgent,
  formatShapes,
  formatTable,
  primaryOf,
  UsageScanAbortedError,
  UsageScanTimeoutError,
  type UsageReport,
} from "../../packages/shared/src/agent-usage/index.js";
import { checkScanLimits } from "../../packages/shared/src/agent-usage/errors.js";

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    turns: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolCallsByName: {},
    workIntelligenceTools: {},
    workIntelligenceOperations: {},
    workIntelligenceToolResultChars: 0,
    mcpToolResultChars: 0,
    unknownToolResultChars: 0,
    sidechainLines: 0,
    tokens: { ...ZERO_TOKENS },
    models: [],
    daily: [],
    firstTimestamp: null,
    lastTimestamp: null,
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}): UsageReport {
  return {
    sessions: [],
    total: { ...metrics(), sessions: 0 },
    skippedLines: 0,
    formats: { claudeCodeLines: 0, codexLines: 0 },
    codexTokenMismatches: 0,
    codexTokenSourceDisagreements: 0,
    codexForkedSessions: 0,
    codexIgnoredLines: 0,
    codexCompactionLinked: 0,
    codexCompactionCarryovers: 0,
    codexContextOutputs: 0,
    blocks: [],
    cache: { reused: 0, appended: 0, parsed: 0, bytesRead: 0 },
    ...overrides,
  } as unknown as UsageReport;
}

function populated(): UsageReport {
  const tokens = { input: 100, output: 20, cacheRead: 1000, cacheCreation: 10 };
  const total = {
    ...metrics({
      turns: 3,
      assistantMessages: 4,
      toolCalls: 5,
      toolCallsByName: { Read: 3, Bash: 3, Edit: 1 },
      workIntelligenceTools: { work_read: 2 },
      workIntelligenceOperations: {
        "work_read/work_a": { calls: 2, resultChars: 11 },
        "work_read/work_b": { calls: 2, resultChars: 4 },
        "work_write_additive/work_c": { calls: 0, resultChars: 0 },
        "work_read/work_d": { calls: 1, resultChars: 1 },
      },
      tokens,
      models: [
        { agent: "claude-code", model: "claude-sonnet-4-5", tokens, responses: 3 },
        { agent: "codex", model: "", tokens: { ...ZERO_TOKENS, input: 7 }, responses: 1 },
      ],
      firstTimestamp: "2026-03-01T00:00:00.000Z",
      lastTimestamp: "2026-03-01T00:00:09.000Z",
    }),
    sessions: 2,
  };
  const session = (label: string, hash: string, input: number) => ({
    ...metrics({ turns: 1, toolCalls: 2, tokens: { ...ZERO_TOKENS, input } }),
    label,
    hash,
  });
  return report({
    total,
    sessions: [session("claude", "aaaa", 1), session("codex", "bbbb", 500)],
    formats: { claudeCodeLines: 6, codexLines: 2 },
    skippedLines: 1,
  });
}

describe("primary and cache share", () => {
  it("adds only input and output to the headline", () => {
    expect(primaryOf({ input: 10, output: 2 })).toBe(12);
  });

  it("reads the cache share of input-side tokens, or null without any", () => {
    expect(cacheReadShareOf({ input: 10, output: 2, cacheRead: 100, cacheCreation: 4 })).toBeCloseTo(100 / 114);
    expect(cacheReadShareOf({ ...ZERO_TOKENS, output: 5 })).toBeNull();
  });
});

describe("formatTable", () => {
  it("prints sessions, totals, operations and the Codex notice", () => {
    const text = formatTable(populated());
    expect(text).toContain("claude/aaaa");
    expect(text).toContain("total");
    expect(text).toContain("tools: Read=3, Bash=3, Edit=1");
    expect(text).toContain("work intelligence operations: work_read/work_a=2/11, work_read/work_b=2/4");
    expect(text).toContain("codex: experimental, not verified against real logs");
  });

  it("omits optional sections for an empty report", () => {
    const text = formatTable(report());
    expect(text).not.toContain("tools:");
    expect(text).not.toContain("operations");
    expect(text).not.toContain("codex:");
    expect(text).toContain("- ");
  });
});

describe("formatShapes", () => {
  it("lists key paths with their types", () => {
    const text = formatShapes({
      shapes: [{ key: "user/-", count: 2, paths: [{ path: "message.role", types: ["string"] }] }],
      skippedLines: 3,
    } as never);
    expect(text).toContain("user/-  lines=2");
    expect(text).toContain("  message.role: string");
    expect(text).toContain("skipped lines: 3");
  });
});

describe("formatForAgent", () => {
  it("renders English text with project names and a range", () => {
    const text = formatForAgent(populated(), {
      projectNames: ["Fictional A", "Fictional B"],
      since: "2026-03-01",
      until: "2026-03-02",
    });
    expect(text).toContain("Fictional A, Fictional B");
    expect(text).toContain("2026-03-01 - 2026-03-02");
    expect(text).toContain("work_read/work_a: 2, 11, 6");
    expect(text).toContain("work_write_additive/work_c: 0, 0, 0");
    expect(text.indexOf("codex:")).toBeLessThan(text.indexOf("claude:"));
  });

  it("renders Traditional Chinese labels", () => {
    const text = formatForAgent(populated(), { locale: "zh-TW" });
    expect(text).toContain("輸入 + 輸出（不含快取）: 120");
    expect(text).toContain("快取讀取 1000");
    expect(text).toContain("快取寫入 10");
    expect(text).toContain("快取讀取占比（占全部輸入端 token）");
    expect(text).toContain("模型分布");
    expect(text).toContain("未標示模型");
    expect(text).not.toContain("估算成本");
  });

  it("puts the headline apart from the cache and lists models and conversations by input + output", () => {
    const text = formatForAgent(populated());
    expect(text).toContain("input + output (excl. cache): 120");
    expect(text).toContain("cache read 1000, cache write 10, cache read share (of all input-side tokens) 90.1%");
    expect(text).toContain("claude-code / claude-sonnet-4-5: input + output (excl. cache) 120, cache read 1000");
    expect(text).toContain("codex / unlabelled model: input + output (excl. cache) 7, cache read 0");
    expect(text).not.toMatch(/cost|multiplier/i);
    expect(text.indexOf("codex:")).toBeLessThan(text.indexOf("claude:"));
  });

  it("formatTable adds a primary column and a models block", () => {
    const text = formatTable(populated());
    expect(text).toContain("primary");
    expect(text).toContain("claude-code claude-sonnet-4-5: 120, 1000, 10, 3");
    expect(text).toContain("codex (unlabelled): 7, 0, 0, 1");
    expect(text).not.toMatch(/cost/i);
  });

  it("prints placeholders when there is nothing to list", () => {
    const text = formatForAgent(report());
    expect(text).toContain("0.0%");
    expect(text.match(/ {2}none/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("scan limits", () => {
  it("throws for an aborted signal and a passed deadline, and passes otherwise", () => {
    const controller = new AbortController();
    expect(() => checkScanLimits(controller.signal, Date.now() + 60_000)).not.toThrow();
    expect(() => checkScanLimits(undefined, undefined)).not.toThrow();
    expect(() => checkScanLimits(undefined, Date.now() - 1)).toThrow(UsageScanTimeoutError);
    controller.abort();
    expect(() => checkScanLimits(controller.signal, undefined)).toThrow(UsageScanAbortedError);
  });
});
