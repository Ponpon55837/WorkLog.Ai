import fs from "node:fs/promises";
import path from "node:path";
import { errorCode } from "../internal/error-code.js";
import { RuntimeError } from "./errors.js";
import { CURRENT_FILE_NAME, LAUNCH_FILE_NAME } from "./layout.js";
import { isRuntimeId, type RuntimeManifest } from "./manifest.js";

/** What the launcher knows about itself when it checks that the shim started it the way the manifest says. */
export interface LaunchConsistencyInput {
  readonly root: string;
  readonly runtimeId: string;
  readonly runtimeDirectory: string;
  readonly manifest: RuntimeManifest;
  /** `process.execPath` of the running launcher. */
  readonly execPath: string;
  readonly platform: string;
  /** Receives warnings that do not stop the launch. */
  readonly warn: (message: string) => void;
}

const BYTE_ORDER_MARK = "﻿";

/**
 * The executable named by the text of `runtime-launch.txt`: one line, with an optional byte order mark and a trailing
 * CRLF, LF or CR removed. Anything else (no line, two lines, a blank line) is refused: the file is read by a shim
 * that checks nothing, so its exact shape is checked here, where the file has already been hashed.
 */
export function parseLaunchFile(text: string): string {
  const body = (text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text).replace(/\r\n?$|\n$/, "");
  if (body === "" || /[\r\n]/.test(body)) {
    throw new RuntimeError("RUNTIME_MANIFEST_INVALID", `${LAUNCH_FILE_NAME} 必須恰好一行 executable 路徑`, {
      file: LAUNCH_FILE_NAME,
      actual: JSON.stringify(text.slice(0, 80)),
    });
  }
  return body;
}

/** The id in the text of a `current` pointer: byte order mark, line ends and surrounding spaces are ignored. */
export function parsePointerText(text: string): string {
  const id = (text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text).trim();
  if (!isRuntimeId(id)) {
    throw new RuntimeError("RUNTIME_POINTER_INVALID", "current 的內容不是合法的 runtime id", {
      file: CURRENT_FILE_NAME,
      expected: "單行，符合 [A-Za-z0-9][A-Za-z0-9._-]{0,127}",
      actual: JSON.stringify(text.slice(0, 80)),
    });
  }
  return id;
}

/** File names compare without case on Windows and (by default) macOS. */
function pathKey(value: string, platform: string): string {
  return platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
}

async function realpathOf(target: string): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch {
    return undefined;
  }
}

async function readText(file: string, name: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    const missing = errorCode(error) === "ENOENT";
    throw new RuntimeError(
      missing && name === CURRENT_FILE_NAME ? "RUNTIME_POINTER_MISSING" : "RUNTIME_MANIFEST_INVALID",
      missing ? `找不到 ${name}` : `無法讀取 ${name}`,
      { file, actual: String(error) },
      { cause: error },
    );
  }
}

/**
 * The checks that tie the fixed shim to the verified runtime. The shim validates nothing: it starts whatever executable
 * `runtime-launch.txt` names with whatever `current` points at. By the time this runs, the launcher IS that process, so
 * it can compare what it really is with what the manifest says:
 *
 * 1. the runtime id taken from where the launcher lives is a legal id (this also bounds its length);
 * 2. `runtime-launch.txt` (hashed by the manifest) holds exactly the manifest's executable;
 * 3. `process.execPath` is that executable (real paths, case-folded on Windows and macOS), so a launch file or `current`
 *    that pointed the shim at some other binary is noticed;
 * 4. `current` holds a legal id. When it names a different runtime this only warns: an update may be switching it.
 *
 * Limit: step 3 runs inside the process that was started, so it cannot undo what a swapped executable did before it
 * got here; it catches mistakes and a mismatched pointer, not an attacker who already replaced the executable.
 */
export async function checkLaunchConsistency(input: LaunchConsistencyInput): Promise<void> {
  const { root, runtimeId, runtimeDirectory, manifest } = input;
  if (!isRuntimeId(runtimeId)) {
    throw new RuntimeError("RUNTIME_POINTER_INVALID", "runtime id 含有不允許的字元或長度不正確", { actual: runtimeId });
  }

  const launchFile = path.join(runtimeDirectory, LAUNCH_FILE_NAME);
  const executable = parseLaunchFile(await readText(launchFile, LAUNCH_FILE_NAME));
  if (executable !== manifest.executable) {
    throw new RuntimeError("RUNTIME_MANIFEST_INVALID", `${LAUNCH_FILE_NAME} 與 manifest 的 executable 不同`, {
      file: LAUNCH_FILE_NAME,
      expected: manifest.executable,
      actual: executable,
    });
  }

  const expected = await realpathOf(path.join(runtimeDirectory, manifest.executable));
  const actual = await realpathOf(input.execPath);
  if (
    expected === undefined ||
    actual === undefined ||
    pathKey(expected, input.platform) !== pathKey(actual, input.platform)
  ) {
    throw new RuntimeError("RUNTIME_FILE_TAMPERED", "shim 啟動的不是 manifest 指定的 executable", {
      file: manifest.executable,
      expected: expected ?? "(無法解析)",
      actual: actual ?? input.execPath,
    });
  }

  const pointed = parsePointerText(await readText(path.join(root, CURRENT_FILE_NAME), CURRENT_FILE_NAME));
  if (pointed !== runtimeId) {
    input.warn(
      `警告：current 指向 ${pointed}，這個 launcher 屬於 ${runtimeId}（可能正在更新切換），仍照此 runtime 執行。\n`,
    );
  }
}
