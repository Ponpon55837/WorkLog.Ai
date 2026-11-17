import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ReadFileResult } from "./types.js";

export const JSON_OBJECT = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The fingerprint of a file that does not exist; every other fingerprint is a sha256 hex digest. */
export const ABSENT_FINGERPRINT = "absent";

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** sha256 of the bytes, or {@link ABSENT_FINGERPRINT} for a missing file. */
export function fingerprintOf(bytes: Buffer | null): string {
  return bytes === null ? ABSENT_FINGERPRINT : sha256(bytes);
}

/** Hash that ignores CRLF/LF differences, so a Windows checkout still matches the committed text. */
export function lineEndingNeutralSha256(value: Buffer): string {
  return sha256(value.toString("utf8").replaceAll("\r\n", "\n"));
}

export function readRegularFile(path: string): ReadFileResult {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { bytes: null, mode: 0o600, conflict: `${path} 不是一般檔案，保留且拒絕修改。` };
    }
    return { bytes: readFileSync(path), mode: stats.mode & 0o777 };
  } catch (error) {
    if (JSON_OBJECT(error) && error.code === "ENOENT") {
      return { bytes: null, mode: 0o600 };
    }
    return { bytes: null, mode: 0o600, conflict: `無法讀取 ${path}，保留且拒絕修改。` };
  }
}

export function displayPath(path: string, homeDirectory: string): string {
  const absoluteHome = resolve(homeDirectory);
  const absolutePath = resolve(path);
  return absolutePath === absoluteHome
    ? "~"
    : absolutePath.startsWith(absoluteHome + "/")
      ? "~" + absolutePath.slice(absoluteHome.length)
      : absolutePath;
}

export function backupPathFor(path: string, before: Buffer, now: Date): string {
  const stamp = now.toISOString().replaceAll(/[-:.]/g, "");
  const root = `${path}.work-intelligence.backup-${stamp}-${sha256(before).slice(0, 8)}`;
  let candidate = root;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${root}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function readCurrent(path: string): Buffer | null {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("symbolic link");
    return readFileSync(path);
  } catch (error) {
    if (JSON_OBJECT(error) && error.code === "ENOENT") return null;
    throw new Error(`套用前無法安全讀取 ${path}。`, { cause: error });
  }
}

export function writeAtomically(path: string, bytes: Buffer, mode: number): void {
  const temporaryPath = `${path}.work-intelligence.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx", mode });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Keep the original failure; temporary-file cleanup is best effort.
    }
    throw error;
  }
}

export function writeExclusiveAtomically(path: string, bytes: Buffer): void {
  const temporaryPath = `${path}.work-intelligence.tmp-${randomUUID()}`;
  let linked = false;
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    linkSync(temporaryPath, path);
    linked = true;
    unlinkSync(temporaryPath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
      if (linked) rmSync(path, { force: true });
    } catch {
      // Keep the original failure; temporary-file cleanup is best effort.
    }
    throw error;
  }
}

export function ensureDirectory(path: string, createdDirectories: Set<string>): void {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(path, { recursive: true });
  for (const directory of missing) createdDirectories.add(directory);
}
