import { RUNTIME_CURRENT_FILE_NAME, RUNTIME_DIRECTORIES_NAME } from "@work-intelligence/shared/agent-observations";
import fs from "node:fs/promises";
import path from "node:path";
import { isMissingError } from "../internal/error-code.js";
import { RuntimeError } from "./errors.js";
import { isRuntimeId } from "./manifest.js";

export const CURRENT_FILE_NAME = RUNTIME_CURRENT_FILE_NAME;
export const BIN_DIRECTORY_NAME = "bin";
export const RUNTIMES_DIRECTORY_NAME = RUNTIME_DIRECTORIES_NAME;
export const LEASES_DIRECTORY_NAME = "leases";
/** Inside the leases folder so writing it never changes the launcher root's change time, which the Windows ACL stamp covers. */
export const GC_STATE_FILE_NAME = "gc-state.json";
export const STAGING_DIRECTORY_PREFIX = ".staging-";
export const QUARANTINE_DIRECTORY_PREFIX = ".quarantine-";
export const MANIFEST_FILE_NAME = "runtime-manifest.json";
export const VERIFIED_CACHE_FILE_NAME = ".verified.json";
export const LAUNCHER_SCRIPT_NAME = "launcher.mjs";
export const LAUNCH_FILE_NAME = "runtime-launch.txt";

export const POSIX_SHIM_NAME = "work-intelligence-launcher";
export const WINDOWS_SHIM_NAME = "work-intelligence-launcher.cmd";

const MAX_POINTER_BYTES = 256;

export interface LauncherRootInputs {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

export interface RuntimeLayout {
  readonly root: string;
  readonly binDirectory: string;
  readonly currentFile: string;
  readonly runtimesDirectory: string;
  readonly leasesDirectory: string;
  readonly gcStateFile: string;
}

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

export function runtimeDirectoryFor(root: string, runtimeId: string): string {
  if (!isRuntimeId(runtimeId)) {
    throw new RuntimeError("RUNTIME_POINTER_INVALID", "runtime id 含有不允許的字元或長度不正確", { actual: runtimeId });
  }
  return path.join(root, RUNTIMES_DIRECTORY_NAME, runtimeId);
}

export const IDS_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export function runtimeIdKey(runtimeId: string, caseInsensitive: boolean = IDS_CASE_INSENSITIVE): string {
  return caseInsensitive ? runtimeId.toLowerCase() : runtimeId;
}

export function launcherCommandPath(root: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(root, BIN_DIRECTORY_NAME, platform === "win32" ? WINDOWS_SHIM_NAME : POSIX_SHIM_NAME);
}

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
