import fs from "node:fs";
import path from "node:path";
import { isSupportedDatabasePath } from "../settings/schema.js";

/**
 * Which database the Agent entries started by the fixed shim open (ADR-39). The App records where its settings file is
 * in `<launcher root>/desktop-settings-path`; the launcher reads that one line and the settings file on every start and
 * hands `desired.databasePath` to the action as `WORK_INTELLIGENCE_DB`, unless the caller set that variable itself.
 * So the MCP server and the hooks open the database the App committed, also after the App changed it, and an Agent
 * whose registration names another database explicitly keeps it.
 *
 * It is deliberately small and synchronous: two reads of a few hundred bytes, no schema library, nothing cached
 * between processes. Any doubt (a missing pointer, an App that is not set up yet) means "no opinion", and the action
 * keeps the standalone rule; a pointer or settings file that is present but unusable is `invalid`, with a reason.
 */

/** The pointer file below the launcher root; one line, the absolute path of the App's `desktop-settings.json`. */
export const DESKTOP_SETTINGS_POINTER_FILE_NAME = "desktop-settings-path";

/** The variable the database rules read (packages/shared/src/database-location.ts). */
export const DATABASE_ENVIRONMENT_VARIABLE = "WORK_INTELLIGENCE_DB";

/** Both files are tiny; anything larger is not ours. */
const MAX_POINTER_BYTES = 4096;
const MAX_SETTINGS_BYTES = 64 * 1024;

export type DesktopDatabaseResolution =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly databasePath: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** What {@link resolveDesktopDatabase} reads; injectable so tests never touch a real App. */
export interface DesktopDatabaseDeps {
  readonly platform: NodeJS.Platform;
  /** The current uid on POSIX; undefined on Windows. */
  readonly uid: number | undefined;
  lstat(file: string): fs.Stats;
  readFile(file: string): Buffer;
}

const NODE_DEPS: DesktopDatabaseDeps = {
  platform: process.platform,
  uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  lstat: (file) => fs.lstatSync(file),
  readFile: (file) => fs.readFileSync(file),
};

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * An absolute, normalized path for `platform` under the App's shared database path rule
 * ({@link isSupportedDatabasePath}): a drive path on Windows (no UNC, no `\\?\`), `/…` elsewhere.
 */
export function isUsablePath(value: string, platform: NodeJS.Platform): boolean {
  if (!isSupportedDatabasePath(value, platform)) return false;
  const api = platform === "win32" ? path.win32 : path.posix;
  return api.normalize(value) === value;
}

/** Same rules as the integration record's readers: a regular file of this user that nobody else may write. */
function unsafeFile(stats: fs.Stats, deps: DesktopDatabaseDeps): string | undefined {
  if (stats.isSymbolicLink()) return "是符號連結";
  if (!stats.isFile()) return "不是一般檔案";
  if (deps.platform === "win32") return undefined;
  if (deps.uid !== undefined && stats.uid !== deps.uid) return "屬於其他使用者";
  if ((stats.mode & 0o002) !== 0) return "所有人都可寫入";
  return undefined;
}

function readSmallFile(file: string, limit: number, deps: DesktopDatabaseDeps): Buffer | string {
  const stats = deps.lstat(file);
  const unsafe = unsafeFile(stats, deps);
  if (unsafe) return unsafe;
  if (stats.size > limit) return "過大";
  return deps.readFile(file);
}

/** The committed database in the settings text, or why there is none to use. */
export function databaseFromSettingsText(text: string, platform: NodeJS.Platform): DesktopDatabaseResolution {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { kind: "invalid", reason: "設定檔不是 JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "invalid", reason: "設定檔不是物件" };
  }
  const settings = raw as { configVersion?: unknown; desired?: { databasePath?: unknown } | null };
  if (settings.configVersion !== 1) return { kind: "invalid", reason: "不支援的設定版本" };
  const databasePath = settings.desired?.databasePath;
  if (typeof databasePath !== "string" || !isUsablePath(databasePath, platform)) {
    return { kind: "invalid", reason: "設定檔沒有支援的絕對資料庫路徑（不支援網路共用與裝置路徑）" };
  }
  return { kind: "ok", databasePath };
}

/** The database the App committed, read through the pointer in `launcherRoot`. Never throws. */
export function resolveDesktopDatabase(
  launcherRoot: string,
  deps: DesktopDatabaseDeps = NODE_DEPS,
): DesktopDatabaseResolution {
  const pointerFile = path.join(launcherRoot, DESKTOP_SETTINGS_POINTER_FILE_NAME);
  let settingsFile: string;
  try {
    const pointer = readSmallFile(pointerFile, MAX_POINTER_BYTES, deps);
    if (typeof pointer === "string") return { kind: "invalid", reason: `指標檔${pointer}` };
    settingsFile = pointer
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trim();
  } catch (error) {
    return isMissing(error) ? { kind: "none" } : { kind: "invalid", reason: "指標檔無法讀取" };
  }
  if (!isUsablePath(settingsFile, deps.platform)) {
    return { kind: "invalid", reason: "指標檔的內容不是支援的絕對路徑" };
  }
  try {
    const settings = readSmallFile(settingsFile, MAX_SETTINGS_BYTES, deps);
    if (typeof settings === "string") return { kind: "invalid", reason: `設定檔${settings}` };
    return databaseFromSettingsText(settings.toString("utf8"), deps.platform);
  } catch (error) {
    // The App records the pointer before it is set up: no settings yet means no committed database.
    return isMissing(error) ? { kind: "none" } : { kind: "invalid", reason: "設定檔無法讀取" };
  }
}
