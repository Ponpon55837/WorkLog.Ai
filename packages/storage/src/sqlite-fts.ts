import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

/*
 * A contentless_delete FTS5 table stores tombstone pages in its shadow table under rowids above
 * 2^53 (segment id + 2^16, shifted by 37 bits). Writing one leaves that value as the connection's
 * last insert rowid, and StatementSync.run() rejects it with ERR_OUT_OF_RANGE: the FTS write itself
 * and every later run() on the connection fail until a normal insert replaces the value.
 */

/** Runs a write against an FTS5 table without reading the connection's last insert rowid. */
export function runFtsWrite(statement: StatementSync, ...parameters: SQLInputValue[]): void {
  statement.all(...parameters);
}

/**
 * Replaces an FTS5 shadow rowid with 1 so later run() calls can report it. Call after FTS writes and
 * after the transaction that contains them commits, because merges at commit can write tombstones.
 * The one-row temp table lives only on this connection and never touches the database file.
 */
export function resetLastInsertRowid(db: DatabaseSync): void {
  db.exec(
    "CREATE TEMP TABLE IF NOT EXISTS work_intelligence_rowid_reset (id INTEGER PRIMARY KEY); " +
      "INSERT OR REPLACE INTO temp.work_intelligence_rowid_reset (id) VALUES (1);",
  );
}
