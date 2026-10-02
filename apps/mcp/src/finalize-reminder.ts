import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { databasePathFor } from "./database-location.js";

/**
 * Claude Code Stop hook: when an Agent changed files in a tracked project and has not saved a Work
 * Intelligence record since, ask it once to finalize. It reads the project registry read-only, never
 * writes the database, and stays silent whenever it cannot tell.
 */
export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export const REMINDER =
  "這個專案有在 Work Intelligence 記錄，上次保存之後又改了檔案，還沒有保存工作記錄。如果這段工作已經完成，請依 work-intelligence skill 保存；如果還在進行或不需要記錄，直接結束這一輪即可。同一段工作只會提醒一次。";

/** Adds when the current segment began (the first message after the last successful save), so the Agent never estimates startedAt. */
export function reminderWithStart(segmentStartedAt: string | undefined): string {
  return segmentStartedAt
    ? `${REMINDER}這段工作的開始時間（上一次成功保存後的第一則訊息）：${segmentStartedAt}。保存時請把它填入 startedAt；completedAt 請省略，由伺服器記錄。`
    : REMINDER;
}

/** A message the user typed (a string or text blocks), as opposed to tool results, which are also `user` entries. */
function isHumanMessage(entry: { type?: string; isMeta?: boolean; message?: { content?: unknown } }): boolean {
  if (entry.type !== "user" || entry.isMeta) {
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

/** Resolve a tool path without reading file contents; new files use their deepest existing parent. */
export function isFileInTrackedRoots(
  filePath: string,
  cwd: string,
  roots: readonly string[],
  realpath: (path: string) => string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!filePath.trim()) {
    return false;
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
  return Boolean(findTrackedRoot(target, roots, platform));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinalizeToolCall(name: string, input: unknown): boolean {
  if (name.endsWith("work_finalize_session")) return true;
  return name.endsWith("work_write_idempotent") && isRecord(input) && input.operation === "work_finalize_session";
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
export function summarizeTranscript(
  text: string,
  scope?: TranscriptPathScope,
): { lastEdit: number; lastFinalize: number; segmentStartedAt?: string } {
  let lastEdit = -1;
  let lastFinalize = -1;
  let segmentStartedAt: string | undefined;
  let index = 0;
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
          lastFinalize = finalizeIndex;
          // The next typed message starts a new segment.
          segmentStartedAt = undefined;
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
          if (!path || !isFileInTrackedRoots(path, scope.cwd, scope.roots, scope.realpath, scope.platform)) {
            continue;
          }
        }
        lastEdit = index;
      } else if (name && isFinalizeToolCall(name, tool.input)) {
        if (typeof tool.id === "string") {
          pendingFinalize.set(tool.id, index);
        } else {
          // Without an id the result cannot be matched; keep the older behavior of trusting the call.
          lastFinalize = index;
          segmentStartedAt = undefined;
        }
      }
    }
  }
  return { lastEdit, lastFinalize, ...(segmentStartedAt ? { segmentStartedAt } : {}) };
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

/** The reason to show the Agent, or null to let it stop. */
export function reminderFor(input: StopHookInput, deps: ReminderDeps): string | null {
  if (input.stop_hook_active || !input.cwd || !input.transcript_path || !input.session_id) {
    return null;
  }
  let cwd: string;
  let roots: string[];
  let transcript: string;
  try {
    cwd = deps.realpath(input.cwd);
    roots = deps.trackedRoots();
    if (!findTrackedRoot(cwd, roots)) {
      return null;
    }
    transcript = deps.readTranscript(input.transcript_path);
  } catch {
    return null;
  }
  const { lastEdit, lastFinalize, segmentStartedAt } = summarizeTranscript(transcript, {
    cwd,
    roots,
    realpath: deps.realpath,
  });
  if (lastEdit < 0 || lastEdit < lastFinalize) {
    return null;
  }
  return deps.markOnce(`${input.session_id}:${lastFinalize}`) ? reminderWithStart(segmentStartedAt) : null;
}

export function databasePath(): string {
  return databasePathFor(resolve(dirname(fileURLToPath(import.meta.url)), "../../../data", "work-intelligence.sqlite"));
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
  let reason: string | null = null;
  try {
    reason = reminderFor(JSON.parse(raw) as StopHookInput, defaultDeps);
  } catch {
    // A reminder is best-effort: never block the Agent because the check itself failed.
  }
  if (reason) {
    // Newer Claude Code reads hookSpecificOutput; older versions read the top-level fields.
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason,
        hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason },
      }),
    );
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
