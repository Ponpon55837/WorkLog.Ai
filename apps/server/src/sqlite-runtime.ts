import { createRequire } from "node:module";
import type { SqliteRuntimeStatus } from "@work-intelligence/core";
import { assessSqliteWalResetFix } from "@work-intelligence/shared/sqlite-version";

let cached: SqliteRuntimeStatus | undefined;

/** Free of any `node:sqlite` import, so doctor can load it on a Node without node:sqlite. */
export function sqliteRuntimeStatusFromVersion(version: string): SqliteRuntimeStatus {
  const assessment = assessSqliteWalResetFix(version);
  return {
    version: assessment.version,
    walResetFixed: !assessment.affected,
    ...(assessment.fixedIn ? { fixedIn: assessment.fixedIn } : {}),
  };
}

/** node:sqlite is required lazily so importing this module never throws. */
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
