import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { databasePathFor } from "./database-location.js";

/**
 * Claude Code hooks for unsaved work in a tracked project. PreToolUse: pause a finalize call that names no startedAt
 * once, with the observed segment start. Stop: when an Agent changed files and has not saved a
 * Work Intelligence record since, ask it once to finalize. PreCompact: tell the compaction summary to keep when the
 * segment began and which files changed. SessionStart (after compaction): put the same facts back into context.
 * It reads the project registry read-only, never writes the database, and stays silent whenever it cannot tell.
 */
export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  hook_event_name?: string;
  /** SessionStart only: `compact` after a compaction. */
  source?: string;
  /** PreToolUse only. */
  tool_name?: string;
  tool_input?: unknown;
}

/** Unsaved work in a tracked project: when its segment began and the tracked files edited since the last save. */
export interface UnsavedWork {
  lastFinalize: number;
  segmentStartedAt?: string;
  /** Paths relative to their tracked root, "/"-separated, in first-edit order. */
  files: string[];
}

export interface TranscriptSummary {
  lastEdit: number;
  lastFinalize: number;
  segmentStartedAt?: string;
  /** Only filled when a path scope is given. */
  editedFiles: string[];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** How many changed files the compaction notes list by name; the rest are counted. */
const MAX_LISTED_FILES = 30;
const MAX_PATH_LENGTH = 200;
/** Claude Code cuts PreCompact stdout at 10,000 characters; stay well below it. */
const MAX_COMPACTION_TEXT = 8_000;
// C0/C1 controls and bidirectional overrides: a file name must not reshape the text around it.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export const REMINDER =
  "這個專案有在 Work Intelligence 記錄，上次保存之後又改了檔案，還沒有保存工作記錄。如果這段工作已經完成，請依 work-intelligence skill 保存；如果還在進行或不需要記錄，直接結束這一輪即可。同一段工作只會提醒一次。";

function startHint(segmentStartedAt: string | undefined): string {
  return segmentStartedAt
    ? `這段工作的開始時間（上一次成功保存後的第一則訊息）：${segmentStartedAt}。保存時請把它填入 startedAt；completedAt 請省略，由伺服器記錄。`
    : "";
}

/** Why a save without startedAt was paused once. */
export function missingStartedAtReason(segmentStartedAt: string): string {
  return `保存被暫停一次：沒有填 startedAt。這段工作的開始時間（上一次成功保存後的第一則訊息）是 ${segmentStartedAt}，請把 startedAt 設為 ${segmentStartedAt} 後重新呼叫；completedAt 照舊省略。`;
}

/** Adds when the current segment began (the first message after the last successful save), so the Agent never estimates startedAt. */
export function reminderWithStart(segmentStartedAt: string | undefined): string {
  return `${REMINDER}${startHint(segmentStartedAt)}`;
}

/**
 * A message the user typed (a string or text blocks), as opposed to tool results, which are also `user` entries,
 * and the summary Claude Code writes after a compact boundary.
 */
function isHumanMessage(entry: {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
}): boolean {
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) {
    return false;
  }
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  return (
    Array.isArray(content) &&
    content.some((item) => (item as { type?: string }).type === "text") &&
    !content.some((item) => (item as { type?: string }).type === "tool_result")
  );
}

interface TranscriptPathScope {
  cwd: string;
  roots: readonly string[];
  realpath: (path: string) => string;
  platform?: NodeJS.Platform;
}

function editedPath(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const key = name === "NotebookEdit" ? "notebook_path" : "file_path";
  const path = (input as Record<string, unknown>)[key];
  return typeof path === "string" && path.trim() ? path : null;
}

/** A path relative to its tracked root for display: "/"-separated, no control characters, bounded length. */
function relativeDisplayPath(location: { root: string; target: string }): string | null {
  const base = location.root.replace(/[\\/]+$/, "");
  const relative = location.target
    .slice(base.length + 1)
    .replaceAll("\\", "/")
    .replace(UNSAFE_TEXT, "");
  if (!relative || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  return relative.length > MAX_PATH_LENGTH ? `…${relative.slice(-(MAX_PATH_LENGTH - 1))}` : relative;
}

/**
 * Resolve a tool path without reading file contents (new files use their deepest existing parent) and find the
 * tracked root that contains it.
 */
function trackedLocation(
  filePath: string,
  cwd: string,
  roots: readonly string[],
  realpath: (path: string) => string,
  platform: NodeJS.Platform = process.platform,
): { root: string; target: string } | null {
  if (!filePath.trim()) {
    return null;
  }

  let target = resolve(cwd, filePath);
  let current = target;
  const missingParts: string[] = [];
  while (true) {
    try {
      target = resolve(realpath(current), ...missingParts);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        target = resolve(cwd, filePath);
        break;
      }
      missingParts.unshift(basename(current));
      current = parent;
    }
  }
  const root = findTrackedRoot(target, roots, platform);
  return root ? { root, target } : null;
}

