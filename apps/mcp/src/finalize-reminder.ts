import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** Where in the transcript files were last edited and the record was last saved (-1 when never). */
export function summarizeTranscript(text: string): { lastEdit: number; lastFinalize: number } {
  let lastEdit = -1;
  let lastFinalize = -1;
  let index = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const content = entry.type === "assistant" ? entry.message?.content : undefined;
    for (const item of Array.isArray(content) ? content : []) {
      const name =
        (item as { type?: string; name?: string }).type === "tool_use" ? (item as { name?: string }).name : "";
      index += 1;
      if (name && EDIT_TOOLS.has(name)) {
        lastEdit = index;
      } else if (name?.endsWith("work_finalize_session")) {
        lastFinalize = index;
      }
    }
  }
  return { lastEdit, lastFinalize };
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
  const { lastEdit, lastFinalize } = summarizeTranscript(deps.readTranscript(input.transcript_path));
  if (lastEdit < 0 || lastEdit < lastFinalize) {
    return null;
  }
  if (!findTrackedRoot(deps.realpath(input.cwd), deps.trackedRoots())) {
    return null;
  }
  return deps.markOnce(`${input.session_id}:${lastFinalize}`) ? REMINDER : null;
}

function databasePath(): string {
  return (
    process.env.WORK_INTELLIGENCE_DB ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../data", "work-intelligence.sqlite")
  );
}

const defaultDeps: ReminderDeps = {
  readTranscript: (path) => readFileSync(path, "utf8"),
  realpath: (path) => realpathSync(path),
  trackedRoots: () => {
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
  },
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
