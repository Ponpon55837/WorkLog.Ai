import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "@work-intelligence/shared";

/*
 * Versioned migrations. Each runs once, inside the caller's transaction, and is recorded in
 * schema_migrations. Older column additions stay in the idempotent checks in store.ts.
 */
interface SchemaMigration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    name: "search-index",
    // Triggers only mark documents dirty; the tokenizer lives in TypeScript, so the index is rebuilt
    // lazily before each query. Marking every existing document dirty is the backfill.
    sql: `
      CREATE TABLE IF NOT EXISTS search_chunks (
        id INTEGER PRIMARY KEY,
        doc_type TEXT NOT NULL CHECK (doc_type IN ('session', 'knowledge')),
        doc_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        field TEXT NOT NULL,
        heading TEXT,
        content TEXT NOT NULL,
        weight REAL NOT NULL,
        doc_date TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_search_chunks_doc ON search_chunks(doc_type, doc_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        tokens,
        content = '',
        contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 0'
      );
      CREATE TABLE IF NOT EXISTS search_paths (
        doc_type TEXT NOT NULL CHECK (doc_type IN ('session', 'knowledge')),
        doc_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        basename TEXT NOT NULL,
        weight REAL NOT NULL,
        doc_date TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_search_paths_doc ON search_paths(doc_type, doc_id);
      CREATE INDEX IF NOT EXISTS idx_search_paths_basename ON search_paths(basename);
      CREATE TABLE IF NOT EXISTS search_dirty (
        doc_type TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        PRIMARY KEY (doc_type, doc_id)
      ) WITHOUT ROWID;

      CREATE TRIGGER IF NOT EXISTS trg_search_sessions_insert AFTER INSERT ON sessions BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('session', NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_sessions_update AFTER UPDATE ON sessions BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('session', NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_sessions_delete AFTER DELETE ON sessions BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('session', OLD.id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_events_insert AFTER INSERT ON work_events BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('session', NEW.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_events_update AFTER UPDATE ON work_events BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('session', NEW.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_events_delete AFTER DELETE ON work_events BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('session', OLD.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_snapshots_insert AFTER INSERT ON raw_snapshots BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('session', NEW.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_snapshots_update AFTER UPDATE ON raw_snapshots BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('session', NEW.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_snapshots_delete AFTER DELETE ON raw_snapshots BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('session', OLD.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_knowledge_insert AFTER INSERT ON knowledge BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('knowledge', NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_knowledge_update AFTER UPDATE ON knowledge BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('knowledge', NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_search_knowledge_delete AFTER DELETE ON knowledge BEGIN
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES ('knowledge', OLD.id);
      END;

      INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) SELECT 'session', id FROM sessions;
      INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) SELECT 'knowledge', id FROM knowledge;
    `,
  },
  {
    version: 2,
    name: "void-sessions-and-evidence",
    sql: `
      ALTER TABLE sessions ADD COLUMN voided_at TEXT;
      ALTER TABLE sessions ADD COLUMN void_reason TEXT;
      ALTER TABLE evidence ADD COLUMN voided_at TEXT;
      ALTER TABLE evidence ADD COLUMN void_reason TEXT;
      CREATE TABLE IF NOT EXISTS void_audit (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK (target_type IN ('session', 'evidence')),
        target_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('voided', 'restored')),
        reason TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_void_audit_session ON void_audit(session_id, occurred_at DESC);
    `,
  },
  {
    version: 3,
    name: "verification-audit",
    sql: `
      CREATE TABLE IF NOT EXISTS session_verification_updates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('web', 'agent')),
        previous_json TEXT,
        resulting_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_verification_updates_session
        ON session_verification_updates(session_id, created_at DESC);
    `,
  },
  {
    version: 4,
    name: "session-links",
    // (session_id, related_session_id, 'continues') means session_id continues the work of the other.
    sql: `
      CREATE TABLE IF NOT EXISTS session_links (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        related_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN ('continues', 'related')),
        source TEXT NOT NULL CHECK (source IN ('web', 'agent')),
        created_at TEXT NOT NULL,
        CHECK (session_id <> related_session_id),
        UNIQUE (session_id, related_session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_links_related ON session_links(related_session_id);
    `,
  },
  {
    version: 5,
    name: "knowledge-trust",
    sql: `
      ALTER TABLE knowledge ADD COLUMN applies_to_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE knowledge ADD COLUMN last_confirmed_at TEXT;
      ALTER TABLE knowledge ADD COLUMN last_confirmed_session_id TEXT;
      ALTER TABLE knowledge ADD COLUMN supersedes_id TEXT;
      ALTER TABLE knowledge ADD COLUMN review_json TEXT;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Applies pending versioned migrations. Call inside an immediate transaction. */
export function applySchemaMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version),
  );
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec(migration.sql);
    record.run(migration.version, migration.name, nowIso());
  }
}
