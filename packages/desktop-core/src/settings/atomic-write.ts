import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseDesktopSettings, type DesktopSettingsV1 } from "./schema.js";

/** Minimal file handle surface the writer needs; lets tests fail any single step. */
export interface SettingsFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Injectable filesystem operations for {@link writeDesktopSettingsAtomic}. */
export interface SettingsWriteDeps {
  /** Create a NEW file (flag `wx`) with the given mode; must fail if it exists. */
  openExclusive(filePath: string, mode: number): Promise<SettingsFileHandle>;
  /** Open a directory read-only so it can be fsynced. */
  openDirectory(dirPath: string): Promise<SettingsFileHandle>;
  readFile(filePath: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  /** Unique suffix for temp names. */
  randomSuffix(): string;
  platform: NodeJS.Platform;
}

/** Step of the write procedure that failed. */
export type SettingsWriteStep = "validate" | "write" | "fsync" | "verify" | "recovery" | "rename" | "directory-fsync";

/** Result of a successful atomic write. */
export interface SettingsWriteResult {
  /** A recovery copy of the previous valid file was written. */
  readonly recoveryWritten: boolean;
  /** Directory fsync ran; false means the platform does not support it (documented capability). */
  readonly directorySynced: boolean;
}

/** Failure of the write procedure. The target is never left truncated or partially written. */
export class DesktopSettingsWriteError extends Error {
  readonly step: SettingsWriteStep;
  /** True when the rename already replaced the target (only the directory fsync failed afterwards). */
  readonly committed: boolean;

