import fs from "node:fs/promises";
import path from "node:path";
import { errorCode } from "../internal/error-code.js";
import { RuntimeError } from "./errors.js";
import { CURRENT_FILE_NAME, LAUNCH_FILE_NAME } from "./layout.js";
import { isRuntimeId, type RuntimeManifest } from "./manifest.js";

export interface LaunchConsistencyInput {
  readonly root: string;
  readonly runtimeId: string;
  readonly runtimeDirectory: string;
  readonly manifest: RuntimeManifest;
  readonly execPath: string;
  readonly platform: string;
  readonly warn: (message: string) => void;
}

const BYTE_ORDER_MARK = "﻿";

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
