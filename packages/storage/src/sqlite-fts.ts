import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

/*
 * A contentless_delete FTS5 table writes tombstone rowids above 2^53, which become the connection's last insert rowid;
 * StatementSync.run() then rejects it with ERR_OUT_OF_RANGE until a normal insert replaces the value.
 */

export function runFtsWrite(statement: StatementSync, ...parameters: SQLInputValue[]): void {
  statement.all(...parameters);
}

/** Call after FTS writes and again after their transaction commits, because merges at commit can write tombstones. */
export function resetLastInsertRowid(db: DatabaseSync): void {
  db.exec(
    "CREATE TEMP TABLE IF NOT EXISTS work_intelligence_rowid_reset (id INTEGER PRIMARY KEY); " +
      "INSERT OR REPLACE INTO temp.work_intelligence_rowid_reset (id) VALUES (1);",
  );
}
