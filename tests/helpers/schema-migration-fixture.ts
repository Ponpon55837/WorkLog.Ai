import type { DatabaseSync } from "node:sqlite";
import { schemaMigrationSql } from "../../packages/storage/src/schema-migrations.js";

/** Removes one migration's schema objects; call in descending version order. */
export function undoSchemaMigration(db: DatabaseSync, version: number): void {
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
