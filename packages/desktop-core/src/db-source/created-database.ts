import { lstatSync, rmSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { readFileIdentity } from "@work-intelligence/shared/file-identity";
import { compareDatabaseIdentity } from "./identity-compare.js";
import type { DatabaseIdentity } from "./types.js";

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function lstatMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ENOENT";
  }
}

export function missingParentDirectories(path: string): string[] {
  const missing: string[] = [];
  let directory = dirname(path);
  while (lstatMissing(directory)) {
    missing.push(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return missing;
}

export function removeCreatedDatabase(
  path: string,
  created: DatabaseIdentity,
  createdDirectories: readonly string[],
): boolean {
  const located = readFileIdentity(path);
  if (!located.ok) return false;
  const actual: DatabaseIdentity = { ...located.identity, lineageId: created.lineageId };
  if (!compareDatabaseIdentity(created, actual).same) return false;
  try {
    rmSync(path, { force: true });
  } catch {
    return false;
  }
  for (const suffix of SIDECAR_SUFFIXES) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // A leftover sidecar of a removed database is harmless; the directory step below then simply stays.
    }
  }
  removeEmptyDirectories(createdDirectories);
  return true;
}

export function removeEmptyDirectories(directories: readonly string[]): void {
  for (const directory of directories) {
    try {
      rmdirSync(directory);
    } catch {
      return;
    }
  }
}
