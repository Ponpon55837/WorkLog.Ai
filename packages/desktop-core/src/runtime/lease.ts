import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { errorCode } from "../internal/error-code.js";
import { GC_STATE_FILE_NAME, LEASES_DIRECTORY_NAME, runtimeIdKey } from "./layout.js";
import { isRuntimeId } from "./manifest.js";

/** What a launcher process keeps while it runs from a runtime; operations are synchronous so an `exit` handler can use them. */
export interface LeaseHandle {
  /** Moves the lease's modification time to now: "this process is still alive". Throws when the write is refused. */
  refresh(): void;
  /** Deletes the lease file; never throws. */
  remove(): void;
}

/** The lease files of one runtime as the garbage collector saw them: file name to modification time (ms). */
export type LeaseObservation = ReadonlyMap<string, number>;

/** How often a long-lived launcher action (`mcp`, `serve`) refreshes its lease. */
export const LEASE_HEARTBEAT_MS = 60_000;
/** Every lease file name ends with this; nothing else in a lease directory counts as a lease. */
export const LEASE_FILE_SUFFIX = ".lease";

const LEASE_FILE_MODE = 0o600;
const LEASE_DIRECTORY_MODE = 0o700;

/** The directory that holds the leases of one runtime: `<root>/leases/<runtimeId>`. */
export function leaseDirectoryFor(root: string, runtimeId: string): string {
  return path.join(root, LEASES_DIRECTORY_NAME, runtimeId);
}

/** Thrown (with this `code`) when `<root>/leases` or a runtime's lease folder is not a real directory; the lease is then skipped. */
export const LEASE_DIRECTORY_UNSAFE = "LEASE_DIRECTORY_UNSAFE";

/** What `<root>/leases` (or a lease folder) is, read with `lstat`: nothing, a real directory, or anything else (a link, a file, unreadable). */
export type LeaseDirectoryState = "missing" | "real" | "foreign";

function unsafeLeaseDirectory(): Error {
  return Object.assign(new Error("lease directory is not a real directory"), { code: LEASE_DIRECTORY_UNSAFE });
}

/**
 * Whether `directory` is a real directory, never following a link: a symbolic link or, on Windows, a junction (Node
 * reports both through `isSymbolicLink` on `lstat`) is `foreign`, as is a file or anything that cannot be read.
 */
export async function leaseDirectoryState(directory: string): Promise<LeaseDirectoryState> {
  try {
    const stat = await fsp.lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "real" : "foreign";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "foreign";
  }
}

function leaseDirectoryStateSync(directory: string): LeaseDirectoryState {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "real" : "foreign";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "foreign";
  }
}

