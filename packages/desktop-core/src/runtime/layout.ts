import { RUNTIME_CURRENT_FILE_NAME, RUNTIME_DIRECTORIES_NAME } from "@work-intelligence/shared/agent-observations";
import fs from "node:fs/promises";
import path from "node:path";
import { isMissingError } from "../internal/error-code.js";
import { RuntimeError } from "./errors.js";
import { isRuntimeId } from "./manifest.js";

/** Name of the single-line file that holds the current runtime id; the one atomic switch point. */
export const CURRENT_FILE_NAME = RUNTIME_CURRENT_FILE_NAME;
/** Folder of the fixed shims an Agent's `command` points at. */
export const BIN_DIRECTORY_NAME = "bin";
/** Folder holding one immutable directory per installed runtime. */
export const RUNTIMES_DIRECTORY_NAME = RUNTIME_DIRECTORIES_NAME;
/** Folder holding one directory of lease files per runtime id: the proof that a launcher process uses that runtime (DT-24). */
export const LEASES_DIRECTORY_NAME = "leases";
/**
 * The record of when each retired runtime was first seen retired (see runtime-gc.ts), inside the leases folder: writing
 * it there never changes the launcher root's change time, which the Windows ACL stamp covers.
 */
export const GC_STATE_FILE_NAME = "gc-state.json";
/** Prefix of the directory an install is copied into before it is renamed into place; no runtime id can start with a dot. */
export const STAGING_DIRECTORY_PREFIX = ".staging-";
/** Prefix of a runtime directory renamed aside instead of deleted (a process may still run from it). */
export const QUARANTINE_DIRECTORY_PREFIX = ".quarantine-";
/** The manifest inside a runtime directory. */
export const MANIFEST_FILE_NAME = "runtime-manifest.json";
/** The stat-fingerprint cache inside a runtime directory (a speed-up, never an authority). */
export const VERIFIED_CACHE_FILE_NAME = ".verified.json";
/** The script at the top of every runtime directory that verifies the runtime and starts the action. */
export const LAUNCHER_SCRIPT_NAME = "launcher.mjs";
/** The single line the shims read instead of parsing the manifest: the executable, relative to the runtime directory. */
export const LAUNCH_FILE_NAME = "runtime-launch.txt";

/** POSIX shim, relative to the launcher root. */
export const POSIX_SHIM_NAME = "work-intelligence-launcher";
/** Windows shim, relative to the launcher root. */
export const WINDOWS_SHIM_NAME = "work-intelligence-launcher.cmd";

const MAX_POINTER_BYTES = 256;

/** Inputs of {@link defaultLauncherRoot}; everything comes from the caller so the function is pure. */
export interface LauncherRootInputs {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

/** The fixed paths below a launcher root. */
export interface RuntimeLayout {
  readonly root: string;
  readonly binDirectory: string;
  readonly currentFile: string;
  readonly runtimesDirectory: string;
  readonly leasesDirectory: string;
  readonly gcStateFile: string;
}

/**
 * Where the launcher root lives by default: `%LOCALAPPDATA%\WorkIntelligence\runtime` on Windows,
 * `~/Library/Application Support/WorkIntelligence/runtime` on macOS, `$XDG_DATA_HOME` (or `~/.local/share`) plus
 * `work-intelligence/runtime` elsewhere. A relative XDG_DATA_HOME is ignored, as the XDG specification requires.
 */
export function defaultLauncherRoot({ platform, env, homedir }: LauncherRootInputs): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, "AppData", "Local");
    return path.win32.join(localAppData, "WorkIntelligence", "runtime");
  }
  if (platform === "darwin") {
    return path.posix.join(homedir, "Library", "Application Support", "WorkIntelligence", "runtime");
  }
  const xdg = env.XDG_DATA_HOME;
  const dataHome = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(homedir, ".local", "share");
  return path.posix.join(dataHome, "work-intelligence", "runtime");
}

/** The fixed paths below `root`. */
export function runtimeLayout(root: string): RuntimeLayout {
  return {
    root,
    binDirectory: path.join(root, BIN_DIRECTORY_NAME),
    currentFile: path.join(root, CURRENT_FILE_NAME),
    runtimesDirectory: path.join(root, RUNTIMES_DIRECTORY_NAME),
    leasesDirectory: path.join(root, LEASES_DIRECTORY_NAME),
    gcStateFile: path.join(root, LEASES_DIRECTORY_NAME, GC_STATE_FILE_NAME),
  };
}

/** The directory of one runtime; refuses ids outside the shared charset so the result cannot leave `runtimes/`. */
export function runtimeDirectoryFor(root: string, runtimeId: string): string {
  if (!isRuntimeId(runtimeId)) {
    throw new RuntimeError("RUNTIME_POINTER_INVALID", "runtime id 含有不允許的字元或長度不正確", { actual: runtimeId });
  }
  return path.join(root, RUNTIMES_DIRECTORY_NAME, runtimeId);
}

/** Whether runtime ids that differ only in case name the same directory on this platform (Windows and macOS file systems). */
export const IDS_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** The form of a runtime id to compare by: lower case where the file system ignores case, else the id itself. */
export function runtimeIdKey(runtimeId: string, caseInsensitive: boolean = IDS_CASE_INSENSITIVE): string {
  return caseInsensitive ? runtimeId.toLowerCase() : runtimeId;
}

/** The shim an Agent's `command` should point at. */
export function launcherCommandPath(root: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(root, BIN_DIRECTORY_NAME, platform === "win32" ? WINDOWS_SHIM_NAME : POSIX_SHIM_NAME);
}

/** Reads the `current` pointer: one line, a valid runtime id, in a regular file. */
export async function readCurrentRuntimeId(root: string): Promise<string> {
  const pointer = runtimeLayout(root).currentFile;
  let text: string;
  try {
    const stat = await fs.lstat(pointer);
    if (!stat.isFile() || stat.size > MAX_POINTER_BYTES) {
      throw new RuntimeError("RUNTIME_POINTER_INVALID", "current 不是單行的一般檔案", { file: pointer });
    }
    text = await fs.readFile(pointer, "utf8");
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (isMissingError(error)) {
      throw new RuntimeError("RUNTIME_POINTER_MISSING", "找不到 current，尚未安裝或啟用任何 runtime", {
        file: pointer,
      });
    }
    throw new RuntimeError(
      "RUNTIME_POINTER_INVALID",
      "無法讀取 current",
      { file: pointer, actual: String(error) },
      { cause: error },
    );
  }
  const id = /^([^\r\n]*)\r?\n?$/.exec(text)?.[1] ?? "";
  if (!isRuntimeId(id)) {
    throw new RuntimeError("RUNTIME_POINTER_INVALID", "current 的內容不是合法的 runtime id", {
      file: pointer,
      expected: "單行，符合 [A-Za-z0-9][A-Za-z0-9._-]{0,127}",
      actual: JSON.stringify(text.slice(0, 80)),
    });
  }
  return id;
}