/** Whether a tool path resolves inside a tracked root. */
export function isFileInTrackedRoots(
  filePath: string,
  cwd: string,
  roots: readonly string[],
  realpath: (path: string) => string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return trackedLocation(filePath, cwd, roots, realpath, platform) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinalizeToolCall(name: string, input: unknown): boolean {
  if (name.endsWith("work_finalize_session")) return true;
  return name.endsWith("work_write_idempotent") && isRecord(input) && input.operation === "work_finalize_session";
}

/** The arguments of a finalize call: nested under `arguments` when it goes through the dispatcher tool. */
function finalizeArguments(name: string, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  if (name.endsWith("work_write_idempotent")) {
    return isRecord(input.arguments) ? input.arguments : {};
  }
  return input;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a work_finalize_session result payload means the record was actually saved (a duplicate counts). */
export function isFinalizedPayload(payload: unknown): boolean {
  const value = parseJson(payload);
  if (!isRecord(value) || value.outcome !== "finalized") {
    return false;
  }
  return (isRecord(value.session) && typeof value.session.id === "string") || typeof value.sessionId === "string";
}

/** A Claude Code tool_result for work_finalize_session: rejected, skipped, or conflicting saves do not count. */
function finalizeResultSucceeded(result: { content?: unknown; is_error?: unknown }): boolean {
  if (result.is_error === true) {
    return false;
  }
  if (typeof result.content === "string") {
    return isFinalizedPayload(result.content);
  }
  return (Array.isArray(result.content) ? result.content : []).some(
    (item) => isRecord(item) && item.type === "text" && isFinalizedPayload(item.text),
  );
}

/**
 * Where in the transcript files were last edited and the record was last saved (-1 when never), and when the
 * current segment began: the first message the user typed after the last successful save.
 */
export function summarizeTranscript(text: string, scope?: TranscriptPathScope): TranscriptSummary {
  let lastEdit = -1;
  let lastFinalize = -1;
  let segmentStartedAt: string | undefined;
  let index = 0;
  // Tracked file → index of its latest edit; a successful save drops the edits it covered.
  const editedFiles = new Map<string, number>();
  const closeSegment = (finalizeIndex: number) => {
    lastFinalize = finalizeIndex;
    // The next typed message starts a new segment.
    segmentStartedAt = undefined;
    for (const [file, editIndex] of editedFiles) {
      if (editIndex < finalizeIndex) editedFiles.delete(file);
    }
  };
  // Finalize calls wait for their result: only a successful save ends the segment.
  const pendingFinalize = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: { type?: string; isMeta?: boolean; timestamp?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (
      segmentStartedAt === undefined &&
      isHumanMessage(entry) &&
      typeof entry.timestamp === "string" &&
      !Number.isNaN(Date.parse(entry.timestamp))
    ) {
      segmentStartedAt = new Date(entry.timestamp).toISOString();
    }
    if (entry.type === "user" && Array.isArray(entry.message?.content)) {
      for (const item of entry.message.content as unknown[]) {
        const result = item as { type?: string; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") {
          continue;
        }
        const finalizeIndex = pendingFinalize.get(result.tool_use_id);
        if (finalizeIndex === undefined) {
          continue;
        }
        pendingFinalize.delete(result.tool_use_id);
        if (finalizeResultSucceeded(result)) {
          closeSegment(finalizeIndex);
        }
      }
    }
    const content = entry.type === "assistant" ? entry.message?.content : undefined;
    for (const item of Array.isArray(content) ? content : []) {
      const tool = item as { type?: string; id?: unknown; name?: string; input?: unknown };
      const name = tool.type === "tool_use" ? tool.name : "";
      index += 1;
      if (name && EDIT_TOOLS.has(name)) {
        if (scope) {
          const path = editedPath(name, tool.input);
          const location = path && trackedLocation(path, scope.cwd, scope.roots, scope.realpath, scope.platform);
          if (!location) {
            continue;
          }
          const display = relativeDisplayPath(location);
          if (display) editedFiles.set(display, index);
        }
        lastEdit = index;
      } else if (name && isFinalizeToolCall(name, tool.input)) {
        if (typeof tool.id === "string") {
          pendingFinalize.set(tool.id, index);
        } else {
          // Without an id the result cannot be matched; keep the older behavior of trusting the call.
          closeSegment(index);
        }
      }
    }
  }
  return {
    lastEdit,
    lastFinalize,
    ...(segmentStartedAt ? { segmentStartedAt } : {}),
    editedFiles: [...editedFiles.keys()],
  };
}

/** The tracked project root containing `cwd`, comparing whole path segments (case-insensitive on Windows). */
export function findTrackedRoot(
  cwd: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const target = fold(cwd);
  return (
    roots.find((root) => {
      const base = fold(root.replace(/[\\/]+$/, ""));
      return target === base || target.startsWith(`${base}/`) || target.startsWith(`${base}\\`);
    }) ?? null
  );
}

export interface ReminderDeps {
  readTranscript: (path: string) => string;
  trackedRoots: () => string[];
  realpath: (path: string) => string;
  /** Returns true the first time a key is seen, so each unsaved stretch of work is mentioned once. */
  markOnce: (key: string) => boolean;
}

/**
 * The unsaved work in this session when `cwd` is in a tracked project and a tracked file was edited after the last
 * successful save; null otherwise, including whenever the check itself fails.
 */
export function unsavedWorkFor(input: StopHookInput, deps: Omit<ReminderDeps, "markOnce">): UnsavedWork | null {
  if (!input.cwd || !input.transcript_path || !input.session_id) {
    return null;
  }
  try {
    const cwd = deps.realpath(input.cwd);
    const roots = deps.trackedRoots();
    if (!findTrackedRoot(cwd, roots)) {
      return null;
    }
    const { lastEdit, lastFinalize, segmentStartedAt, editedFiles } = summarizeTranscript(
      deps.readTranscript(input.transcript_path),
      { cwd, roots, realpath: deps.realpath },
    );
    if (lastEdit < 0 || lastEdit < lastFinalize) {
      return null;
    }
    return { lastFinalize, files: editedFiles, ...(segmentStartedAt ? { segmentStartedAt } : {}) };
  } catch {
    return null;
  }
}

/** The reason to show the Agent, or null to let it stop. */
export function reminderFor(input: StopHookInput, deps: ReminderDeps): string | null {
  if (input.stop_hook_active) {
    return null;
  }
  const work = unsavedWorkFor(input, deps);
  if (!work) {
    return null;
  }
  return deps.markOnce(`${input.session_id}:${work.lastFinalize}`) ? reminderWithStart(work.segmentStartedAt) : null;
}

/**
 * Pauses a finalize call once per segment when it names neither startedAt nor completedAt, so the Agent can retry
 * with the observed segment start. The transcript is read only for finalize calls. Never denies a second attempt.
 */
export function preToolUseDenial(input: StopHookInput, deps: ReminderDeps): string | null {
  const name = input.tool_name;
  if (
    !name ||
    !input.cwd ||
    !input.transcript_path ||
    !input.session_id ||
    !isFinalizeToolCall(name, input.tool_input)
  ) {
    return null;
  }
  const args = finalizeArguments(name, input.tool_input);
  if (args.startedAt !== undefined || args.completedAt !== undefined) {
    return null;
  }
  try {
    const cwd = deps.realpath(input.cwd);
    if (!findTrackedRoot(cwd, deps.trackedRoots())) {
      return null;
    }
    const { lastFinalize, segmentStartedAt } = summarizeTranscript(deps.readTranscript(input.transcript_path));
    if (!segmentStartedAt || !deps.markOnce(`pre:${input.session_id}:${lastFinalize}`)) {
      return null;
    }
    return missingStartedAtReason(segmentStartedAt);
  } catch {
    return null;
  }
}

/** "a、b、c 等 N 個" with at most MAX_LISTED_FILES names. */
function fileList(files: readonly string[]): string {
  const listed = files.slice(0, MAX_LISTED_FILES).join("、");
  return files.length > MAX_LISTED_FILES ? `${listed} 等 ${files.length} 個` : listed;
}

function boundedText(text: string): string {
  return text.length > MAX_COMPACTION_TEXT ? `${text.slice(0, MAX_COMPACTION_TEXT - 1)}…` : text;
}

/** Extra instructions for the compaction summary, so it keeps what the work record needs. */
export function compactionSummaryInstructions(work: UnsavedWork): string {
  const parts = ["摘要請保留：這段工作尚未保存 Work Intelligence 工作記錄"];
  if (work.segmentStartedAt) parts.push(`開始時間 ${work.segmentStartedAt}`);
  if (work.files.length) parts.push(`在記錄中專案改過的檔案：${fileList(work.files)}`);
  return boundedText(`${parts.join("；")}。完成後要依 work-intelligence skill 保存。`);
}

/** Context added after a compaction, so the start time and the unsaved state survive even if the summary drops them. */
export function compactedSessionReminder(segmentStartedAt: string | undefined, files: readonly string[] = []): string {
  const changed = files.length ? `上次保存之後改過的檔案：${fileList(files)}。` : "";
  return boundedText(
    `對話剛壓縮過，這段工作的狀態仍然有效：這個專案有在 Work Intelligence 記錄，上次保存之後改過檔案，還沒有保存工作記錄。${startHint(segmentStartedAt)}${changed}工作完成後請依 work-intelligence skill 保存。`,
  );
}

/** The hook's stdout for one Claude Code event, or null to print nothing. */
export function responseForClaudeHook(raw: string, deps: ReminderDeps): string | null {
  let input: StopHookInput;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    input = value as StopHookInput;
  } catch {
    return null;
  }
  if (input.hook_event_name === "PreToolUse") {
    const permissionDecisionReason = preToolUseDenial(input, deps);
    return permissionDecisionReason
      ? JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason },
        })
      : null;
  }
  if (input.hook_event_name === "PreCompact") {
    // Plain stdout becomes summary instructions. Never block: that would skip or fail the compaction.
    const work = unsavedWorkFor(input, deps);
    return work ? compactionSummaryInstructions(work) : null;
  }
  if (input.hook_event_name === "SessionStart") {
    if (input.source !== "compact") return null;
    const work = unsavedWorkFor(input, deps);
    if (!work) return null;
    const additionalContext = compactedSessionReminder(work.segmentStartedAt, work.files);
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
  }
  if (input.hook_event_name !== undefined && input.hook_event_name !== "Stop") {
    return null;
  }
  const reason = reminderFor(input, deps);
  // Newer Claude Code reads hookSpecificOutput; older versions read the top-level fields.
  return reason
    ? JSON.stringify({
        decision: "block",
        reason,
        hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason },
      })
    : null;
}

