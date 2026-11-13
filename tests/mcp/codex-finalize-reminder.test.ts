import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseApplyPatchFilePaths,
  responseForCodexHook,
  type CodexReminderDeps,
} from "../../apps/mcp/src/codex-finalize-reminder.js";
import {
  compactedSessionReminder,
  isFileInTrackedRoots,
  missingStartedAtReason,
  REMINDER,
  reminderWithStart,
} from "../../apps/mcp/src/finalize-reminder.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const trackedCwd = join(repoRoot, "apps/mcp");
const finalizeTool = "mcp__work-intelligence__work_finalize_session";
const finalizeDispatcher = "mcp__work-intelligence__work_write_idempotent";
const finalizeDispatcherInput = { operation: "work_finalize_session", arguments: {} };

function createDeps(tracked = true, now = () => new Date("2026-09-27T01:00:00.000Z")) {
  const markers = new Set<string>();
  const contents = new Map<string, string>();
  const roots = tracked ? [repoRoot] : [];
  const deps: CodexReminderDeps = {
    isTrackedWorkspace: () => tracked,
    hasTrackedFiles: (cwd, filePaths) =>
      filePaths.some((filePath) => isFileInTrackedRoots(filePath, cwd, roots, (path) => path)),
    markerPaths: (sessionId) => ({
      dirty: `${sessionId}.dirty`,
      reminded: `${sessionId}.reminded`,
      segment: `${sessionId}.segment`,
      preDenied: `${sessionId}.pre-denied`,
    }),
    markerExists: (path) => markers.has(path),
    createMarker: (path) => {
      if (markers.has(path)) {
        return false;
      }
      markers.add(path);
      return true;
    },
    writeMarker: (path, content) => {
      if (markers.has(path)) {
        return false;
      }
      markers.add(path);
      contents.set(path, content);
      return true;
    },
    readMarker: (path) => contents.get(path),
    removeMarker: (path) => {
      contents.delete(path);
      return markers.delete(path);
    },
    now,
  };
  return { deps, markers };
}

function patch(...headers: string[]) {
  return { command: `*** Begin Patch\n${headers.join("\n")}\n*** End Patch` };
}

function postToolEvent(toolName: string, toolResponse?: unknown, toolInput?: unknown) {
  return JSON.stringify({
    session_id: "session-1",
    cwd: trackedCwd,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    ...(toolInput === undefined && toolName === "apply_patch"
      ? { tool_input: patch("*** Update File: ../../README.md") }
      : toolInput === undefined
        ? {}
        : { tool_input: toolInput }),
    tool_response: toolResponse,
  });
}

function sessionStartEvent(source: string) {
  return JSON.stringify({ session_id: "session-1", cwd: trackedCwd, hook_event_name: "SessionStart", source });
}

function stopEvent() {
  return JSON.stringify({ session_id: "session-1", cwd: trackedCwd, hook_event_name: "Stop" });
}

