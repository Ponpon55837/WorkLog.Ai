import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { responseForCodexHook, type CodexReminderDeps } from "../../apps/mcp/src/codex-finalize-reminder.js";
import { REMINDER } from "../../apps/mcp/src/finalize-reminder.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const trackedCwd = join(repoRoot, "apps/mcp");
const finalizeTool = "mcp__work-intelligence__work_finalize_session";

function createDeps(tracked = true) {
  const markers = new Set<string>();
  const deps: CodexReminderDeps = {
    isTrackedWorkspace: () => tracked,
    markerPaths: (sessionId) => ({
      dirty: `${sessionId}.dirty`,
      reminded: `${sessionId}.reminded`,
    }),
    markerExists: (path) => markers.has(path),
    createMarker: (path) => {
      if (markers.has(path)) {
        return false;
      }
      markers.add(path);
      return true;
    },
    removeMarker: (path) => markers.delete(path),
  };
  return { deps, markers };
}

function postToolEvent(toolName: string, toolResponse?: unknown) {
  return JSON.stringify({
    session_id: "session-1",
    cwd: trackedCwd,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_response: toolResponse,
  });
}

function stopEvent() {
  return JSON.stringify({ session_id: "session-1", cwd: trackedCwd, hook_event_name: "Stop" });
}

describe("Codex finalize reminder hook", () => {
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

    expect(
      responseForCodexHook(
        postToolEvent(finalizeTool, {
          structuredContent: { outcome: "finalized", sessionId: "saved-session" },
        }),
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
