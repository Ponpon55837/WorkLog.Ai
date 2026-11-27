import process from "node:process";

const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/;
const DRIVE_ROOT = /^[A-Za-z]:$/;

/** Windows compares paths case-insensitively; platform is a parameter so tests cover both rules. */
export function foldPath(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

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

export function dirOf(path: string): string {
  if (path === "/" || DRIVE_ROOT.test(path)) return path;
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

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

export function isPathInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

export function nativeSpelling(path: string): string {
  return DRIVE_ROOT.test(path) ? `${path}/` : path;
}