describe("Codex finalize reminder hook", () => {
  it("records when the segment began from the first prompt after a save and adds it to the reminder", () => {
    let clock = new Date("2026-09-27T01:00:00.000Z");
    const { deps } = createDeps(true, () => clock);
    const prompt = () =>
      responseForCodexHook(
        JSON.stringify({ session_id: "session-1", cwd: trackedCwd, hook_event_name: "UserPromptSubmit" }),
        deps,
      );

    // The first prompt of a segment tells the Agent the start before it saves; a follow-up stays silent.
    expect(prompt()).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext:
            "這個專案有在 Work Intelligence 記錄。這段工作的開始時間是 2026-09-27T01:00:00.000Z；之後保存工作記錄時請把 startedAt 設為 2026-09-27T01:00:00.000Z，completedAt 省略。",
        },
      }),
    );
    clock = new Date("2026-09-27T01:20:00.000Z");
    expect(prompt()).toBeNull(); // A follow-up in the same segment keeps the first time.
    responseForCodexHook(postToolEvent("apply_patch"), deps);
    expect(responseForCodexHook(stopEvent(), deps)).toBe(
      JSON.stringify({ decision: "block", reason: reminderWithStart("2026-09-27T01:00:00.000Z") }),
    );

    const saved = { content: [{ type: "text", text: JSON.stringify({ outcome: "finalized", session: { id: "s" } }) }] };
    responseForCodexHook(postToolEvent(finalizeDispatcher, saved, finalizeDispatcherInput), deps);
    clock = new Date("2026-09-27T02:00:00.000Z");
    prompt();
    responseForCodexHook(postToolEvent("apply_patch"), deps);
    expect(responseForCodexHook(stopEvent(), deps)).toBe(
      JSON.stringify({ decision: "block", reason: reminderWithStart("2026-09-27T02:00:00.000Z") }),
    );
  });

  it("pauses a finalize without startedAt once per segment, then lets it through", () => {
    const { deps, markers } = createDeps(true);
    const prompt = JSON.stringify({ session_id: "session-1", cwd: trackedCwd, hook_event_name: "UserPromptSubmit" });
    const preTool = (toolName: string, toolInput: unknown) =>
      responseForCodexHook(
        JSON.stringify({
          session_id: "session-1",
          cwd: trackedCwd,
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolInput,
        }),
        deps,
      );

    // No recorded start yet: nothing to offer, so nothing is paused.
    expect(preTool(finalizeTool, {})).toBeNull();
    responseForCodexHook(prompt, deps);
    expect(preTool("mcp__other__tool", {})).toBeNull();
    expect(preTool(finalizeTool, { startedAt: "2026-09-27T00:30:00.000Z" })).toBeNull();
    expect(
      preTool(finalizeDispatcher, { operation: "work_finalize_session", arguments: { completedAt: "x" } }),
    ).toBeNull();

    const denial = preTool(finalizeDispatcher, finalizeDispatcherInput);
    expect(JSON.parse(denial ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: missingStartedAtReason("2026-09-27T01:00:00.000Z"),
      },
    });
    expect(preTool(finalizeDispatcher, finalizeDispatcherInput)).toBeNull();

    const saved = { content: [{ type: "text", text: JSON.stringify({ outcome: "finalized", session: { id: "s" } }) }] };
    responseForCodexHook(postToolEvent(finalizeDispatcher, saved, finalizeDispatcherInput), deps);
    expect(markers.has("session-1.pre-denied")).toBe(false);
  });

  it("words its one pause to ask for change statuses when changedFiles come without them", () => {
    const preTool = (toolInput: unknown) => {
      const { deps } = createDeps(true);
      responseForCodexHook(
        JSON.stringify({ session_id: "session-1", cwd: trackedCwd, hook_event_name: "UserPromptSubmit" }),
        deps,
      );
      return responseForCodexHook(
        JSON.stringify({
          session_id: "session-1",
          cwd: trackedCwd,
          hook_event_name: "PreToolUse",
          tool_name: finalizeDispatcher,
          tool_input: toolInput,
        }),
        deps,
      );
    };
    const reason = (value: string | null) =>
      (JSON.parse(value ?? "null") as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput
        .permissionDecisionReason;

    expect(reason(preTool({ operation: "work_finalize_session", arguments: { changedFiles: ["src/a.ts"] } }))).toBe(
      missingStartedAtReason("2026-09-27T01:00:00.000Z", true),
    );
    expect(reason(preTool(finalizeDispatcherInput))).toBe(missingStartedAtReason("2026-09-27T01:00:00.000Z"));
    expect(
      reason(
        preTool({
          operation: "work_finalize_session",
          arguments: { changedFiles: ["src/a.ts"], changedFileChanges: [{ path: "src/a.ts", status: "added" }] },
        }),
      ),
    ).toBe(missingStartedAtReason("2026-09-27T01:00:00.000Z"));
  });

  it("keeps the segment open when a save fails, and ignores prompts outside tracked projects", () => {
    const { deps, markers } = createDeps(true);
    responseForCodexHook(
      JSON.stringify({ session_id: "session-1", cwd: trackedCwd, hook_event_name: "UserPromptSubmit" }),
      deps,
    );
    responseForCodexHook(postToolEvent(finalizeTool, { isError: true, content: [] }), deps);
    expect(markers.has("session-1.segment")).toBe(true);

    const untracked = createDeps(false);
    responseForCodexHook(
      JSON.stringify({ session_id: "session-1", cwd: trackedCwd, hook_event_name: "UserPromptSubmit" }),
      untracked.deps,
    );
    expect(untracked.markers.size).toBe(0);
  });

  it("does not mark the work unsaved when apply_patch failed", () => {
    const { deps, markers } = createDeps();
    responseForCodexHook(postToolEvent("apply_patch", { isError: true, content: [] }), deps);
    expect(markers.has("session-1.dirty")).toBe(false);
    expect(responseForCodexHook(stopEvent(), deps)).toBeNull();
  });

  it("marks apply_patch edits and reminds only once until a successful finalize", () => {
    const { deps, markers } = createDeps();
    expect(responseForCodexHook(postToolEvent("apply_patch"), deps)).toBeNull();

    expect(JSON.parse(responseForCodexHook(stopEvent(), deps) ?? "{}")).toEqual({
      decision: "block",
      reason: REMINDER,
    });
    expect(responseForCodexHook(stopEvent(), deps)).toBeNull();

    expect(responseForCodexHook(postToolEvent(finalizeTool, { isError: true }), deps)).toBeNull();
    expect(markers.has("session-1.dirty")).toBe(true);
    expect(markers.has("session-1.reminded")).toBe(true);

    responseForCodexHook(
      postToolEvent(
        finalizeDispatcher,
        { structuredContent: { outcome: "finalized", sessionId: "wrong-op" } },
        {
          operation: "work_update_session_summary",
          arguments: {},
        },
      ),
      deps,
    );
    expect(markers.has("session-1.dirty")).toBe(true);

    expect(
      responseForCodexHook(
        postToolEvent(
          finalizeDispatcher,
          {
            structuredContent: { outcome: "finalized", sessionId: "saved-session" },
          },
          finalizeDispatcherInput,
        ),
        deps,
      ),
    ).toBeNull();
    expect(markers.size).toBe(0);

    expect(responseForCodexHook(postToolEvent("apply_patch"), deps)).toBeNull();
    expect(JSON.parse(responseForCodexHook(stopEvent(), deps) ?? "{}")).toEqual({
      decision: "block",
      reason: REMINDER,
    });
  });

  it("does nothing for untracked workspaces", () => {
    const { deps, markers } = createDeps(false);
    expect(responseForCodexHook(postToolEvent("apply_patch"), deps)).toBeNull();
    expect(responseForCodexHook(stopEvent(), deps)).toBeNull();
    expect(markers.size).toBe(0);
  });

  it("tracks only apply_patch paths inside a tracked root, including mixed patches", () => {
    const outside = createDeps();
    expect(
      responseForCodexHook(
        postToolEvent("apply_patch", undefined, patch("*** Update File: /tmp/agent-notes.md")),
        outside.deps,
      ),
    ).toBe(null);
    expect(outside.markers.size).toBe(0);
    expect(responseForCodexHook(stopEvent(), outside.deps)).toBeNull();

    const mixed = createDeps();
    expect(
      responseForCodexHook(
        postToolEvent(
          "apply_patch",
          undefined,
          patch("*** Update File: /tmp/agent-notes.md", "*** Add File: ../../README.md"),
        ),
        mixed.deps,
      ),
    ).toBeNull();
    expect(mixed.markers.has("session-1.dirty")).toBe(true);
    expect(JSON.parse(responseForCodexHook(stopEvent(), mixed.deps) ?? "{}")).toEqual({
      decision: "block",
      reason: REMINDER,
    });
  });

  it("parses add, update, delete, and move headers and fails open for incomplete patches", () => {
    expect(
      parseApplyPatchFilePaths(
        patch(
          "*** Add File: src/new.ts",
          "*** Update File: src/old.ts",
          "*** Move to: src/renamed.ts",
          "*** Delete File: src/remove.ts",
        ),
      ),
    ).toEqual(["src/new.ts", "src/old.ts", "src/renamed.ts", "src/remove.ts"]);
    expect(parseApplyPatchFilePaths({ command: "*** Begin Patch\n*** Update File: src/a.ts" })).toBeNull();
    expect(parseApplyPatchFilePaths({ command: "not a patch" })).toBeNull();
  });

  it("restores the unsaved reminder with its start time after every compaction, but only when work is unsaved", () => {
    const { deps } = createDeps();
    const compacted = () => responseForCodexHook(sessionStartEvent("compact"), deps);
    responseForCodexHook(
      JSON.stringify({ session_id: "session-1", cwd: trackedCwd, hook_event_name: "UserPromptSubmit" }),
      deps,
    );
    expect(compacted()).toBeNull();

    responseForCodexHook(postToolEvent("apply_patch"), deps);
    const expected = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: compactedSessionReminder("2026-09-27T01:00:00.000Z"),
      },
    });
    expect(compacted()).toBe(expected);
    expect(compactedSessionReminder("2026-09-27T01:00:00.000Z")).toContain("2026-09-27T01:00:00.000Z");
    // The Stop reminder having fired does not silence the next compaction, and vice versa.
    expect(responseForCodexHook(stopEvent(), deps)).not.toBeNull();
    expect(compacted()).toBe(expected);
    expect(responseForCodexHook(sessionStartEvent("startup"), deps)).toBeNull();
    expect(responseForCodexHook(sessionStartEvent("resume"), deps)).toBeNull();

    const saved = { content: [{ type: "text", text: JSON.stringify({ outcome: "finalized", session: { id: "s" } }) }] };
    responseForCodexHook(postToolEvent(finalizeDispatcher, saved, finalizeDispatcherInput), deps);
    expect(compacted()).toBeNull();

    const untracked = createDeps(false);
    expect(responseForCodexHook(sessionStartEvent("compact"), untracked.deps)).toBeNull();
  });

  it("passes malformed and unrelated hook input without blocking", () => {
    const { deps } = createDeps();
    expect(responseForCodexHook("not json", deps)).toBeNull();
    expect(responseForCodexHook(JSON.stringify({ hook_event_name: "Other" }), deps)).toBeNull();
    expect(responseForCodexHook(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }), deps)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")(
    "runs the documented global command through cmd.exe from outside the repo",
    () => {
      const script = join(repoRoot, "apps", "mcp", "dist", "codex-finalize-reminder.js");
      // Codex hands the command line to cmd.exe unescaped; mirror that instead of Node's argv quoting.
      const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `node "${script}"`], {
        cwd: tmpdir(),
        input: "not json",
        encoding: "utf8",
        timeout: 15_000,
        windowsVerbatimArguments: true,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    },
    20_000,
  );
});
