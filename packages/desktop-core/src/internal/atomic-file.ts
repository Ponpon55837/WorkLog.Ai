import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Minimal file handle surface; lets tests fail any single step. */
export interface AtomicFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Injectable filesystem operations shared by every atomic writer (journal, settings). */
export interface AtomicFileDeps {
  /** Create a NEW file (flag `wx`) with the given mode; must fail if it exists. */
  openExclusive(filePath: string, mode: number): Promise<AtomicFileHandle>;
  /** Open a directory read-only so it can be fsynced. */
  openDirectory(dirPath: string): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  /** Unique suffix for temp names. */
  randomSuffix(): string;
  platform: NodeJS.Platform;
}

/** Step of the procedure that failed. */
export type AtomicFileStep = "write" | "fsync" | "rename" | "directory-fsync";

/** Failure of one primitive; `committed` is true when the rename already replaced the target. */
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

/** Options for {@link writeFileAtomic}. */
export interface AtomicWriteOptions {
  /** File mode of the new file; defaults to owner-only because journals may reveal local paths. */
  readonly mode?: number;
  readonly deps?: AtomicFileDeps;
}

/** Result of a successful atomic write. */
export interface AtomicWriteResult {
  /** The directory fsync ran; false means the platform does not support it (documented capability). */
  readonly directorySynced: boolean;
}

const DEFAULT_MODE = 0o600;
/** Directory fsync errors that mean "not supported here" rather than "failed". */
const DIRECTORY_FSYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]);

/** Real filesystem dependencies. */
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

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
}

async function closeQuietly(handle: AtomicFileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The original failure is the one worth reporting.
  }
}

/** Remove a temp file; a missing file (never created, already renamed) is fine. */
export async function removeQuietly(deps: AtomicFileDeps, filePath: string): Promise<void> {
  try {
    await deps.unlink(filePath);
  } catch {
    // Best effort.
  }
}

/** Temp path next to `target` (same filesystem, so rename is atomic). */
export function tempPathFor(deps: AtomicFileDeps, target: string): string {
  return `${target}.${deps.randomSuffix()}.tmp`;
}

/**
 * Create `tempPath` exclusively, write, fsync and close it. `writeStep` labels create/write/close failures so a
 * caller with several stages (main file, recovery copy) can tell them apart; fsync failures are always `fsync`.
 * The temp file is NOT removed on failure; the caller owns cleanup.
 */
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

/** Rename a staged temp file over `to`. */
export async function renameInto(deps: AtomicFileDeps, from: string, to: string): Promise<void> {
  try {
    await deps.rename(from, to);
  } catch (error) {
    throw new AtomicFileError("rename", `cannot rename ${from} to ${to}`, { cause: error });
  }
}

/**
 * fsync the directory so the rename itself is durable. Policy (same for every caller): skipped on win32 and on
 * EISDIR / EPERM / EINVAL / ENOTSUP (the platform cannot do it, returns false); any other failure is reported as a
 * committed `directory-fsync` error because the target was already replaced.
 */
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

/**
 * Replace `target` with `data` so readers see either the old or the new content, never a torn file:
 * temp file in the same directory -> fsync -> rename -> directory fsync (see {@link syncDirectory} for the policy).
 * On failure before the rename the temp file is removed and the target is untouched.
 */
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
