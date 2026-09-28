import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findTrackedRoot,
  isFileInTrackedRoots,
  isFinalizedPayload,
  readTrackedRoots,
  reminderWithStart,
} from "./finalize-reminder.js";

export interface CodexHookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  stop_hook_active?: boolean;
}

export interface ReminderMarkers {
  dirty: string;
  reminded: string;
  /** Holds the time the user sent the first prompt since the last successful save. */
  segment: string;
}

export interface CodexReminderDeps {
  isTrackedWorkspace: (cwd: string) => boolean;
  hasTrackedFiles: (cwd: string, filePaths: readonly string[]) => boolean;
  markerPaths: (sessionId: string) => ReminderMarkers;
  markerExists: (path: string) => boolean;
  createMarker: (path: string) => boolean;
  /** Creates a private marker holding `content`; false when it already exists. */
  writeMarker: (path: string, content: string) => boolean;
  readMarker: (path: string) => string | undefined;
  removeMarker: (path: string) => void;
  now: () => Date;
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
    segment: `${directory}${sep}${key}.segment`,
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

function writeMarker(path: string, content: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    return false;
  }
  try {
    writeSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
  return true;
}

function readMarker(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
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

function isFinalizeToolCall(name: string, input: unknown): boolean {
  if (name.endsWith("work_finalize_session")) return true;
  return name.endsWith("work_write_idempotent") && isRecord(input) && input.operation === "work_finalize_session";
}

/** Return every affected path in Codex's structured apply_patch input, or null when it is unreadable. */
export function parseApplyPatchFilePaths(toolInput: unknown): string[] | null {
  if (!isRecord(toolInput) || typeof toolInput.command !== "string") {
    return null;
  }
  const lines = toolInput.command.split(/\r?\n/);
  const start = lines.indexOf("*** Begin Patch");
  const end = lines.lastIndexOf("*** End Patch");
  if (start < 0 || end <= start) {
    return null;
  }

  const paths: string[] = [];
  let activeOperation: "add" | "update" | "delete" | null = null;
  for (const line of lines.slice(start + 1, end)) {
    const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (fileHeader) {
      const operation = fileHeader[1];
      const path = fileHeader[2]?.trim();
      if (!operation || !path) {
        return null;
      }
      activeOperation = operation.toLowerCase() as "add" | "update" | "delete";
      paths.push(path);
      continue;
    }
    if (
      line.startsWith("*** Add File:") ||
      line.startsWith("*** Update File:") ||
      line.startsWith("*** Delete File:")
    ) {
      return null;
    }
    if (line.startsWith("*** Move to:")) {
      const path = line.slice("*** Move to:".length).trim();
      if (activeOperation !== "update" || !path) {
        return null;
      }
      paths.push(path);
    }
  }
  return paths.length ? paths : null;
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
  return content.some((item) => isRecord(item) && item.type === "text" && isFinalizedPayload(item.text));
}

export function trackPostToolUse(input: CodexHookInput, deps: CodexReminderDeps): void {
  if (!input.session_id || !input.cwd || !input.tool_name || !deps.isTrackedWorkspace(input.cwd)) {
    return;
  }

  const markers = deps.markerPaths(input.session_id);
  if (input.tool_name === "apply_patch") {
    const paths = parseApplyPatchFilePaths(input.tool_input);
    if (!paths || !deps.hasTrackedFiles(input.cwd, paths)) {
      return;
    }
    if (!deps.markerExists(markers.dirty) && deps.createMarker(markers.dirty)) {
      deps.removeMarker(markers.reminded);
    }
    return;
  }

  if (isFinalizeToolCall(input.tool_name, input.tool_input) && finalizedSuccessfully(input.tool_response)) {
    deps.removeMarker(markers.dirty);
    deps.removeMarker(markers.reminded);
    // The next prompt starts a new segment.
    deps.removeMarker(markers.segment);
  }
}

/**
 * Records when the current segment began: the first prompt after the last successful save. Codex's transcript
 * format is not a stable hook interface, so the time is taken when UserPromptSubmit fires instead.
 */
export function trackUserPrompt(input: CodexHookInput, deps: CodexReminderDeps): void {
  if (!input.session_id || !input.cwd || !deps.isTrackedWorkspace(input.cwd)) {
    return;
  }
  const markers = deps.markerPaths(input.session_id);
  if (!deps.markerExists(markers.segment)) {
    deps.writeMarker(markers.segment, deps.now().toISOString());
  }
}

function segmentStart(value: string | undefined): string | undefined {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

export function reminderForStop(input: CodexHookInput, deps: CodexReminderDeps): string | null {
  if (input.stop_hook_active || !input.session_id || !input.cwd || !deps.isTrackedWorkspace(input.cwd)) {
    return null;
  }

  const markers = deps.markerPaths(input.session_id);
  if (!deps.markerExists(markers.dirty) || deps.markerExists(markers.reminded)) {
    return null;
  }
  return deps.createMarker(markers.reminded) ? reminderWithStart(segmentStart(deps.readMarker(markers.segment))) : null;
}

const defaultDeps: CodexReminderDeps = {
  isTrackedWorkspace,
  hasTrackedFiles: (cwd, filePaths) => {
    try {
      const roots = readTrackedRoots();
      return filePaths.some((filePath) => isFileInTrackedRoots(filePath, cwd, roots, realpathSync));
    } catch {
      return false;
    }
  },
  markerPaths,
  markerExists: existsSync,
  createMarker,
  writeMarker,
  readMarker,
  removeMarker,
  now: () => new Date(),
};

/** Convert one hook event into the optional block response; malformed input always passes through. */
export function responseForCodexHook(raw: string, deps: CodexReminderDeps = defaultDeps): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const input = value as CodexHookInput;
  if (input.hook_event_name === "PostToolUse") {
    trackPostToolUse(input, deps);
    return null;
  }
  if (input.hook_event_name === "UserPromptSubmit") {
    trackUserPrompt(input, deps);
    return null;
  }
  if (input.hook_event_name === "Stop") {
    const reason = reminderForStop(input, deps);
    return reason ? JSON.stringify({ decision: "block", reason }) : null;
  }
  return null;
}

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }

  try {
    const response = responseForCodexHook(raw);
    if (response) {
      process.stdout.write(response);
    }
  } catch {
    // The reminder is best-effort: never stop Codex because the check failed.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
