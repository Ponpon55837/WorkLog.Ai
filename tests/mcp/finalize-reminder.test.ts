import { describe, expect, it } from "vitest";
import {
  findTrackedRoot,
  REMINDER,
  reminderFor,
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
const FINALIZE = "mcp__work-intelligence__work_finalize_session";

function deps(transcript: string[], roots = ["/Users/me/apiary"]): ReminderDeps & { marked: string[] } {
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

const input = { session_id: "s1", transcript_path: "/t.jsonl", cwd: "/Users/me/apiary/src" };

describe("finalize reminder hook", () => {
  it("reminds once when files changed after the last save in a tracked project", () => {
    const d = deps([
      tool("Read"),
      tool(FINALIZE),
      text("more work"),
      toolWithInput("Edit", { file_path: "/Users/me/apiary/src/index.ts" }),
    ]);
    expect(reminderFor(input, d)).toBe(REMINDER);
    expect(reminderFor(input, d)).toBeNull();
  });

  it("reminds again for a new stretch of work after the next save", () => {
    const transcript = [toolWithInput("Write", { file_path: "/Users/me/apiary/src/new.ts" })];
    const d = deps(transcript);
    expect(reminderFor(input, d)).toBe(REMINDER);
    transcript.push(tool(FINALIZE), toolWithInput("Edit", { file_path: "/Users/me/apiary/src/new.ts" }));
    expect(reminderFor(input, d)).toBe(REMINDER);
  });

  it("stays quiet when saved, nothing changed, untracked, or already continuing from a reminder", () => {
    expect(
      reminderFor(input, deps([toolWithInput("Edit", { file_path: "/Users/me/apiary/src/index.ts" }), tool(FINALIZE)])),
    ).toBeNull();
    expect(reminderFor(input, deps([tool("Read"), tool("Bash")]))).toBeNull();
    expect(
      reminderFor(
        { ...input, cwd: "/Users/me/apiary-tools" },
        deps([toolWithInput("Edit", { file_path: "/Users/me/apiary-tools/index.ts" })]),
      ),
    ).toBeNull();
    expect(
      reminderFor(
        { ...input, stop_hook_active: true },
        deps([toolWithInput("Edit", { file_path: "/Users/me/apiary/src/index.ts" })]),
      ),
    ).toBeNull();
    expect(
      reminderFor(
        { cwd: "/Users/me/apiary" },
        deps([toolWithInput("Edit", { file_path: "/Users/me/apiary/index.ts" })]),
      ),
    ).toBeNull();
  });

  it("ignores edits outside tracked roots but still reminds when any edited file is inside", () => {
    const outside = deps([toolWithInput("Edit", { file_path: "/Users/me/.claude/memory.md" })]);
    expect(reminderFor(input, outside)).toBeNull();
    expect(outside.marked).toEqual([]);

    const mixed = deps([
      toolWithInput("Edit", { file_path: "/Users/me/.claude/memory.md" }),
      toolWithInput("Write", { file_path: "/Users/me/apiary/src/index.ts" }),
    ]);
    expect(reminderFor(input, mixed)).toBe(REMINDER);
  });

  it("uses NotebookEdit notebook_path and fails open when an edit path is unavailable", () => {
    expect(
      reminderFor(input, deps([toolWithInput("NotebookEdit", { notebook_path: "/Users/me/apiary/analysis.ipynb" })])),
    ).toBe(REMINDER);
    const missingPath = deps([tool("Edit")]);
    expect(reminderFor(input, missingPath)).toBeNull();
    expect(missingPath.marked).toEqual([]);
  });

  it("ignores malformed transcript lines", () => {
    expect(
      summarizeTranscript(
        `not json\n${toolWithInput("Edit", { file_path: "/Users/me/apiary/src/index.ts" })}\n{"type":"user"}`,
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
