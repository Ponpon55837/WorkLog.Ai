import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  findTrackedRoot,
  REMINDER,
  reminderFor,
  reminderWithStart,
  summarizeTranscript,
  type ReminderDeps,
} from "../../apps/mcp/src/finalize-reminder.js";

// Fictional transcript lines in Claude Code's format.
const tool = (name: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name }] } });
const toolWithInput = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const text = (value: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: value }] } });
const typed = (value: string, timestamp: string) =>
  JSON.stringify({ type: "user", timestamp, message: { content: value } });
const toolResult = (timestamp: string) =>
  JSON.stringify({ type: "user", timestamp, message: { content: [{ type: "tool_result", content: "ok" }] } });
const FINALIZE = "mcp__work-intelligence__work_finalize_session";
const PROJECT_ROOT = resolve("Users", "me", "apiary");
const PROJECT_SRC = join(PROJECT_ROOT, "src");
const EXTERNAL_MEMORY = resolve("Users", "me", ".claude", "memory.md");

function deps(transcript: string[], roots = [PROJECT_ROOT]): ReminderDeps & { marked: string[] } {
  const marked: string[] = [];
  return {
    marked,
    readTranscript: () => transcript.join("\n"),
    trackedRoots: () => roots,
    realpath: (path) => path,
    markOnce: (key) => {
      if (marked.includes(key)) {
        return false;
      }
      marked.push(key);
      return true;
    },
  };
}

const input = { session_id: "s1", transcript_path: "/t.jsonl", cwd: PROJECT_SRC };

describe("finalize reminder hook", () => {
  it("reports when the current segment began: the first typed message after the last save", () => {
    const d = deps([
      typed("first task", "2026-09-27T00:10:00.000Z"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
      tool(FINALIZE),
      toolResult("2026-09-27T00:20:00.000Z"),
      typed("second task", "2026-09-27T00:33:14.278Z"),
      typed("a follow-up in the same segment", "2026-09-27T00:40:00.000Z"),
      toolWithInput("Write", { file_path: join(PROJECT_SRC, "queen.ts") }),
    ]);
    expect(summarizeTranscript(d.readTranscript("")).segmentStartedAt).toBe("2026-09-27T00:33:14.278Z");
    const reminder = reminderFor(input, d);
    expect(reminder).toBe(reminderWithStart("2026-09-27T00:33:14.278Z"));
    expect(reminder).toContain("2026-09-27T00:33:14.278Z");
    expect(reminder).toContain("startedAt");
  });

  it("falls back to the plain reminder when no typed message has a usable timestamp", () => {
    const d = deps([
      toolResult("2026-09-27T00:20:00.000Z"),
      JSON.stringify({
        type: "user",
        isMeta: true,
        timestamp: "2026-09-27T00:21:00.000Z",
        message: { content: "meta" },
      }),
      typed("no timestamp", "not a date"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
    ]);
    expect(summarizeTranscript(d.readTranscript("")).segmentStartedAt).toBeUndefined();
    expect(reminderFor(input, d)).toBe(REMINDER);
  });

  it("reminds once when files changed after the last save in a tracked project", () => {
    const d = deps([
      tool("Read"),
      tool(FINALIZE),
      text("more work"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "index.ts") }),
    ]);
    expect(reminderFor(input, d)).toBe(REMINDER);
    expect(reminderFor(input, d)).toBeNull();
  });

  it("reminds again for a new stretch of work after the next save", () => {
    const transcript = [toolWithInput("Write", { file_path: join(PROJECT_SRC, "new.ts") })];
    const d = deps(transcript);
    expect(reminderFor(input, d)).toBe(REMINDER);
    transcript.push(tool(FINALIZE), toolWithInput("Edit", { file_path: join(PROJECT_SRC, "new.ts") }));
    expect(reminderFor(input, d)).toBe(REMINDER);
  });

  it("stays quiet when saved, nothing changed, untracked, or already continuing from a reminder", () => {
    expect(
      reminderFor(input, deps([toolWithInput("Edit", { file_path: join(PROJECT_SRC, "index.ts") }), tool(FINALIZE)])),
    ).toBeNull();
    expect(reminderFor(input, deps([tool("Read"), tool("Bash")]))).toBeNull();
    expect(
      reminderFor(
        { ...input, cwd: resolve("Users", "me", "apiary-tools") },
        deps([toolWithInput("Edit", { file_path: resolve("Users", "me", "apiary-tools", "index.ts") })]),
      ),
    ).toBeNull();
    expect(
      reminderFor(
        { ...input, stop_hook_active: true },
        deps([toolWithInput("Edit", { file_path: join(PROJECT_SRC, "index.ts") })]),
      ),
    ).toBeNull();
    expect(
      reminderFor({ cwd: PROJECT_ROOT }, deps([toolWithInput("Edit", { file_path: join(PROJECT_ROOT, "index.ts") })])),
    ).toBeNull();
  });

  it("ignores edits outside tracked roots but still reminds when any edited file is inside", () => {
    const outside = deps([toolWithInput("Edit", { file_path: EXTERNAL_MEMORY })]);
    expect(reminderFor(input, outside)).toBeNull();
    expect(outside.marked).toEqual([]);

    const mixed = deps([
      toolWithInput("Edit", { file_path: EXTERNAL_MEMORY }),
      toolWithInput("Write", { file_path: join(PROJECT_SRC, "index.ts") }),
    ]);
    expect(reminderFor(input, mixed)).toBe(REMINDER);
  });

  it("uses NotebookEdit notebook_path and fails open when an edit path is unavailable", () => {
    expect(
      reminderFor(
        input,
        deps([toolWithInput("NotebookEdit", { notebook_path: join(PROJECT_ROOT, "analysis.ipynb") })]),
      ),
    ).toBe(REMINDER);
    const missingPath = deps([tool("Edit")]);
    expect(reminderFor(input, missingPath)).toBeNull();
    expect(missingPath.marked).toEqual([]);
  });

  it("ignores malformed transcript lines", () => {
    expect(
      summarizeTranscript(
        `not json\n${toolWithInput("Edit", { file_path: join(PROJECT_SRC, "index.ts") })}\n{"type":"user"}`,
      ),
    ).toEqual({
      lastEdit: 1,
      lastFinalize: -1,
    });
  });

  it("matches project roots on whole path segments, case-insensitively on Windows", () => {
    expect(findTrackedRoot("/Users/me/apiary", ["/Users/me/apiary/"])).toBe("/Users/me/apiary/");
    expect(findTrackedRoot("/Users/me/apiary2", ["/Users/me/apiary"])).toBeNull();
    expect(findTrackedRoot("c:\\users\\me\\apiary\\src", ["C:\\Users\\Me\\apiary"], "win32")).toBe(
      "C:\\Users\\Me\\apiary",
    );
    expect(findTrackedRoot("c:\\users\\me\\apiary", ["C:\\Users\\Me\\apiary"], "linux")).toBeNull();
  });
});
