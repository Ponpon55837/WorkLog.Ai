import type { DatabaseSync } from "node:sqlite";

// Distinct keys one cache holds before it starts over; the callers key by project id or the global scope.
const MAX_CACHED_KEYS = 64;

/**
 * Reuses the result of a read that depends only on project data while the database is unchanged.
 *
 * Why a cached value can never be stale:
 * - Every project-data table has INSERT, UPDATE and DELETE triggers that increment
 *   `change_revisions.data_revision` in the same transaction as the write, and the counter lives in the
 *   database file, so a commit by another process (the REST server and the MCP servers share it) moves it too.
 * - A replaced database file gets a new `database_id`, and DDL (a migration in another process) moves SQLite's
 *   `schema_version`; both are part of the key, read with the revision in one statement (one snapshot).
 * - The key is read before the value is computed. Revisions only grow within one database id, so a later read of
 *   the same key means nothing was committed since, and the value cannot describe an older state.
 * - Inside an open transaction nothing is cached or served: uncommitted writes move the revision, and a rollback
 *   followed by another process's commit could reuse the same revision number for different data.
 *
 * Results are per connection (one instance per store) and must be keyed by everything else the read depends on,
 * such as the project id, so one project's result is never returned for another. Policy checks stay outside.
 */
export class DataRevisionCache<T> {
  private revisionKey: string | undefined;
  private readonly values = new Map<string, T>();

  public constructor(private readonly db: DatabaseSync) {}

  public get(key: string, compute: () => T): T {
    const revisionKey = this.db.isTransaction ? undefined : this.readRevisionKey();
    if (revisionKey === undefined) {
      return compute();
    }
    if (revisionKey !== this.revisionKey) {
      this.values.clear();
      this.revisionKey = revisionKey;
    }
    if (this.values.has(key)) {
      return this.values.get(key)!;
    }
    const value = compute();
    if (this.values.size >= MAX_CACHED_KEYS) this.values.clear();
    this.values.set(key, value);
    return value;
  }

  private readRevisionKey(): string | undefined {
    const row = this.db
      .prepare(
        `SELECT database_id AS databaseId, data_revision AS dataRevision,
                (SELECT schema_version FROM pragma_schema_version) AS schemaVersion
         FROM change_revisions WHERE singleton = 1`,
      )
      .get() as { databaseId?: string; dataRevision?: number; schemaVersion?: number } | undefined;
    return row?.databaseId ? JSON.stringify([row.databaseId, row.dataRevision, row.schemaVersion]) : undefined;
  }
}
