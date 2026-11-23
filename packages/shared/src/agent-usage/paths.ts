import process from "node:process";

const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/;
const DRIVE_ROOT = /^[A-Za-z]:$/;

/**
 * Windows compares paths case-insensitively; the same rule `sources.ts` applies to Claude folder names and cwd. The
 * platform is a parameter so tests can check both rules on any runner.
 */
export function foldPath(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

/**
 * Platform-independent spelling of an absolute path: `\` and `/` are both separators, repeated separators, `.` and
 * `..` segments and a trailing separator are dropped (`/` and `C:` stay as the roots). Relative paths give null. Case
 * is kept; `foldPath` is applied when comparing, so the same stored value works on any host.
 */
export function normalizePath(value: string): string | null {
  if (!ABSOLUTE.test(value) || value.includes("\0")) return null;
  const drive = /^[A-Za-z]:/.test(value) ? value.slice(0, 2) : "";
  const parts: string[] = [];
  for (const part of value.slice(drive.length).split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  if (parts.length === 0) return drive === "" ? "/" : drive;
  return `${drive}/${parts.join("/")}`;
}

/** The parent of a normalised path; a root is its own parent. */
export function dirOf(path: string): string {
  if (path === "/" || DRIVE_ROOT.test(path)) return path;
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/** Strict ancestors of an absolute path, nearest first, normalised; empty for a relative path. */
export function ancestorsOf(value: string): string[] {
  const ancestors: string[] = [];
  let current = normalizePath(value);
  while (current !== null) {
    const parent = dirOf(current);
    if (parent === current) break;
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

/** Whether `path` is `root` or lies below it; both are normalised and already folded. */
export function isPathInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

/** Spelling of a normalised directory for `encodeClaudeProjectDir`: a drive root keeps its separator (`C:\`). */
export function nativeSpelling(path: string): string {
  return DRIVE_ROOT.test(path) ? `${path}/` : path;
}
