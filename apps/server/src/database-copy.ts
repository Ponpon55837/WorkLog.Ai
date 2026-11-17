import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeSnapshot } from "@work-intelligence/storage";
import { preflightDatabase, type DatabaseIdentity } from "./database-preflight.js";

/** How a consistent copy of a database came out (the child's `copy-result` status, plus the copy's identity on `ok`). */
export type DatabaseCopyStatus = "ok" | "no-space" | "target-exists" | "integrity-failed" | "failed";

export interface DatabaseCopyResult {
  status: DatabaseCopyStatus;
  /** The copy's identity, read back after it was checked; only with `ok`. */
  identity?: DatabaseIdentity;
  /** A fixed text, never a path or an SQLite message. */
  detail?: string;
}

export interface DatabaseCopyOptions {
  /** Checks the staged copy before it is published; defaults to storage's `PRAGMA quick_check`. Injectable for tests. */
  verifySnapshot?: (path: string, label: string) => void;
}

const SQLITE_FULL = 13;

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

function outOfSpace(error: unknown): boolean {
  const { code, errcode, message } = (error ?? {}) as { code?: unknown; errcode?: unknown; message?: unknown };
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  if (typeof errcode === "number" && (errcode & 0xff) === SQLITE_FULL) return true;
  return typeof message === "string" && /database or disk is full|no space left/i.test(message);
}

function describeFailure(error: unknown): DatabaseCopyResult {
  if (outOfSpace(error)) return { status: "no-space", detail: "the target disk is full" };
  const message = error instanceof Error ? error.message : "";
  if (/integrity check/i.test(message))
    return { status: "integrity-failed", detail: "the copy failed its integrity check" };
  if (/target already exists/i.test(message)) return { status: "target-exists", detail: "the target already exists" };
  return { status: "failed", detail: "the copy could not be made" };
}

function removeBestEffort(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch {
      // A leftover sidecar of a copy that was never published is harmless.
    }
  }
}

/**
 * Makes a consistent copy of `source` at `target` for the repair page's 「複製到本機磁碟並改用」 (DT-08). The source is
 * opened read-only and is never migrated, written or removed (the shared WAL index may be created beside it, as for any
 * read-only open). The copy is `VACUUM INTO` a private staging file, checked with `PRAGMA quick_check` and only then
 * linked into place without replacing anything, so a bad or partial copy never appears at `target`. `target` must not
 * exist. Never throws: every failure is a status.
 */
export async function copyDatabaseConsistently(
  source: string,
  target: string,
  options: DatabaseCopyOptions = {},
): Promise<DatabaseCopyResult> {
  if (exists(target)) return { status: "target-exists", detail: "the target already exists" };
  if (!exists(source)) return { status: "failed", detail: "the source database is missing" };
  let database: DatabaseSync | undefined;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    database = new DatabaseSync(source, { readOnly: true });
    writeSnapshot(database, target, options.verifySnapshot);
  } catch (error) {
    return describeFailure(error);
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a connection that failed to open cleanly must not mask the result.
    }
  }
  const read = await preflightDatabase(target);
  if (read.status !== "ok" || !read.identity) {
    // Our own file, made a moment ago: take it back rather than leave a copy nobody can open.
    removeBestEffort(target);
    return { status: "integrity-failed", detail: "the copy could not be read back" };
  }
  return { status: "ok", identity: read.identity };
}
