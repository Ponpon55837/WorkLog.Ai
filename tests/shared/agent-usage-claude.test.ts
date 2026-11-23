import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeFiles } from "../../packages/shared/src/agent-usage/index.js";

const SESSION = "11111111-2222-4333-8444-555555555555";
const stamp = (second: number) => new Date(Date.UTC(2026, 2, 1, 0, 0, second)).toISOString();

let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "usage-claude-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("Claude Code tool results and turns", () => {
  it("counts text blocks of array tool_result content and skips other blocks", async () => {
    const lines = [
      {
        type: "assistant",
        sessionId: SESSION,
        timestamp: stamp(1),
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "mcp__wi__work_read", input: { operation: "work_get_note" } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "user",
        sessionId: SESSION,
        timestamp: stamp(2),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "abcde" }, { type: "image" }, { type: "text", text: 7 }, "raw"],
            },
          ],
        },
      },
      {
        type: "user",
        sessionId: SESSION,
        timestamp: stamp(3),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: { not: "text" } }] },
      },
      // Text next to a tool_result is not a human prompt.
      {
        type: "user",
        sessionId: SESSION,
        timestamp: stamp(4),
        message: {
          role: "user",
          content: [
            { type: "text", text: "x" },
            { type: "tool_result", tool_use_id: "t3", content: "y" },
          ],
        },
      },
      // A plain text block counts as one turn, a meta line and a sidechain prompt do not.
      {
        type: "user",
        sessionId: SESSION,
        timestamp: stamp(5),
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "user",
        sessionId: SESSION,
        timestamp: stamp(6),
        isMeta: true,
        message: { role: "user", content: "meta" },
      },
      {
        type: "user",
        sessionId: SESSION,
        timestamp: stamp(7),
        isSidechain: true,
        message: { role: "user", content: "sub" },
      },
      { type: "user", sessionId: SESSION, timestamp: stamp(8), message: { role: "user", content: 42 } },
      "not an object",
    ];
    const file = join(base, "results.jsonl");
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const report = await summarizeFiles([file]);
    expect(report.total.turns).toBe(1);
    expect(report.total.workIntelligenceToolResultChars).toBe(5);
    expect(report.total.mcpToolResultChars).toBe(5);
    expect(report.total.unknownToolResultChars).toBe(1);
    expect(report.total.sidechainLines).toBe(1);
    expect(report.skippedLines).toBe(1);
  });
});
