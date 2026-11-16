import fs from "node:fs/promises";
import path from "node:path";
import {
  AtomicFileError,
  createNodeAtomicFileDeps,
  removeQuietly,
  renameInto,
  syncDirectory,
  tempPathFor,
  writeTempFile,
  type AtomicFileDeps,
  type AtomicFileHandle,
} from "../internal/atomic-file.js";
import { parseDesktopSettings, type DesktopSettingsV1 } from "./schema.js";

/** Minimal file handle surface the writer needs; lets tests fail any single step. */
export type SettingsFileHandle = AtomicFileHandle;

/** Injectable filesystem operations: the shared atomic-file ones plus the re-read used by the verify step. */
export interface SettingsWriteDeps extends AtomicFileDeps {
  readFile(filePath: string): Promise<string>;
}

/** Step of the write procedure that failed. */
export type SettingsWriteStep =
  "validate" | "write" | "fsync" | "verify" | "recovery" | "rename" | "directory-fsync" | "refuse-downgrade";

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

/** Recovery copy path for a settings file. */
export function recoveryPathFor(filePath: string): string {
  return `${filePath}.recovery`;
}

/** Real filesystem dependencies. */
export function createNodeSettingsWriteDeps(): SettingsWriteDeps {
  return { ...createNodeAtomicFileDeps(), readFile: (filePath) => fs.readFile(filePath, "utf8") };
}

const FILE_MODE = 0o600;

/** Re-label a primitive failure with the settings step it belongs to (`write` is stage-specific). */
function toWriteError(error: unknown, stage: SettingsWriteStep): unknown {
  if (!(error instanceof AtomicFileError)) return error;
  const step: SettingsWriteStep = error.step === "write" ? stage : error.step;
  return new DesktopSettingsWriteError(step, error.message, { cause: error.cause, committed: error.committed });
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
  const tempPath = tempPathFor(deps, finalPath);
  try {
    try {
      await writeTempFile(deps, tempPath, content, FILE_MODE);
    } catch (error) {
      throw toWriteError(error, step);
    }
    await verifyTemp(deps, tempPath, content);
  } catch (error) {
    await removeQuietly(deps, tempPath);
    throw error;
  }
  return tempPath;
}

/**
 * Previous primary: its content when it is valid settings (never preserve garbage as recovery); `unsupported`
 * when it carries a version this build cannot parse, which must never be overwritten (a downgrade would destroy
 * settings a newer app wrote).
 */
async function inspectPrevious(
  deps: SettingsWriteDeps,
  filePath: string,
): Promise<{ readonly content: string | null; readonly unsupported: boolean }> {
  try {
    const content = await deps.readFile(filePath);
    const parsed = parseDesktopSettings(JSON.parse(content));
    if (parsed.ok) return { content, unsupported: false };
    return { content: null, unsupported: parsed.kind === "unsupported-version" };
  } catch {
    return { content: null, unsupported: false };
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
  const existing = await inspectPrevious(deps, filePath);
  if (existing.unsupported) {
    throw new DesktopSettingsWriteError(
      "refuse-downgrade",
      `refusing to overwrite ${filePath}: it was written by a newer or unknown settings version`,
    );
  }
  const staged: string[] = [];
  try {
    staged.push(await stageVerified(deps, filePath, content, "write"));
    const mainTemp = staged[0] as string;

    const previous = existing.content;
    if (previous !== null) {
      const recoveryTarget = recoveryPathFor(filePath);
      const recoveryTemp = await stageVerified(deps, recoveryTarget, previous, "recovery");
      staged.push(recoveryTemp);
      await renameStep(deps, recoveryTemp, recoveryTarget, "recovery");
      staged.pop();
    }

    await renameStep(deps, mainTemp, filePath, "rename");
    staged.shift();
    const directorySynced = await syncDirectory(deps, path.dirname(filePath)).catch((error: unknown) => {
      throw toWriteError(error, "directory-fsync");
    });
    return { recoveryWritten: previous !== null, directorySynced };
  } catch (error) {
    for (const tempPath of staged) await removeQuietly(deps, tempPath);
    throw error;
  }
}

async function renameStep(deps: SettingsWriteDeps, from: string, to: string, step: SettingsWriteStep): Promise<void> {
  try {
    await renameInto(deps, from, to);
  } catch (error) {
    throw new DesktopSettingsWriteError(step, (error as Error).message, { cause: (error as Error).cause });
  }
}