  constructor(step: SettingsWriteStep, message: string, options: { cause?: unknown; committed?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.name = "DesktopSettingsWriteError";
    this.step = step;
    this.committed = options.committed ?? false;
  }
}

const FILE_MODE = 0o600;
/** Directory fsync errors that mean "not supported here" rather than "failed". */
const DIRECTORY_FSYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EINVAL"]);

/** Recovery copy path for a settings file. */
export function recoveryPathFor(filePath: string): string {
  return `${filePath}.recovery`;
}

/** Real filesystem dependencies. */
export function createNodeSettingsWriteDeps(): SettingsWriteDeps {
  return {
    openExclusive: (filePath, mode) => fs.open(filePath, "wx", mode),
    openDirectory: (dirPath) => fs.open(dirPath, "r"),
    readFile: (filePath) => fs.readFile(filePath, "utf8"),
    rename: (from, to) => fs.rename(from, to),
    unlink: (filePath) => fs.unlink(filePath),
    randomSuffix: () => randomBytes(6).toString("hex"),
    platform: process.platform,
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
}

async function removeQuietly(deps: SettingsWriteDeps, filePath: string): Promise<void> {
  try {
    await deps.unlink(filePath);
  } catch {
    // Best effort: the temp file may never have been created.
  }
}

async function closeQuietly(handle: SettingsFileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The original failure is the one worth reporting.
  }
}

/** Write -> fsync -> close, tagging which step failed. */
async function writeAndSync(
  deps: SettingsWriteDeps,
  tempPath: string,
  content: string,
  step: SettingsWriteStep,
): Promise<void> {
  let handle: SettingsFileHandle;
  try {
    handle = await deps.openExclusive(tempPath, FILE_MODE);
  } catch (error) {
    throw new DesktopSettingsWriteError(step, `cannot create ${tempPath}`, { cause: error });
  }
  try {
    try {
      await handle.writeFile(content);
    } catch (error) {
      throw new DesktopSettingsWriteError(step, `cannot write ${tempPath}`, { cause: error });
    }
    try {
      await handle.sync();
    } catch (error) {
      throw new DesktopSettingsWriteError("fsync", `cannot fsync ${tempPath}`, { cause: error });
    }
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  }
  try {
    await handle.close();
  } catch (error) {
    throw new DesktopSettingsWriteError(step, `cannot close ${tempPath}`, { cause: error });
  }
}

/** Re-read what is really on disk and require identical, schema-valid content. */
async function verifyTemp(deps: SettingsWriteDeps, tempPath: string, expected: string): Promise<void> {
  let actual: string;
  try {
    actual = await deps.readFile(tempPath);
  } catch (error) {
    throw new DesktopSettingsWriteError("verify", `cannot re-read ${tempPath}`, { cause: error });
  }
  let parsed: ReturnType<typeof parseDesktopSettings>;
  try {
    parsed = parseDesktopSettings(JSON.parse(actual));
  } catch (error) {
    throw new DesktopSettingsWriteError("verify", `temp file ${tempPath} is not valid JSON`, { cause: error });
  }
  if (actual !== expected || !parsed.ok) {
    throw new DesktopSettingsWriteError("verify", `temp file ${tempPath} does not match what was written`);
  }
}

/** Stage `content` as a verified temp file next to `finalPath`; the caller renames it into place. */
async function stageVerified(
  deps: SettingsWriteDeps,
  finalPath: string,
  content: string,
  step: SettingsWriteStep,
): Promise<string> {
  const tempPath = `${finalPath}.${deps.randomSuffix()}.tmp`;
  try {
    await writeAndSync(deps, tempPath, content, step);
    await verifyTemp(deps, tempPath, content);
  } catch (error) {
    await removeQuietly(deps, tempPath);
    throw error;
  }
  return tempPath;
}

/** Previous file content, only if it exists AND is valid settings (never preserve garbage as recovery). */
async function readPreviousValid(deps: SettingsWriteDeps, filePath: string): Promise<string | null> {
  try {
    const content = await deps.readFile(filePath);
    return parseDesktopSettings(JSON.parse(content)).ok ? content : null;
  } catch {
    return null;
  }
}

/** fsync the directory so the rename itself is durable; returns false when the platform cannot. */
async function syncDirectory(deps: SettingsWriteDeps, dirPath: string): Promise<boolean> {
  if (deps.platform === "win32") return false;
  let handle: SettingsFileHandle;
  try {
    handle = await deps.openDirectory(dirPath);
  } catch (error) {
    if (DIRECTORY_FSYNC_UNSUPPORTED.has(errorCode(error) ?? "")) return false;
    throw new DesktopSettingsWriteError("directory-fsync", `cannot open ${dirPath}`, { cause: error, committed: true });
  }
  try {
    await handle.sync();
    return true;
  } catch (error) {
    if (DIRECTORY_FSYNC_UNSUPPORTED.has(errorCode(error) ?? "")) return false;
    throw new DesktopSettingsWriteError("directory-fsync", `cannot fsync ${dirPath}`, {
      cause: error,
      committed: true,
    });
  } finally {
    await closeQuietly(handle);
  }
}

/**
 * Atomically replace the settings file: validate, stage a verified temp file in the same directory,
 * keep a recovery copy of the previous valid file, rename over the target, then fsync the directory.
 * The target is only ever replaced by a complete, re-validated file, so a crash at any point leaves
 * either the old or the new content. On failure only temp files created here are removed.
 */
export async function writeDesktopSettingsAtomic(
  filePath: string,
  settings: DesktopSettingsV1,
  deps: SettingsWriteDeps = createNodeSettingsWriteDeps(),
): Promise<SettingsWriteResult> {
  const validated = parseDesktopSettings(settings);
  if (!validated.ok) {
    throw new DesktopSettingsWriteError("validate", `refusing to write invalid settings: ${validated.detail}`);
  }
  const content = `${JSON.stringify(validated.settings, null, 2)}\n`;
  const staged: string[] = [];
  try {
    staged.push(await stageVerified(deps, filePath, content, "write"));
    const mainTemp = staged[0] as string;

    const previous = await readPreviousValid(deps, filePath);
    if (previous !== null) {
      const recoveryTarget = recoveryPathFor(filePath);
      const recoveryTemp = await stageVerified(deps, recoveryTarget, previous, "recovery");
      staged.push(recoveryTemp);
      await renameStep(deps, recoveryTemp, recoveryTarget, "recovery");
      staged.pop();
    }

    await renameStep(deps, mainTemp, filePath, "rename");
    staged.shift();
    const directorySynced = await syncDirectory(deps, path.dirname(filePath));
    return { recoveryWritten: previous !== null, directorySynced };
  } catch (error) {
    for (const tempPath of staged) await removeQuietly(deps, tempPath);
    throw error;
  }
}

async function renameStep(deps: SettingsWriteDeps, from: string, to: string, step: SettingsWriteStep): Promise<void> {
  try {
    await deps.rename(from, to);
  } catch (error) {
    throw new DesktopSettingsWriteError(step, `cannot rename ${from} to ${to}`, { cause: error });
  }
}
