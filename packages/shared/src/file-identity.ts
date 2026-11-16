import { realpathSync, statSync } from "node:fs";
import { parse, resolve, sep } from "node:path";

/** Physical identity of a file: the volume plus the file index on it, as decimal strings (bigint-safe, JSON-safe). */
export interface FileId {
  device: string;
  inode: string;
}

/**
 * Why a file could not be identified. The kinds stay distinct because the desktop shell reacts differently:
 * `missing` may offer a new database, `offline` (an unplugged drive, a dropped network share) must never fall back,
 * `denied` needs a permission fix, `unreadable` is everything else (not a directory, symlink loop, ...).
 */
export type FileIdentityErrorKind = "missing" | "denied" | "unreadable" | "offline";

export interface FileIdentity {
  /** `fs.realpathSync.native` of the path: symlinks resolved, Windows 8.3 and case normalised by the OS. */
  realPath: string;
  /** `null` when the file system reports no usable index (ino 0, as some network or FUSE mounts do). */
  fileId: FileId | null;
}

export type FileIdentityResult =
  { ok: true; identity: FileIdentity } | { ok: false; kind: FileIdentityErrorKind; code: string; message: string };

/** Hooks so tests can drive every branch without a real broken volume. */
export interface FileIdentityDependencies {
  realpath?: (path: string) => string;
  stat?: (path: string) => { dev: bigint; ino: bigint };
  /** Whether the volume root of the path exists; used to tell an absent drive from a missing file. */
  volumeRootExists?: (path: string) => boolean;
}

// Errors that mean "the storage is not there right now" rather than "this file is not there".
const OFFLINE_CODES = new Set(["ENXIO", "ENODEV", "EIO", "ESTALE", "ENOTCONN", "ENETDOWN", "ENETUNREACH", "EHOSTDOWN"]);
const DENIED_CODES = new Set(["EACCES", "EPERM"]);

function errorCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}

function defaultVolumeRootExists(path: string): boolean {
  try {
    statSync(parse(resolve(path)).root);
    return true;
  } catch {
    return false;
  }
}

/**
 * Heuristics, in order: EACCES/EPERM is `denied`; ENXIO/ENODEV/EIO/ESTALE/ENOTCONN/network-down codes are `offline`;
 * ENOENT is `missing` unless the volume root itself is gone (an unplugged `E:\` or a vanished `/Volumes/X` mount
 * point reports ENOENT for the file too), which is `offline`; everything else (ENOTDIR, ELOOP, ENAMETOOLONG, ...)
 * is `unreadable`. On POSIX the root is `/`, which always exists, so a missing mount under `/Volumes` or `/mnt`
 * stays `missing` here; callers that know their mount roots may pass `volumeRootExists`.
 */
export function classifyFileError(
  error: unknown,
  path: string,
  volumeRootExists = defaultVolumeRootExists,
): FileIdentityErrorKind {
  const code = errorCode(error);
  if (DENIED_CODES.has(code)) return "denied";
  if (OFFLINE_CODES.has(code)) return "offline";
  if (code === "ENOENT") return volumeRootExists(path) ? "missing" : "offline";
  return "unreadable";
}

/**
 * Reads the composite identity (real path + device/inode) of a file without opening or writing it. A result object is
 * returned instead of throwing so callers can branch on the error kind.
 */
export function readFileIdentity(path: string, dependencies: FileIdentityDependencies = {}): FileIdentityResult {
  const realpath = dependencies.realpath ?? ((value: string) => realpathSync.native(value));
  const stat = dependencies.stat ?? ((value: string) => statSync(value, { bigint: true }));
  try {
    const realPath = realpath(path);
    const { dev, ino } = stat(realPath);
    return {
      ok: true,
      identity: { realPath, fileId: ino === 0n ? null : { device: dev.toString(), inode: ino.toString() } },
    };
  } catch (error) {
    return {
      ok: false,
      kind: classifyFileError(error, path, dependencies.volumeRootExists),
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** True when both ids are present and name the same physical file; an unavailable id never matches. */
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  if (!a.fileId || !b.fileId) return false;
  return a.fileId.device === b.fileId.device && a.fileId.inode === b.fileId.inode;
}

/**
 * Normalises a path for string comparison: absolute, no trailing separator (except a root), and case-folded on win32
 * only. macOS and Linux are NOT folded: APFS/HFS+ are usually case-insensitive but can be case-sensitive per volume,
 * so a blind fold could merge two different files; use {@link sameFileIdentity} for those instead.
 */
export function normalizePathForCompare(path: string, platform: NodeJS.Platform = process.platform): string {
  let value = resolve(path);
  const root = parse(value).root;
  while (value.length > root.length && value.endsWith(sep)) value = value.slice(0, -1);
  return platform === "win32" ? value.toLowerCase() : value;
}
