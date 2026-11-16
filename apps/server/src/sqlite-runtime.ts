import { createRequire } from "node:module";
import type { SqliteRuntimeStatus } from "@work-intelligence/core";
import { assessSqliteWalResetFix } from "@work-intelligence/shared/sqlite-version";

let cached: SqliteRuntimeStatus | undefined;

/**
 * Builds the status from a `sqlite_version()` string. Pure and free of any `node:sqlite` import, so doctor can load
 * this module on a Node without node:sqlite and still report that finding from the version it probed itself.
 */
export function sqliteRuntimeStatusFromVersion(version: string): SqliteRuntimeStatus {
  const assessment = assessSqliteWalResetFix(version);
  return {
    version: assessment.version,
    walResetFixed: !assessment.affected,
    ...(assessment.fixedIn ? { fixedIn: assessment.fixedIn } : {}),
  };
}

/**
 * Reports the SQLite library node:sqlite loads via `SELECT sqlite_version()` on a throwaway in-memory connection (every
 * connection in the process uses the same library). The version is constant per process, so it is read once.
 * node:sqlite is required lazily here (not imported at the top) so importing this module never throws.
 */
export function getSqliteRuntimeStatus(): SqliteRuntimeStatus {
  if (cached) return cached;
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  let version: string;
  try {
    version = String((db.prepare("SELECT sqlite_version() AS version").get() as { version: unknown }).version);
  } finally {
    db.close();
  }
  cached = sqliteRuntimeStatusFromVersion(version);
  return cached;
}
