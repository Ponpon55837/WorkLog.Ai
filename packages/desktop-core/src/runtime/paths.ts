import path from "node:path";

const MAX_PATH_LENGTH = 1024;

/**
 * Why `value` is not a normalized, relative POSIX path, or undefined when it is one. Manifests are read on every OS,
 * so the rules reject what any of them would resolve to somewhere else: absolute forms, `..`, backslashes, drive
 * letters and NTFS stream markers (`:`), NUL, empty or dot segments, and trailing dots or spaces (Windows drops them,
 * so `a.` and `a` would be the same file).
 */
export function relativePathProblem(value: string): string | undefined {
  if (value.length === 0) return "path is empty";
  if (value.length > MAX_PATH_LENGTH) return `path is longer than ${MAX_PATH_LENGTH} characters`;
  if (value.includes("\0")) return "path contains NUL";
  if (value.includes("\\")) return "path contains a backslash";
  if (value.includes(":")) return "path contains a colon (drive letter or stream marker)";
  if (value.startsWith("/")) return "path is absolute";
  for (const segment of value.split("/")) {
    if (segment === "") return "path has an empty segment";
    if (segment === "." || segment === "..") return "path has a dot segment";
    if (segment.endsWith(".") || segment.endsWith(" ")) return "path segment ends with a dot or space";
  }
  return undefined;
}

/**
 * Why a symlink at `linkPath` pointing to `target` is not allowed, or undefined. Targets stay relative and, resolved
 * lexically from the link's directory, inside the runtime. Every link passing this check stays inside on its own, so a
 * chain of such links cannot leave the runtime either.
 */
export function symlinkTargetProblem(linkPath: string, target: string): string | undefined {
  if (target.length === 0) return "symlink target is empty";
  if (target.includes("\0") || target.includes("\\") || target.includes(":"))
    return "symlink target has a forbidden character";
  if (target.startsWith("/")) return "symlink target is absolute";
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), target));
  if (resolved === "." || resolved === ".." || resolved.startsWith("../")) return "symlink target leaves the runtime";
  return undefined;
}

/** Key for duplicate detection on case-insensitive, normalization-insensitive file systems (Windows, macOS). */
export function casefoldKey(value: string): string {
  return value.normalize("NFD").toLowerCase();
}
