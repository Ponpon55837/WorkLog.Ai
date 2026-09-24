import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { findTrackedRoot, readTrackedRoots, REMINDER } from "./finalize-reminder.js";

interface CodexHookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_response?: unknown;
  stop_hook_active?: boolean;
}

interface ReminderMarkers {
  dirty: string;
  reminded: string;
}

function markerDirectory(): string {
  const user = createHash("sha256").update(userInfo().username).digest("hex").slice(0, 12);
  const directory = resolve(tmpdir(), `work-intelligence-codex-reminder-${user}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || (process.platform !== "win32" && info.uid !== process.getuid?.())) {
    throw new Error("Unsafe Work Intelligence reminder marker directory.");
  }
  return directory;
}

function markerPaths(sessionId: string): ReminderMarkers {
  const directory = markerDirectory();
  const key = createHash("sha256").update(sessionId).digest("hex");
  return {
    dirty: `${directory}${sep}${key}.dirty`,
    reminded: `${directory}${sep}${key}.reminded`,
  };
}

/** Atomically create a private marker. A pre-existing or unsafe path fails open. */
function createMarker(path: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    return false;
  }
  closeSync(descriptor);
  return true;
}

function removeMarker(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing or unreadable markers should never stop the Agent.
  }
}

function isTrackedWorkspace(cwd: string): boolean {
  try {
    return Boolean(findTrackedRoot(realpathSync(cwd), readTrackedRoots()));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function finalizedSuccessfully(response: unknown): boolean {
  const root = parseJson(response);
  if (!isRecord(root) || root.isError === true) {
    return false;
  }

  const structured = parseJson(root.structuredContent);
  if (isRecord(structured) && structured.outcome === "finalized" && typeof structured.sessionId === "string") {
    return true;
  }

  const content = Array.isArray(root.content) ? root.content : [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text") {
      continue;
    }
    const payload = parseJson(item.text);
    if (isRecord(payload) && payload.outcome === "finalized" && isRecord(payload.session)) {
      return typeof payload.session.id === "string";
    }
  }
  return false;
}

function trackPostToolUse(input: CodexHookInput): void {
  if (!input.session_id || !input.cwd || !input.tool_name || !isTrackedWorkspace(input.cwd)) {
    return;
  }

  const markers = markerPaths(input.session_id);
  if (input.tool_name === "apply_patch") {
    if (!existsSync(markers.dirty) && createMarker(markers.dirty)) {
      removeMarker(markers.reminded);
    }
    return;
  }

  if (input.tool_name.endsWith("work_finalize_session") && finalizedSuccessfully(input.tool_response)) {
    removeMarker(markers.dirty);
    removeMarker(markers.reminded);
  }
}

function reminderForStop(input: CodexHookInput): string | null {
  if (input.stop_hook_active || !input.session_id || !input.cwd || !isTrackedWorkspace(input.cwd)) {
    return null;
  }

  const markers = markerPaths(input.session_id);
  if (!existsSync(markers.dirty) || existsSync(markers.reminded)) {
    return null;
  }
  return createMarker(markers.reminded) ? REMINDER : null;
}

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }

  let reason: string | null = null;
  try {
    const input = JSON.parse(raw) as CodexHookInput;
    if (input.hook_event_name === "PostToolUse") {
      trackPostToolUse(input);
    } else if (input.hook_event_name === "Stop") {
      reason = reminderForStop(input);
    }
  } catch {
    // The reminder is best-effort: never stop Codex because the check failed.
  }

  if (reason) {
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
