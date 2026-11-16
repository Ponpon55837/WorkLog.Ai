import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LATEST_SCHEMA_VERSION } from "@work-intelligence/storage";
import {
  normalizePathForCompare,
  readFileIdentity,
  sameFileIdentity,
  type FileIdentity,
} from "@work-intelligence/shared/file-identity";
import { readOnlyTableExists, readSchemaVersion, type ReadOnlySqliteDatabase } from "./database-inspection.js";

/** Composite identity of a database file; structurally identical to desktop-core's `DatabaseIdentity` (server never imports it). */
export interface DatabaseIdentity {
  realPath: string;
  fileId: { device: string; inode: string } | null;
  lineageId: string | null;
}

/** Same statuses as desktop-core's `DbProbeStatus`, kept distinct so the UI can explain each one. */
export type DatabasePreflightStatus = "missing" | "offline" | "denied" | "unreadable" | "unsupported-schema" | "ok";

/** How the file's schema relates to what this build can run. */
export type SchemaCompatibility = "empty" | "current" | "older-needs-migration" | "newer-unsupported";

export interface SidecarFileState {
  exists: boolean;
  size: number;
}

/** State of the `-wal` and `-shm` files beside the database at one moment. */
export interface SidecarState {
  wal: SidecarFileState;
  shm: SidecarFileState;
}

export interface DatabasePreflightResult {
  status: DatabasePreflightStatus;
  identity?: DatabaseIdentity;
  schemaVersion?: number;
  compatibility?: SchemaCompatibility;
  projectCount?: number;
  /** Recorded before and after the probe: a read-only open is not guaranteed to be 0-write, so the difference is evidence. */
  sidecars?: { before: SidecarState; after: SidecarState };
  detail?: string;
}

export interface PreflightOptions {
  supportedSchemaVersion?: number;
}

/** A database the shell has verified and handed to `startApi`; startApi re-checks it right before opening. */
export interface VerifiedDatabaseConfig {
  path: string;
  identity: DatabaseIdentity;
  backupDirectory?: string;
}

export type RevalidationFailureReason =
  "missing" | "offline" | "denied" | "unreadable" | "path-replaced" | "file-replaced" | "lineage-changed";

export type RevalidationResult =
  { ok: true; identity: DatabaseIdentity } | { ok: false; reason: RevalidationFailureReason; detail: string };

// SQLite primary result codes (sqlite3.h) used to classify node:sqlite errors without matching on message text alone.
const SQLITE_PERM = 3;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;

function sidecarState(path: string): SidecarFileState {
  try {
    return { exists: true, size: statSync(path).size };
  } catch {
    return { exists: false, size: 0 };
  }
}

function readSidecars(databasePath: string): SidecarState {
  return { wal: sidecarState(`${databasePath}-wal`), shm: sidecarState(`${databasePath}-shm`) };
}

/** Opens the file read-only. Never `immutable`: that would ignore a live WAL and show stale, possibly torn, data. */
function openReadOnly(path: string): ReadOnlySqliteDatabase {
  return new DatabaseSync(path, { readOnly: true }) as unknown as ReadOnlySqliteDatabase;
}

/** True when the OS refuses read access to the file; SQLite's CANTOPEN message ("unable to open database file") omits why. */
function readAccessDenied(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return false;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "EACCES" || code === "EPERM";
  }
}

