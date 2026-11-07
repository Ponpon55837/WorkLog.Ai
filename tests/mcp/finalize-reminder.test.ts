import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  compactedSessionReminder,
  findTrackedRoot,
  REMINDER,
  reminderFor,
  reminderWithStart,
  responseForClaudeHook,
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
const FINALIZE_DISPATCHER = "mcp__work-intelligence__work_write_idempotent";
const finalizeCall = (id: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: FINALIZE }] } });
const finalizeDispatcherCall = (id: string, operation = "work_finalize_session") =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: FINALIZE_DISPATCHER,
          input: { operation, arguments: {} },
        },
      ],
    },
  });
const finalizeResult = (id: string, content: unknown, isError = false) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  });
const saved = JSON.stringify({ outcome: "finalized", duplicate: false, session: { id: "session-1" } });
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
// What Claude Code appends when it compacts: earlier entries stay in the file, followed by a boundary and a summary.
const compactBoundary = JSON.stringify({
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
  timestamp: "2026-09-27T01:00:00.000Z",
  compactMetadata: { trigger: "auto", preTokens: 160000 },
});
const compactSummary = JSON.stringify({
  type: "user",
  isCompactSummary: true,
  isVisibleInTranscriptOnly: true,
  timestamp: "2026-09-27T01:00:01.000Z",
  message: { role: "user", content: "This session is being continued from a previous conversation…" },
});
const hookEvent = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...input, hook_event_name, ...extra });

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

  it("counts a save only when its result succeeded, so a rejected save keeps the segment open", () => {
    const d = deps([
      typed("task", "2026-09-27T01:00:00.000Z"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
      finalizeCall("rejected"),
      finalizeResult("rejected", JSON.stringify({ error: "Invalid finalize payload." }), true),
      finalizeCall("conflict"),
      finalizeResult("conflict", JSON.stringify({ outcome: "idempotency_conflict" })),
      typed("while retrying", "2026-09-27T01:30:00.000Z"),
    ]);
    const summary = summarizeTranscript(d.readTranscript(""));
    expect(summary.lastFinalize).toBe(-1);
    expect(summary.segmentStartedAt).toBe("2026-09-27T01:00:00.000Z");
    expect(reminderFor(input, d)).toBe(reminderWithStart("2026-09-27T01:00:00.000Z"));
  });

  it("starts a new segment after a successful save, with text-block results too", () => {
    const d = deps([
      typed("first", "2026-09-27T01:00:00.000Z"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
      finalizeCall("ok"),
      finalizeResult("ok", [{ type: "text", text: saved }]),
      typed("second", "2026-09-27T02:00:00.000Z"),
    ]);
    const summary = summarizeTranscript(d.readTranscript(""));
    expect(summary.lastFinalize).toBeGreaterThan(-1);
    expect(summary.segmentStartedAt).toBe("2026-09-27T02:00:00.000Z");
    // Nothing edited since the save: no reminder.
    expect(reminderFor(input, d)).toBeNull();
  });

  it("recognizes finalize routed through the idempotent-write dispatcher and only closes the segment on success", () => {
    const d = deps([
      typed("first", "2026-09-27T01:00:00.000Z"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
      finalizeDispatcherCall("wrong-operation", "work_update_session_summary"),
      finalizeResult("wrong-operation", [{ type: "text", text: saved }]),
      finalizeDispatcherCall("failed-dispatch"),
      finalizeResult("failed-dispatch", JSON.stringify({ error: "Invalid finalize payload." }), true),
      finalizeDispatcherCall("saved-dispatch"),
      finalizeResult("saved-dispatch", [{ type: "text", text: saved }]),
      typed("second", "2026-09-27T02:00:00.000Z"),
    ]);
    const summary = summarizeTranscript(d.readTranscript(""));
    expect(summary.lastFinalize).toBeGreaterThan(-1);
    expect(summary.segmentStartedAt).toBe("2026-09-27T02:00:00.000Z");
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
      editedFiles: [],
    });
  });

  it("asks the compaction summary to keep the start time and changed files, without blocking or marking", () => {
    const d = deps([
      typed("task", "2026-09-27T00:10:00.000Z"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
      toolWithInput("Write", { file_path: "../README.md" }),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
      toolWithInput("Edit", { file_path: EXTERNAL_MEMORY }),
    ]);
    const output = responseForClaudeHook(hookEvent("PreCompact", { trigger: "auto", custom_instructions: null }), d);
    expect(output).toBe(
      "摘要請保留：這段工作尚未保存 Work Intelligence 工作記錄；開始時間 2026-09-27T00:10:00.000Z；在記錄中專案改過的檔案：src/hive.ts、README.md。完成後要依 work-intelligence skill 保存。",
    );
    // Plain text, never a block decision: blocking would skip or fail the compaction.
    expect(output).not.toContain("decision");
    expect(d.marked).toEqual([]);
    expect(responseForClaudeHook(hookEvent("PreCompact", { trigger: "manual" }), d)).toBe(output);
    // The Stop reminder still fires once after compaction notes were written.
    expect(responseForClaudeHook(hookEvent("Stop"), d)).toContain('"decision":"block"');
  });

  it("restores the unsaved reminder after a compaction, counting work before the compact boundary", () => {
    const d = deps([
      typed("task", "2026-09-27T00:10:00.000Z"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
      compactBoundary,
      compactSummary,
    ]);
    const output = responseForClaudeHook(hookEvent("SessionStart", { source: "compact" }), d);
    const additionalContext = compactedSessionReminder("2026-09-27T00:10:00.000Z", ["src/hive.ts"]);
    expect(output).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
    expect(additionalContext).toContain("startedAt");
    expect(additionalContext).toContain("src/hive.ts");
    expect(d.marked).toEqual([]);
    for (const source of ["startup", "resume", "clear"]) {
      expect(responseForClaudeHook(hookEvent("SessionStart", { source }), d)).toBeNull();
    }
  });

  it("does not treat the compaction summary as the first message of a new segment", () => {
    const d = deps([
      typed("task", "2026-09-27T00:10:00.000Z"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
      finalizeCall("save-1"),
      finalizeResult("save-1", saved),
      compactBoundary,
      compactSummary,
      typed("next task", "2026-09-27T01:05:00.000Z"),
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "queen.ts") }),
    ]);
    expect(responseForClaudeHook(hookEvent("PreCompact"), d)).toBe(
      "摘要請保留：這段工作尚未保存 Work Intelligence 工作記錄；開始時間 2026-09-27T01:05:00.000Z；在記錄中專案改過的檔案：src/queen.ts。完成後要依 work-intelligence skill 保存。",
    );
  });

  it("stays silent at compaction when the work was saved, nothing changed, or the project is untracked", () => {
    const savedWork = deps([
      toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") }),
      finalizeCall("save-1"),
      finalizeResult("save-1", saved),
      compactBoundary,
      compactSummary,
    ]);
    const noEdits = deps([typed("question", "2026-09-27T00:10:00.000Z"), text("answer")]);
    const untracked = deps([toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") })], []);
    for (const d of [savedWork, noEdits, untracked]) {
      expect(responseForClaudeHook(hookEvent("PreCompact"), d)).toBeNull();
      expect(responseForClaudeHook(hookEvent("SessionStart", { source: "compact" }), d)).toBeNull();
    }
    const unreadable = {
      ...deps([]),
      readTranscript: () => {
        throw new Error("EACCES");
      },
    };
    expect(responseForClaudeHook(hookEvent("PreCompact"), unreadable)).toBeNull();
    expect(responseForClaudeHook("not json", unreadable)).toBeNull();
    expect(responseForClaudeHook(hookEvent("Notification"), unreadable)).toBeNull();
  });

  it("lists at most 30 changed files, strips control characters, and stays far below the 10,000-character cap", () => {
    const lines = [typed("task", "2026-09-27T00:10:00.000Z")];
    for (let index = 0; index < 45; index += 1) {
      lines.push(toolWithInput("Write", { file_path: join(PROJECT_SRC, `${"deep/".repeat(60)}file-${index}.ts`) }));
    }
    lines.push(toolWithInput("Write", { file_path: join(PROJECT_SRC, "evil\u202e\u0007name\n.ts") }));
    const output = responseForClaudeHook(hookEvent("PreCompact"), deps(lines)) ?? "";
    expect(output).toContain("等 46 個");
    expect(output.match(/file-\d+\.ts/g)).toHaveLength(30);
    expect(output.length).toBeLessThanOrEqual(8_000);
    expect(output).not.toContain(PROJECT_ROOT);
    expect([...output].some((char) => char.charCodeAt(0) < 0x20 || char === "\u202e")).toBe(false);

    const evil = responseForClaudeHook(
      hookEvent("PreCompact"),
      deps([toolWithInput("Write", { file_path: join(PROJECT_SRC, "evil\u202e\u0007name\n.ts") })]),
    );
    expect(evil).toContain("src/evilname.ts");
  });

  it("keeps the Stop output shape for Stop events and for inputs without an event name", () => {
    const transcript = [toolWithInput("Edit", { file_path: join(PROJECT_SRC, "hive.ts") })];
    const expected = JSON.stringify({
      decision: "block",
      reason: REMINDER,
      hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason: REMINDER },
    });
    expect(responseForClaudeHook(hookEvent("Stop"), deps(transcript))).toBe(expected);
    expect(responseForClaudeHook(JSON.stringify(input), deps(transcript))).toBe(expected);
    expect(responseForClaudeHook(hookEvent("Stop", { stop_hook_active: true }), deps(transcript))).toBeNull();
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
