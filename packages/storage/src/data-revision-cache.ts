import type { DatabaseSync } from "node:sqlite";

const MAX_CACHED_KEYS = 64;

/*
 * A cached value is never stale because the key joins `change_revisions.data_revision` (bumped by triggers in the
 * write's own transaction, shared by all processes), `database_id` and SQLite's `schema_version`, read in one
 * statement before the value is computed. Nothing is cached or served inside an open transaction: a rollback plus
 * another process's commit could reuse a revision number for different data. Callers key by everything else the read
 * depends on, such as the project id.
 */
export class DataRevisionCache<T> {
  private revisionKey: string | undefined;
  private readonly values = new Map<string, T>();

  public constructor(
    private readonly db: DatabaseSync,
    private readonly maxKeys = MAX_CACHED_KEYS,
  ) {}

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
    if (this.values.size >= this.maxKeys) this.values.clear();
    this.values.set(key, value);
    return value;
  }

  public getMany(
    keys: readonly string[],
    computeMissing: (missing: string[]) => { values: Map<string, T>; cacheable: boolean },
  ): Map<string, T> {
    const revisionKey = this.db.isTransaction ? undefined : this.readRevisionKey();
    if (revisionKey !== undefined && revisionKey !== this.revisionKey) {
      this.values.clear();
      this.revisionKey = revisionKey;
    }
    const result = new Map<string, T>();
    const missing: string[] = [];
    for (const key of keys) {
      if (revisionKey !== undefined && this.values.has(key)) result.set(key, this.values.get(key)!);
      else missing.push(key);
    }
    if (missing.length === 0) return result;
    const computed = computeMissing(missing);
    for (const [key, value] of computed.values) {
      result.set(key, value);
    }
    // A batch larger than the cap is not remembered at all, so the cache never holds more than maxKeys values.
    if (revisionKey !== undefined && computed.cacheable && computed.values.size <= this.maxKeys) {
      if (this.values.size + computed.values.size > this.maxKeys) this.values.clear();
      for (const [key, value] of computed.values) this.values.set(key, value);
    }
    return result;
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
