import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { errorCode } from "./error-code.js";

export interface AtomicFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFileDeps {
  openExclusive(filePath: string, mode: number): Promise<AtomicFileHandle>;
  openDirectory(dirPath: string): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  randomSuffix(): string;
  platform: NodeJS.Platform;
}

export type AtomicFileStep = "write" | "fsync" | "rename" | "directory-fsync";

export class AtomicFileError extends Error {
  readonly step: AtomicFileStep;
  readonly committed: boolean;

  constructor(step: AtomicFileStep, message: string, options: { cause?: unknown; committed?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.name = "AtomicFileError";
    this.step = step;
    this.committed = options.committed ?? false;
  }
}

export interface AtomicWriteOptions {
  /** File mode of the new file; defaults to owner-only because journals may reveal local paths. */
  readonly mode?: number;
  readonly deps?: AtomicFileDeps;
}

export interface AtomicWriteResult {
  readonly directorySynced: boolean;
}

const DEFAULT_MODE = 0o600;
const DIRECTORY_FSYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]);

export function createNodeAtomicFileDeps(): AtomicFileDeps {
  return {
    openExclusive: (filePath, mode) => fs.open(filePath, "wx", mode),
    openDirectory: (dirPath) => fs.open(dirPath, "r"),
    rename: (from, to) => fs.rename(from, to),
    unlink: (filePath) => fs.unlink(filePath),
    randomSuffix: () => randomBytes(6).toString("hex"),
    platform: process.platform,
  };
}

async function closeQuietly(handle: AtomicFileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The original failure is the one worth reporting.
  }
}

export async function removeQuietly(deps: AtomicFileDeps, filePath: string): Promise<void> {
  try {
    await deps.unlink(filePath);
  } catch {
    // Best effort.
  }
}

export function tempPathFor(deps: AtomicFileDeps, target: string): string {
  return `${target}.${deps.randomSuffix()}.tmp`;
}

export async function writeTempFile(
  deps: AtomicFileDeps,
  tempPath: string,
  data: string,
  mode: number = DEFAULT_MODE,
): Promise<void> {
  let handle: AtomicFileHandle;
  try {
    handle = await deps.openExclusive(tempPath, mode);
  } catch (error) {
    throw new AtomicFileError("write", `cannot create ${tempPath}`, { cause: error });
  }
  try {
    try {
      await handle.writeFile(data);
    } catch (error) {
      throw new AtomicFileError("write", `cannot write ${tempPath}`, { cause: error });
    }
    try {
      await handle.sync();
    } catch (error) {
      throw new AtomicFileError("fsync", `cannot fsync ${tempPath}`, { cause: error });
    }
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  }
  try {
    await handle.close();
  } catch (error) {
    throw new AtomicFileError("write", `cannot close ${tempPath}`, { cause: error });
  }
}

export async function renameInto(deps: AtomicFileDeps, from: string, to: string): Promise<void> {
  try {
    await deps.rename(from, to);
  } catch (error) {
    throw new AtomicFileError("rename", `cannot rename ${from} to ${to}`, { cause: error });
  }
}

/** Skipped on win32 and on EISDIR/EPERM/EINVAL/ENOTSUP; any other failure is a committed `directory-fsync` error (the target was already replaced). */
export async function syncDirectory(deps: AtomicFileDeps, dirPath: string): Promise<boolean> {
  if (deps.platform === "win32") return false;
  let handle: AtomicFileHandle;
  try {
    handle = await deps.openDirectory(dirPath);
  } catch (error) {
    if (DIRECTORY_FSYNC_UNSUPPORTED.has(errorCode(error) ?? "")) return false;
    throw new AtomicFileError("directory-fsync", `cannot open ${dirPath}`, { cause: error, committed: true });
  }
  try {
    await handle.sync();
    return true;
  } catch (error) {
    if (DIRECTORY_FSYNC_UNSUPPORTED.has(errorCode(error) ?? "")) return false;
    throw new AtomicFileError("directory-fsync", `cannot fsync ${dirPath}`, { cause: error, committed: true });
  } finally {
    await closeQuietly(handle);
  }
}

export async function writeFileAtomic(
  target: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const deps = options.deps ?? createNodeAtomicFileDeps();
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const temp = tempPathFor(deps, target);
  try {
    await writeTempFile(deps, temp, data, options.mode);
    await renameInto(deps, temp, target);
  } catch (error) {
    await removeQuietly(deps, temp);
    throw error;
  }
  return { directorySynced: await syncDirectory(deps, dir) };
}
