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

export type SettingsFileHandle = AtomicFileHandle;

export interface SettingsWriteDeps extends AtomicFileDeps {
  readFile(filePath: string): Promise<string>;
}

export type SettingsWriteStep =
  "validate" | "write" | "fsync" | "verify" | "recovery" | "rename" | "directory-fsync" | "refuse-downgrade";

export interface SettingsWriteResult {
  readonly recoveryWritten: boolean;
  readonly directorySynced: boolean;
}

export class DesktopSettingsWriteError extends Error {
  readonly step: SettingsWriteStep;
  readonly committed: boolean;

  constructor(step: SettingsWriteStep, message: string, options: { cause?: unknown; committed?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.name = "DesktopSettingsWriteError";
    this.step = step;
    this.committed = options.committed ?? false;
  }
}

export function recoveryPathFor(filePath: string): string {
  return `${filePath}.recovery`;
}

export function createNodeSettingsWriteDeps(): SettingsWriteDeps {
  return { ...createNodeAtomicFileDeps(), readFile: (filePath) => fs.readFile(filePath, "utf8") };
}

const FILE_MODE = 0o600;

function toWriteError(error: unknown, stage: SettingsWriteStep): unknown {
  if (!(error instanceof AtomicFileError)) return error;
  const step: SettingsWriteStep = error.step === "write" ? stage : error.step;
  return new DesktopSettingsWriteError(step, error.message, { cause: error.cause, committed: error.committed });
}

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
