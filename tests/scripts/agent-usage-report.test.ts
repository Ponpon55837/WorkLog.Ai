import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeFiles } from "../../scripts/agent-usage-report.mjs";

const SECRET = "FICTIONAL-SECRET-CONTENT-123";
const FAKE_PATH = "/home/fictional/project-x";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const SCRIPT = join(__dirname, "..", "..", "scripts", "agent-usage-report.mjs");

let root = "";
let mainFile = "";

function assistant(id: string, timestamp: string, content: unknown[], usage: Record<string, number>, extra = {}) {
  return {
    type: "assistant",
    sessionId: SESSION_ID,
    timestamp,
    cwd: FAKE_PATH,
    gitBranch: "fictional-branch",
    message: { id, model: "fictional-model", role: "assistant", content, usage },
    ...extra,
  };
}

function user(timestamp: string, content: unknown) {
  return { type: "user", sessionId: SESSION_ID, timestamp, cwd: FAKE_PATH, message: { role: "user", content } };
}

const toolUse = (id: string, name: string) => ({
  type: "tool_use",
  id,
  name,
  input: { file_path: `${FAKE_PATH}/a.ts`, note: SECRET },
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "usage-report-"));
  const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 };
  const lines = [
    user("2026-01-01T00:00:00Z", `${SECRET} ${FAKE_PATH}`),
    // Same message id over three streamed lines: usage counts once, output takes the max.
    assistant("msg_1", "2026-01-01T00:00:01Z", [{ type: "text", text: SECRET }], { ...usage, output_tokens: 1 }),
    assistant("msg_1", "2026-01-01T00:00:01Z", [toolUse("tu_1", "Read")], { ...usage, output_tokens: 20 }),
    assistant("msg_1", "2026-01-01T00:00:01Z", [toolUse("tu_2", "mcp__wi__work_search_memory")], {
      ...usage,
      output_tokens: 20,
    }),
    // tool_use repeated on a later line is not counted twice.
    assistant(
      "msg_2",
      "2026-01-01T00:00:02Z",
      [toolUse("tu_2", "mcp__wi__work_search_memory"), toolUse("tu_3", "mcp__other__lookup")],
      {
        input_tokens: 1,
        output_tokens: 2,
      },
    ),
    assistant(
      "msg_3",
      "2026-01-01T00:00:03Z",
      [toolUse("tu_4", "bad name/with slash")],
      { output_tokens: 3 },
      { isSidechain: true },
    ),
    user("2026-01-01T00:00:04Z", [
      { type: "tool_result", tool_use_id: "tu_2", content: "x".repeat(40), is_error: false },
      { type: "tool_result", tool_use_id: "tu_3", content: [{ type: "text", text: "y".repeat(7) }, { type: "image" }] },
      { type: "tool_result", tool_use_id: "tu_1", content: "z".repeat(1000) },
      { type: "tool_result", tool_use_id: "tu_missing", content: "q".repeat(9) },
    ]),
    user("2026-01-02T00:00:00Z", "second prompt"),
    { type: "attachment", sessionId: SESSION_ID, message: { content: SECRET } },
    "{ not json",
  ];
  mainFile = join(root, "main.jsonl");
  writeFileSync(mainFile, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
  mkdirSync(join(root, "nested", "deeper"), { recursive: true });
  writeFileSync(
    join(root, "nested", "deeper", "other.jsonl"),
    JSON.stringify({ ...user("2026-01-03T00:00:00Z", "hello"), sessionId: "other-session" }),
  );
  writeFileSync(join(root, "nested", "ignored.txt"), JSON.stringify(user("2026-01-03T00:00:00Z", "no")));
  writeFileSync(
    join(root, "codex.jsonl"),
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { cwd: FAKE_PATH } }),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("summarizeFiles", () => {
  it("dedups usage by message id and tool_use by id", async () => {
    const report = await summarizeFiles([mainFile]);
    expect(report.sessions).toHaveLength(1);
    const [session] = report.sessions;
    expect(session.assistantMessages).toBe(3);
    expect(session.tokens).toEqual({ input: 11, output: 25, cacheRead: 100, cacheCreation: 5 });
    expect(session.toolCalls).toBe(5);
    expect(session.turns).toBe(2);
    expect(session.sidechainLines).toBe(1);
    expect(report.skippedLines).toBe(1);
  });

  it("groups tools and splits Work Intelligence tools", async () => {
    const { total } = await summarizeFiles([mainFile]);
    expect(total.workIntelligenceTools).toEqual({ work_search_memory: 1 });
    expect(total.toolCallsByName).toEqual({ Read: 1, mcp__other__lookup: 1, "(other)": 1 });
  });

  it("sums MCP tool_result characters", async () => {
    const { total } = await summarizeFiles([mainFile]);
    expect(total.workIntelligenceToolResultChars).toBe(40);
    expect(total.mcpToolResultChars).toBe(47);
    expect(total.unknownToolResultChars).toBe(9);
  });

  it("filters by time range and excludes lines without a timestamp", async () => {
    const report = await summarizeFiles([mainFile], { since: "2026-01-01T00:00:02Z", until: "2026-01-01T00:00:03Z" });
    expect(report.total.assistantMessages).toBe(2);
    expect(report.total.turns).toBe(0);
    expect(report.sessions[0].firstTimestamp).toBe("2026-01-01T00:00:02.000Z");
    await expect(summarizeFiles([mainFile], { since: "nope" })).rejects.toThrow();
  });

  it("recurses into directories and counts unsupported Codex lines", async () => {
    const report = await summarizeFiles([root]);
    expect(report.sessions).toHaveLength(2);
    expect(report.total.turns).toBe(3);
    expect(report.unsupportedLines).toBe(1);
  });
});

describe("CLI output", () => {
  it.each([[["--json"]], [[]]])("never prints content, paths or raw session ids (%j)", (flags) => {
    const output = execFileSync("node", [SCRIPT, ...flags, root], { encoding: "utf8" });
    for (const forbidden of [SECRET, FAKE_PATH, "project-x", "fictional-branch", SESSION_ID, "other-session", root]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain("session-1");
  });

  it("emits a parsable report with --json and usage with --help", () => {
    const parsed = JSON.parse(execFileSync("node", [SCRIPT, "--json", mainFile], { encoding: "utf8" }));
    expect(parsed.format).toBe("claude-code");
    expect(parsed.skippedLines).toBe(1);
    expect(execFileSync("node", [SCRIPT, "--help"], { encoding: "utf8" })).toContain("Usage:");
  });
});
