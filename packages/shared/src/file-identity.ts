import { realpathSync, statSync } from "node:fs";
import { parse, resolve, sep } from "node:path";

export interface FileId {
  device: string;
  inode: string;
}

/** `missing` may offer a new database; `offline` (unplugged drive, dropped share) must never fall back. */
export type FileIdentityErrorKind = "missing" | "denied" | "unreadable" | "offline";

export interface FileIdentity {
  realPath: string;
  fileId: FileId | null;
}

export type FileIdentityResult =
  { ok: true; identity: FileIdentity } | { ok: false; kind: FileIdentityErrorKind; code: string; message: string };

export interface FileIdentityDependencies {
  realpath?: (path: string) => string;
  stat?: (path: string) => { dev: bigint; ino: bigint };
  volumeRootExists?: (path: string) => boolean;
}

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

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  if (!a.fileId || !b.fileId) return false;
  return a.fileId.device === b.fileId.device && a.fileId.inode === b.fileId.inode;
}

/** Compared as bigint strings on purpose: Windows file ids are 64-bit and JS numbers above 2^53 can collide. */
export function pathsReferToSameFile(
  left: string,
  right: string,
  dependencies: FileIdentityDependencies = {},
): boolean {
  const a = readFileIdentity(left, dependencies);
  const b = readFileIdentity(right, dependencies);
  if (!a.ok || !b.ok) return false;
  return a.identity.realPath === b.identity.realPath || sameFileIdentity(a.identity, b.identity);
}

/**
 * Case-folded on win32 only: APFS/HFS+ can be case-sensitive per volume, so a fold could merge different files. Use
 * sameFileIdentity there.
 */
export function normalizePathForCompare(path: string, platform: NodeJS.Platform = process.platform): string {
  let value = resolve(path);
  const root = parse(value).root;
  while (value.length > root.length && value.endsWith(sep)) value = value.slice(0, -1);
  return platform === "win32" ? value.toLowerCase() : value;
}