function sqliteErrorStatus(error: unknown, path: string): "denied" | "unreadable" {
  const { errcode, code, message } = (error ?? {}) as { errcode?: unknown; code?: unknown; message?: unknown };
  const primary = typeof errcode === "number" ? errcode & 0xff : undefined;
  const text = typeof message === "string" ? message : "";
  if (code === "EACCES" || code === "EPERM") return "denied";
  if (primary === SQLITE_PERM || primary === SQLITE_READONLY) return "denied";
  if (primary === SQLITE_NOTADB || primary === SQLITE_CORRUPT) return "unreadable";
  if (/permission|access is denied/i.test(text)) return "denied";
  if (primary === SQLITE_CANTOPEN) return readAccessDenied(path) ? "denied" : "unreadable";
  return "unreadable";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fingerprint of the database's own history: sha256 of the oldest `schema_migrations` row (version|name|applied_at).
 * That row is written once at creation and never rewritten, and it survives file copies, so it names the lineage
 * rather than the file. `null` when the table or its rows are absent.
 */
export function readLineageId(database: ReadOnlySqliteDatabase): string | null {
  if (!readOnlyTableExists(database, "schema_migrations")) return null;
  const row = database
    .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC LIMIT 1")
    .get() as { version: number | bigint; name: string; applied_at: string } | undefined;
  if (!row) return null;
  return createHash("sha256").update(`${row.version}|${row.name}|${row.applied_at}`).digest("hex");
}

function readProjectCount(database: ReadOnlySqliteDatabase): number | undefined {
  if (!readOnlyTableExists(database, "projects")) return undefined;
  const row = database.prepare("SELECT COUNT(*) AS total FROM projects").get() as { total: number | bigint };
  return Number(row.total);
}

/** Tables of Work Intelligence's pre-`schema_migrations` core schema; a legacy database has all of them. */
const LEGACY_CORE_TABLES = ["projects", "sessions"];

function readUserTables(database: ReadOnlySqliteDatabase): Set<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/** `empty`: a fresh file with no tables; `legacy`: Work Intelligence before migrations were tracked; `foreign`: someone else's. */
function classifyUntracked(database: ReadOnlySqliteDatabase): "empty" | "legacy" | "foreign" {
  const tables = readUserTables(database);
  if (tables.size === 0) return "empty";
  return LEGACY_CORE_TABLES.every((name) => tables.has(name)) ? "legacy" : "foreign";
}

function compatibilityOf(schemaVersion: number, supported: number): SchemaCompatibility {
  if (schemaVersion > supported) return "newer-unsupported";
  return schemaVersion === supported ? "current" : "older-needs-migration";
}

function preflightSync(path: string, supportedSchemaVersion: number): DatabasePreflightResult {
  const located = readFileIdentity(path);
  if (!located.ok) {
    return { status: located.kind, detail: `${located.code}: ${located.message}` };
  }
  const { realPath, fileId } = located.identity;
  const before = readSidecars(realPath);
  const finish = (result: DatabasePreflightResult): DatabasePreflightResult => ({
    ...result,
    sidecars: { before, after: readSidecars(realPath) },
  });

  let database: ReadOnlySqliteDatabase | undefined;
  try {
    database = openReadOnly(realPath);
    const schemaVersion = readSchemaVersion(database);
    const lineageId = readLineageId(database);
    const identity: DatabaseIdentity = { realPath, fileId, lineageId };
    if (schemaVersion === null) {
      return finish({ status: "unreadable", identity, detail: "schema_migrations holds an invalid version" });
    }
    if (lineageId === null && !readOnlyTableExists(database, "schema_migrations")) {
      const kind = classifyUntracked(database);
      if (kind === "foreign") {
        return finish({
          status: "unsupported-schema",
          identity,
          schemaVersion,
          detail: "not-work-intelligence",
        });
      }
      if (kind === "empty") {
        return finish({ status: "ok", identity, schemaVersion, compatibility: "empty" });
      }
    }
    const compatibility = compatibilityOf(schemaVersion, supportedSchemaVersion);
    const projectCount = readProjectCount(database);
    return finish({
      status: compatibility === "newer-unsupported" ? "unsupported-schema" : "ok",
      identity,
      schemaVersion,
      compatibility,
      ...(projectCount === undefined ? {} : { projectCount }),
      ...(compatibility === "newer-unsupported"
        ? { detail: `schema version ${schemaVersion} is newer than the supported ${supportedSchemaVersion}` }
        : {}),
    });
  } catch (error) {
    return finish({
      status: sqliteErrorStatus(error, realPath),
      identity: { realPath, fileId, lineageId: null },
      detail: describeError(error),
    });
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a handle that failed to open cleanly must not mask the probe result.
    }
  }
}