/** Makes sure `directory` is a real directory, creating it (non-recursive) when missing; throws when it is anything else. */
function ensureRealDirectorySync(directory: string): void {
  let state = leaseDirectoryStateSync(directory);
  if (state === "missing") {
    try {
      fs.mkdirSync(directory, { mode: LEASE_DIRECTORY_MODE });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    state = leaseDirectoryStateSync(directory);
  }
  if (state !== "real") throw unsafeLeaseDirectory();
}

/**
 * Makes `<root>/leases/<runtimeId>` ready for a new file. The root may be reached through a link (its target is what
 * counts), but `leases` and the runtime's folder below it must be real directories: a link there would send the lease
 * file wherever it points. Missing folders are made one level at a time, never recursively.
 */
function prepareLeaseDirectory(root: string, runtimeId: string): string {
  if (!fs.statSync(root).isDirectory()) throw unsafeLeaseDirectory();
  ensureRealDirectorySync(path.join(root, LEASES_DIRECTORY_NAME));
  const directory = leaseDirectoryFor(root, runtimeId);
  ensureRealDirectorySync(directory);
  return directory;
}

function writeLeaseFile(file: string, action: string): void {
  const descriptor = fs.openSync(file, "wx", LEASE_FILE_MODE);
  try {
    fs.writeSync(descriptor, JSON.stringify({ action, createdAt: new Date().toISOString() }));
  } catch (error) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Nothing more can be done; the leftover is a stale lease the collector removes.
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Creates the lease of this process: `<root>/leases/<runtimeId>/<random hex>.lease`, exclusively, owner-only, holding
 * only the action and the creation time (no path, no arguments, nothing about the project). One attempt, no retry, and
 * synchronous so the launcher pays for it once and cannot be kept waiting. The `leases` folder and the runtime's folder
 * are checked with `lstat` first and are never followed when they are links. Throws when the file cannot be created
 * (a read-only home, an Agent sandbox, a linked folder); the caller decides that this never stops the action.
 *
 * `refresh` creates the file again, once, when it finds it missing (a cleanup of orphan lease folders can race with a
 * runtime that was not installed yet), instead of silently leaving the process without a lease.
 */
export function createLease(root: string, runtimeId: string, action: string): LeaseHandle {
  const directory = prepareLeaseDirectory(root, runtimeId);
  const file = path.join(directory, `${randomBytes(8).toString("hex")}${LEASE_FILE_SUFFIX}`);
  writeLeaseFile(file, action);
  let recreated = false;
  return {
    refresh: () => {
      const now = new Date();
      try {
        fs.utimesSync(file, now, now);
      } catch (error) {
        if (errorCode(error) !== "ENOENT" || recreated) throw error;
        recreated = true;
        prepareLeaseDirectory(root, runtimeId);
        writeLeaseFile(file, action);
      }
    },
    remove: () => {
      try {
        fs.unlinkSync(file);
      } catch {
        // Already gone, or the directory is read-only now: a stale lease is harmless.
      }
    },
  };
}

/**
 * The lease files in `directory` with their modification times, read with `lstat`: only regular files whose name ends in
 * `.lease` count, a link or anything else is ignored and never followed. A missing or unreadable directory has no leases.
 */
export async function observeLeases(directory: string): Promise<LeaseObservation> {
  const found = new Map<string, number>();
  if ((await leaseDirectoryState(directory)) !== "real") return found;
  let names: string[];
  try {
    names = await fsp.readdir(directory);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!name.endsWith(LEASE_FILE_SUFFIX)) continue;
    try {
      const stat = await fsp.lstat(path.join(directory, name));
      if (stat.isFile()) found.set(name, stat.mtimeMs);
    } catch {
      // Removed meanwhile.
    }
  }
  return found;
}

/** Whether `directory` exists as something other than a real directory (a link, a file): its leases cannot be trusted or followed. */
export async function isForeignLeaseDirectory(directory: string): Promise<boolean> {
  try {
    return !(await fsp.lstat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The leases of one runtime for the collector: `undefined` when the folder exists but is not a real directory (nothing
 * can be proven then), else the observation (empty when the folder is missing).
 */
export async function observeLeaseDirectory(directory: string): Promise<LeaseObservation | undefined> {
  return (await leaseDirectoryState(directory)) === "foreign" ? undefined : observeLeases(directory);
}

/** Removes one lease file of `directory` (a regular `.lease` file, checked with `lstat`, never a link); best effort. */
export async function removeLeaseFile(directory: string, name: string): Promise<boolean> {
  if (!name.endsWith(LEASE_FILE_SUFFIX)) return false;
  try {
    const file = path.join(directory, name);
    if (!(await fsp.lstat(file)).isFile()) return false;
    await fsp.unlink(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a lease directory without following links: `directory` itself being a link is unlinked as a link, inside it
 * only regular lease files are unlinked, and the directory is removed only when nothing else is left in it. Best effort;
 * returns whether the directory is gone.
 */
export async function removeLeaseDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await fsp.lstat(directory);
    if (stat.isSymbolicLink()) {
      await fsp.unlink(directory);
      return true;
    }
    if (!stat.isDirectory()) return false;
    for (const name of await fsp.readdir(directory)) {
      if (!name.endsWith(LEASE_FILE_SUFFIX)) continue;
      const file = path.join(directory, name);
      if ((await fsp.lstat(file)).isFile()) await fsp.unlink(file);
    }
    await fsp.rmdir(directory);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the lease directories below `<root>/leases` whose name is a legal runtime id that is not in `installed` (the
 * runtime is gone, so whatever lease is left is a leftover). Entries that are not real directories, such as a link, are
 * skipped untouched, as is everything when `leases` itself is a link. Ids compare case-insensitively when asked (Windows,
 * macOS). Returns the runtime ids whose directory was removed.
 */
export async function removeOrphanLeaseDirectories(
  root: string,
  installed: ReadonlySet<string>,
  caseInsensitive?: boolean,
): Promise<string[]> {
  const leases = path.join(root, LEASES_DIRECTORY_NAME);
  // A `leases` that is a link is never listed: its target is not ours to clean.
  if ((await leaseDirectoryState(leases)) !== "real") return [];
  let names: string[];
  try {
    names = await fsp.readdir(leases);
  } catch {
    return [];
  }
  const present = new Set([...installed].map((name) => runtimeIdKey(name, caseInsensitive)));
  const removed: string[] = [];
  for (const name of names) {
    // The collector's own record sits beside the runtime folders; it is never an orphan.
    if (name === GC_STATE_FILE_NAME || !isRuntimeId(name) || present.has(runtimeIdKey(name, caseInsensitive))) continue;
    const directory = path.join(leases, name);
    try {
      if (!(await fsp.lstat(directory)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (await removeLeaseDirectory(directory)) removed.push(name);
  }
  return removed;
}
