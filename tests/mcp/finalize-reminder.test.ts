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
    const d = deps([tool("Read"), tool(FINALIZE), text("more work"), tool("Edit")]);
    expect(reminderFor(input, d)).toBe(REMINDER);
    expect(reminderFor(input, d)).toBeNull();
  });

  it("reminds again for a new stretch of work after the next save", () => {
    const transcript = [tool("Write")];
    const d = deps(transcript);
    expect(reminderFor(input, d)).toBe(REMINDER);
    transcript.push(tool(FINALIZE), tool("Edit"));
    expect(reminderFor(input, d)).toBe(REMINDER);
  });

  it("stays quiet when saved, nothing changed, untracked, or already continuing from a reminder", () => {
    expect(reminderFor(input, deps([tool("Edit"), tool(FINALIZE)]))).toBeNull();
    expect(reminderFor(input, deps([tool("Read"), tool("Bash")]))).toBeNull();
    expect(reminderFor({ ...input, cwd: "/Users/me/apiary-tools" }, deps([tool("Edit")]))).toBeNull();
    expect(reminderFor({ ...input, stop_hook_active: true }, deps([tool("Edit")]))).toBeNull();
    expect(reminderFor({ cwd: "/Users/me/apiary" }, deps([tool("Edit")]))).toBeNull();
  });

  it("ignores malformed transcript lines", () => {
    expect(summarizeTranscript(`not json\n${tool("Edit")}\n{"type":"user"}`)).toEqual({
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