/**
 * Read-only preflight of a database file: identity, schema compatibility, a project-count preview and the WAL/SHM
 * sidecar state around the probe. Never writes through SQLite, never uses `immutable`, never throws for an expected
 * failure; each failure kind is its own status. Structurally satisfies desktop-core's `DbProbe`.
 *
 * Performance: this is synchronous SQLite and file-system work behind an async signature, so it blocks the thread it
 * runs on; the desktop host must run it off any UI thread (a worker or utility process).
 */
export async function preflightDatabase(
  path: string,
  options: PreflightOptions = {},
): Promise<DatabasePreflightResult> {
  return preflightSync(path, options.supportedSchemaVersion ?? LATEST_SCHEMA_VERSION);
}

/** Same physical file: both ids are known and equal. */
function sameKnownFile(expected: DatabaseIdentity, actual: FileIdentity): boolean {
  return sameFileIdentity({ realPath: expected.realPath, fileId: expected.fileId }, actual);
}

/** Lineage rule: both known must match; a null expectation may only gain a lineage in the very same file (first migration). */
function lineageStillValid(expected: string | null, actual: string | null, sameFile: boolean): boolean {
  if (expected === null) return actual === null || sameFile;
  return actual === expected;
}

/**
 * Re-reads path, file id and lineage immediately before the store opens (TOCTOU guard between the preflight the user
 * approved and the commit). A different resolved path is `path-replaced` (a symlink or mount now points elsewhere),
 * the same path with a different file id is `file-replaced`, and the same file holding a different history is
 * `lineage-changed`. A file id that still matches wins over a changed path; a lineage that was null may appear only in
 * that same file (the first migration wrote `schema_migrations`). Read-only; opens nothing when the file is already gone.
 */
export function revalidateBeforeCommit(path: string, expected: DatabaseIdentity): RevalidationResult {
  const located = readFileIdentity(path);
  if (!located.ok) {
    return { ok: false, reason: located.kind, detail: `${located.code}: ${located.message}` };
  }
  const actual = located.identity;
  const sameFile = sameKnownFile(expected, actual);
  const samePath = normalizePathForCompare(actual.realPath) === normalizePathForCompare(expected.realPath);
  if (!sameFile && !samePath) {
    return { ok: false, reason: "path-replaced", detail: `${expected.realPath} now resolves to ${actual.realPath}` };
  }
  if (!sameFile && expected.fileId && actual.fileId) {
    return {
      ok: false,
      reason: "file-replaced",
      detail: "the file at this path is no longer the one that was checked",
    };
  }

  let lineageId: string | null;
  let database: ReadOnlySqliteDatabase | undefined;
  try {
    database = openReadOnly(actual.realPath);
    lineageId = readLineageId(database);
  } catch (error) {
    return { ok: false, reason: sqliteErrorStatus(error, actual.realPath), detail: describeError(error) };
  } finally {
    try {
      database?.close();
    } catch {
      // A close failure after a completed read changes nothing about the answer.
    }
  }
  if (!lineageStillValid(expected.lineageId, lineageId, sameFile)) {
    return {
      ok: false,
      reason: "lineage-changed",
      detail: "the database history differs from the one that was checked",
    };
  }
  return { ok: true, identity: { realPath: actual.realPath, fileId: actual.fileId, lineageId } };
}

/**
 * Re-reads the identity of an already opened database (read-only), for the identity a start reports after the store has
 * opened and possibly migrated it: the lineage of an empty file only exists from then on. `undefined` when it cannot be read.
 */
export function readOpenedIdentity(path: string): DatabaseIdentity | undefined {
  const located = readFileIdentity(path);
  if (!located.ok) return undefined;
  let database: ReadOnlySqliteDatabase | undefined;
  try {
    database = openReadOnly(located.identity.realPath);
    return { realPath: located.identity.realPath, fileId: located.identity.fileId, lineageId: readLineageId(database) };
  } catch {
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      // The identity was already read; a close failure changes nothing.
    }
  }
}
