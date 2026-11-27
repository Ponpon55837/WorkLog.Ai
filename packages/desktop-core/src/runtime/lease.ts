import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { errorCode } from "../internal/error-code.js";
import { GC_STATE_FILE_NAME, LEASES_DIRECTORY_NAME, runtimeIdKey } from "./layout.js";
import { isRuntimeId } from "./manifest.js";

export interface LeaseHandle {
  refresh(): void;
  remove(): void;
}

export type LeaseObservation = ReadonlyMap<string, number>;

export const LEASE_HEARTBEAT_MS = 60_000;
export const LEASE_FILE_SUFFIX = ".lease";

const LEASE_FILE_MODE = 0o600;
const LEASE_DIRECTORY_MODE = 0o700;

export function leaseDirectoryFor(root: string, runtimeId: string): string {
  return path.join(root, LEASES_DIRECTORY_NAME, runtimeId);
}

export const LEASE_DIRECTORY_UNSAFE = "LEASE_DIRECTORY_UNSAFE";

export type LeaseDirectoryState = "missing" | "real" | "foreign";

function unsafeLeaseDirectory(): Error {
  return Object.assign(new Error("lease directory is not a real directory"), { code: LEASE_DIRECTORY_UNSAFE });
}

/** A symbolic link or, on Windows, a junction (both show as `isSymbolicLink` on `lstat`) is `foreign`. */
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

export function createLease(root: string, runtimeId: string, action: string): LeaseHandle {
  const directory = prepareLeaseDirectory(root, runtimeId);
  const file = path.join(directory, `${randomBytes(8).toString("hex")}${LEASE_FILE_SUFFIX}`);
  writeLeaseFile(file, action);
  return {
    refresh: () => {
      const now = new Date();
      try {
        fs.utimesSync(file, now, now);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
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

export async function observeLeaseDirectory(directory: string): Promise<LeaseObservation | undefined> {
  return (await leaseDirectoryState(directory)) === "foreign" ? undefined : observeLeases(directory);
}

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
