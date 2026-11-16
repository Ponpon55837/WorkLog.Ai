import { DatabaseSync } from "node:sqlite";
import type { SqliteRuntimeStatus } from "@work-intelligence/core";
import { assessSqliteWalResetFix } from "@work-intelligence/shared/sqlite-version";

let cached: SqliteRuntimeStatus | undefined;

/**
 * Reports the SQLite library node:sqlite loads via `SELECT sqlite_version()` on a throwaway in-memory connection (every
 * connection in the process uses the same library). The version is constant per process, so it is read once.
 */
export function getSqliteRuntimeStatus(): SqliteRuntimeStatus {
  if (cached) return cached;
  const db = new DatabaseSync(":memory:");
  let version: string;
  try {
    version = String((db.prepare("SELECT sqlite_version() AS version").get() as { version: unknown }).version);
  } finally {
    db.close();
  }
  const assessment = assessSqliteWalResetFix(version);
  cached = {
    version: assessment.version,
    walResetFixed: !assessment.affected,
    ...(assessment.fixedIn ? { fixedIn: assessment.fixedIn } : {}),
  };
  return cached;
}
