import type { DatabaseSync } from "node:sqlite";
import { schemaMigrationSql } from "../../packages/storage/src/schema-migrations.js";

/** Removes one migration's schema objects; call in descending version order. */
export function undoSchemaMigration(db: DatabaseSync, version: number): void {
  if (version === 27) {
    db.exec(`CREATE TABLE session_diagrams_v26 (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL,
      title TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('mermaid')), source TEXT NOT NULL,
      created_at TEXT NOT NULL, voided_at TEXT, void_reason TEXT, UNIQUE (session_id, idempotency_key)
    );
    INSERT INTO session_diagrams_v26 SELECT id, session_id, project_id, idempotency_key, title, kind, source, created_at, voided_at, void_reason FROM session_diagrams ORDER BY rowid;
    DROP TABLE session_diagrams;
    ALTER TABLE session_diagrams_v26 RENAME TO session_diagrams;
    CREATE INDEX idx_session_diagrams_session ON session_diagrams(session_id, created_at);`);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
    return;
  }
  if (version === 38) {
    const triggers = ["insert", "update", "delete"]
      .map(
        (operation) => `CREATE TRIGGER trg_data_revision_agent_review_request_items_${operation}
        AFTER ${operation.toUpperCase()} ON agent_review_request_items BEGIN
          UPDATE change_revisions SET data_revision = data_revision + 1 WHERE singleton = 1;
        END;`,
      )
      .join("\n");
    db.exec(`CREATE TEMP TABLE agent_review_request_items_v38 AS SELECT * FROM agent_review_request_items
      WHERE item_kind <> 'knowledge' AND (verdict IS NULL OR verdict NOT IN ('archive', 'supersede')) ORDER BY rowid;
    DROP TABLE agent_review_request_items;
    CREATE TABLE agent_review_request_items (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      item_kind TEXT NOT NULL CHECK (item_kind IN ('decision', 'candidate')), item_id TEXT NOT NULL,
      source_session_id TEXT, position INTEGER NOT NULL CHECK (position >= 0), fingerprint TEXT NOT NULL,
      submission_id TEXT, verdict TEXT CHECK (verdict IN ('confirm', 'reject', 'promote', 'accept')),
      outcome TEXT CHECK (outcome IN ('applied', 'skipped_stale', 'skipped_reviewed')), reason TEXT,
      knowledge_id TEXT REFERENCES knowledge(id) ON DELETE SET NULL, decided_at TEXT, overturned_at TEXT,
      UNIQUE (request_id, item_kind, item_id), UNIQUE (request_id, position),
      FOREIGN KEY (request_id, project_id) REFERENCES agent_review_requests(id, project_id) ON DELETE CASCADE
    );
    INSERT INTO agent_review_request_items SELECT * FROM temp.agent_review_request_items_v38 ORDER BY rowid;
    DROP TABLE temp.agent_review_request_items_v38;
    CREATE INDEX idx_agent_review_items_item ON agent_review_request_items(project_id, item_kind, item_id);
    CREATE INDEX idx_agent_review_items_source_session ON agent_review_request_items(source_session_id)
      WHERE source_session_id IS NOT NULL;
    ${triggers}`);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
    return;
  }
  const sql = schemaMigrationSql(version);
  if (!sql) throw new RangeError(`Unknown schema migration: ${version}`);

  for (const [, name] of sql.matchAll(/CREATE\s+TRIGGER\s+(\w+)/gi)) {
    db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
  for (const [, name] of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)) {
    db.exec(`DROP INDEX IF EXISTS "${name}"`);
  }
  for (const [, table, column] of sql.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
    db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
  }
  for (const [, name] of [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)].reverse()) {
    db.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
}

export function undoMigrationsAfter(db: DatabaseSync, version: number): void {
  const applied = db
    .prepare("SELECT version FROM schema_migrations WHERE version > ? ORDER BY version DESC")
    .all(version) as Array<{ version: number }>;
  // Each DROP commits and fsyncs on its own outside a transaction; one transaction makes the rewind a single commit.
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN");
  try {
    for (const migration of applied) undoSchemaMigration(db, migration.version);
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
