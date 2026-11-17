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

/**
 * The directories above `path` that do not exist yet, deepest first: exactly the ones creating the file there would
 * make. Read before anything is created, so a rollback never touches a directory that was already there.
 */
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

/**
 * Undoes a database this process created for a start that then failed: the file and its WAL/SHM/journal siblings, and
 * the directories that did not exist before when they are empty again. The file is removed only when it is still the one
 * `created` names (same path and file id); anything else at the path is someone else's and is left alone. Returns whether
 * the database file was removed. Never throws.
 */
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

/** Removes `directories` (deepest first) while each one is empty; stops at the first that is not or cannot be removed. */
export function removeEmptyDirectories(directories: readonly string[]): void {
  for (const directory of directories) {
    try {
      rmdirSync(directory);
    } catch {
      return;
    }
  }
}
