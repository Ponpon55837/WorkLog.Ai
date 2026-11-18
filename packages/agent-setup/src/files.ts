import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, posix, win32 } from "node:path";
import type { ReadFileResult } from "./types.js";

/** A target no longer holds the bytes the plan was made against; nothing of ours was written to it. */
export class FingerprintMismatchError extends Error {
  constructor(readonly path: string) {
    super("fingerprint-mismatch");
    this.name = "FingerprintMismatchError";
  }
}

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

/**
 * `~`-relative form of a path under the home directory. `platform` selects the path rules (Windows separators and
 * case-insensitive drive paths); POSIX output is unchanged.
 */
export function displayPath(path: string, homeDirectory: string, platform: NodeJS.Platform = process.platform): string {
  const flavor = platform === "win32" ? win32 : posix;
  const absoluteHome = flavor.resolve(homeDirectory);
  const absolutePath = flavor.resolve(path);
  const comparable = (value: string): string => (platform === "win32" ? value.toLowerCase() : value);
  if (comparable(absolutePath) === comparable(absoluteHome)) return "~";
  const prefix = absoluteHome.endsWith(flavor.sep) ? absoluteHome : absoluteHome + flavor.sep;
  return comparable(absolutePath).startsWith(comparable(prefix))
    ? "~" + flavor.sep + absolutePath.slice(prefix.length)
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

/**
 * Best-effort fsync of a directory so a just-completed rename or link survives a power loss. Windows cannot open a
 * directory and other platforms may refuse, in which case the file itself is already durable.
 */
export function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  try {
    const descriptor = openSync(directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Directory sync is an optimisation of durability, never a reason to fail the write.
  }
}

/** Creates `path` exclusively and fsyncs it, so a rename of it never publishes bytes that are still in the page cache. */
function writeSyncedFile(path: string, bytes: Buffer, mode: number): void {
  const descriptor = openSync(path, "wx", mode);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Errors a Windows file lock raises while an antivirus scanner or the search indexer briefly holds a file. */
const RENAME_RETRYABLE_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES"]);
/** Waits before each retry: five attempts, 0.75 s in all. */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400];

/** `renameSync` that tries again when a file lock refuses it; any other error, and the last refusal, is thrown. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      const { code } = (error ?? {}) as { code?: unknown };
      if (delay === undefined || typeof code !== "string" || !RENAME_RETRYABLE_CODES.has(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

/**
 * Temp file (fsynced), fingerprint re-check, rename, directory sync. When `expectedFingerprint` is given the target is
 * re-read after the temp file is complete and the rename is skipped, with a {@link FingerprintMismatchError}, if it
 * changed. That narrows the check-to-rename window to a few microseconds but cannot close it: POSIX and Windows offer
 * no compare-and-swap rename, so a writer that lands between the re-read and the rename still loses its edit (ADR-14).
 */
export function writeAtomically(path: string, bytes: Buffer, mode: number, expectedFingerprint?: string): void {
  const temporaryPath = `${path}.work-intelligence.tmp-${randomUUID()}`;
  try {
    writeSyncedFile(temporaryPath, bytes, mode);
    if (expectedFingerprint !== undefined && fingerprintOf(readCurrent(path)) !== expectedFingerprint) {
      throw new FingerprintMismatchError(path);
    }
    renameWithRetry(temporaryPath, path);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Keep the original failure; temporary-file cleanup is best effort.
    }
    throw error;
  }
  syncDirectory(dirname(path));
}

/** Removes a file only if it still holds the expected bytes; same residual race as {@link writeAtomically}. */
export function removeAtomically(path: string, expectedFingerprint: string): void {
  if (fingerprintOf(readCurrent(path)) !== expectedFingerprint) throw new FingerprintMismatchError(path);
  if (existsSync(path)) unlinkSync(path);
  syncDirectory(dirname(path));
}

export function writeExclusiveAtomically(path: string, bytes: Buffer): void {
  const temporaryPath = `${path}.work-intelligence.tmp-${randomUUID()}`;
  let linked = false;
  try {
    writeSyncedFile(temporaryPath, bytes, 0o600);
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
  syncDirectory(dirname(path));
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