export function databasePath(): string {
  return databasePathFor(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
}

export function readTrackedRoots(): string[] {
  const path = databasePath();
  if (!existsSync(path)) {
    return [];
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      db.prepare("SELECT root_path FROM projects WHERE status = 'tracked'").all() as Array<{
        root_path: string;
      }>
    ).map((row) => row.root_path);
  } finally {
    db.close();
  }
}

const defaultDeps: ReminderDeps = {
  readTranscript: (path) => readFileSync(path, "utf8"),
  realpath: (path) => realpathSync(path),
  trackedRoots: readTrackedRoots,
  markOnce: (key) => {
    // One directory per user: /tmp is shared on Linux, and another user must not own our markers.
    const user = createHash("sha256").update(userInfo().username).digest("hex").slice(0, 12);
    const directory = resolve(tmpdir(), `work-intelligence-finalize-reminder-${user}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (
      process.platform !== "win32" &&
      (lstatSync(directory).isSymbolicLink() || lstatSync(directory).uid !== process.getuid?.())
    ) {
      return false;
    }
    // Hash the key so a session id never becomes part of a path.
    const marker = `${directory}${sep}${createHash("sha256").update(key).digest("hex")}`;
    if (existsSync(marker)) {
      return false;
    }
    writeFileSync(marker, "", { mode: 0o600 });
    return true;
  },
};

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }
  let response: string | null = null;
  try {
    response = responseForClaudeHook(raw, defaultDeps);
  } catch {
    // A reminder is best-effort: never block the Agent or a compaction because the check itself failed.
  }
  if (response) {
    process.stdout.write(response);
  }
}

// The file name check matters in the plugin bundle, where codex-finalize-reminder.js inlines this module and shares
// its import.meta.url; without it both reminders would run there.
if (
  process.argv[1] &&
  basename(process.argv[1]) === "finalize-reminder.js" &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
