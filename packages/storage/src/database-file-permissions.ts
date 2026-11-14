import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SQLITE_SIDECAR_SUFFIXES = ["", "-wal", "-shm"];

function enforcesPosixModes(databasePath: string): boolean {
  return process.platform !== "win32" && databasePath !== ":memory:";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Creates the data directory and an empty database file with owner-only modes, without touching existing directories. */
export function prepareDatabaseFiles(databasePath: string): void {
  const directory = dirname(databasePath);
  if (!enforcesPosixModes(databasePath)) {
    mkdirSync(directory, { recursive: true });
    return;
  }
  // A recursive mkdir gives every level it creates this mode and leaves existing parents (home, shared dirs) alone.
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try {
    // Creating the file private up front leaves no window where it is readable under a permissive umask.
    closeSync(openSync(databasePath, "wx", PRIVATE_FILE_MODE));
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

/**
 * Narrows the database and its WAL/SHM files to owner-only. Only files this user owns are changed, and a refusal
 * is ignored: a failed tighten must never stop the database from opening (the doctor reports wide modes).
 * SQLite creates new -wal/-shm files with the database file's mode, so a private database keeps them private.
 */
export function tightenDatabaseFiles(databasePath: string): void {
  if (!enforcesPosixModes(databasePath) || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const path = databasePath + suffix;
    try {
      // lstat: never follow a planted symlink to chmod some other file this user owns.
      const stats = lstatSync(path, { throwIfNoEntry: false });
      if (!stats?.isFile() || stats.uid !== uid || (stats.mode & 0o077) === 0) continue;
      chmodSync(path, PRIVATE_FILE_MODE);
    } catch {
      // EPERM/ENOENT races: leave the file as it is.
    }
  }
}
