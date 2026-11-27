import { closeSync, lstatSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { classifyFileError } from "@work-intelligence/shared/file-identity";
import type { DatabasePreflightResult } from "./database-preflight.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const ALREADY_THERE: DatabasePreflightResult = Object.freeze({ status: "unreadable", detail: "EEXIST" });

function errorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function failureFor(error: unknown, path: string): DatabasePreflightResult {
  const kind = classifyFileError(error, path);
  const status = kind === "denied" || kind === "offline" ? kind : "unreadable";
  return { status, detail: errorCode(error) ?? "UNKNOWN" };
}

function removeCreated(path: string): void {
  for (const suffix of ["", ...SQLITE_SIDECAR_SUFFIXES]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // Best effort: a leftover file is found by the next preflight, never silently trusted.
    }
  }
}

// Returns undefined only when THIS call created the database (the App may then remove it after a failed start);
// anything already at the path, even one that appears before the exclusive create, is reported as EEXIST.
export function createDatabaseIfMissing(path: string): DatabasePreflightResult | undefined {
  try {
    lstatSync(path);
    return ALREADY_THERE;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return failureFor(error, path);
  }

  try {
    mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    return failureFor(error, path);
  }

  try {
    closeSync(openSync(path, "wx", PRIVATE_FILE_MODE));
  } catch (error) {
    // Someone created it between the check and now: it is theirs, so it is left alone and not reported as created.
    return errorCode(error) === "EEXIST" ? ALREADY_THERE : failureFor(error, path);
  }

  try {
    new WorkIntelligenceStore(path).close();
  } catch (error) {
    removeCreated(path);
    return failureFor(error, path);
  }
  return undefined;
}
