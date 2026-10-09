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

/** Rewinds a fixture to a pre-migration schema while leaving foreign-key enforcement unchanged. */
export function undoMigrationsAfter(db: DatabaseSync, version: number): void {
  const applied = db
    .prepare("SELECT version FROM schema_migrations WHERE version > ? ORDER BY version DESC")
    .all(version) as Array<{ version: number }>;
  for (const migration of applied) undoSchemaMigration(db, migration.version);
}
