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
  {
    version: 6,
    name: "session-started-updated-at",
    // Backfill: startedAt only from events recorded before completion (never guessed); updatedAt is
    // the latest recorded change to the Session, its evidence, or its links.
    sql: `
      ALTER TABLE sessions ADD COLUMN started_at TEXT;
      ALTER TABLE sessions ADD COLUMN updated_at TEXT;
      UPDATE sessions SET started_at = (
        SELECT MIN(e.occurred_at) FROM work_events e
        WHERE e.session_id = sessions.id AND e.occurred_at < sessions.completed_at
      );
      UPDATE sessions SET updated_at = MAX(
        created_at,
        COALESCE((SELECT MAX(created_at) FROM session_summary_updates u WHERE u.session_id = sessions.id), ''),
        COALESCE((SELECT MAX(created_at) FROM session_work_summary_updates u WHERE u.session_id = sessions.id), ''),
        COALESCE((SELECT MAX(created_at) FROM session_verification_updates u WHERE u.session_id = sessions.id), ''),
        COALESCE((SELECT MAX(occurred_at) FROM void_audit a WHERE a.session_id = sessions.id), ''),
        COALESCE((SELECT MAX(captured_at) FROM evidence v WHERE v.session_id = sessions.id), ''),
        COALESCE((SELECT MAX(created_at) FROM session_links l
          WHERE l.session_id = sessions.id OR l.related_session_id = sessions.id), '')
      );
    `,
  },
  {
    version: 7,
    name: "knowledge-candidates",
    sql: `
      CREATE TABLE IF NOT EXISTS knowledge_candidate_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        failure_reason TEXT,
        source_session_ids_json TEXT NOT NULL DEFAULT '[]',
        candidate_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_candidate_requests_project
        ON knowledge_candidate_requests(project_id, status, requested_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_candidates (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES knowledge_candidate_requests(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('decision', 'pattern', 'gotcha', 'procedure', 'skill')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        references_json TEXT NOT NULL DEFAULT '[]',
        applies_to_json TEXT NOT NULL DEFAULT '[]',
        rationale TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
        knowledge_id TEXT REFERENCES knowledge(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_project_status
        ON knowledge_candidates(project_id, status, created_at DESC);
    `,
  },
  {
    version: 8,
    name: "custom-report-synthesis-ranges",
    sql: `
      CREATE TABLE report_synthesis_requests_next (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'project')),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'year', 'custom')),
        range_from TEXT NOT NULL,
        range_to TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        failure_reason TEXT,
        source_session_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO report_synthesis_requests_next (
        id, idempotency_key, scope_type, project_id, period, range_from, range_to,
        status, requested_at, started_at, completed_at, failure_reason, source_session_ids_json
      )
      SELECT
        id, idempotency_key, scope_type, project_id, period, range_from, range_to,
        status, requested_at, started_at, completed_at, failure_reason, source_session_ids_json
      FROM report_synthesis_requests;

      CREATE TABLE report_summaries_next (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES report_synthesis_requests_next(id) ON DELETE CASCADE,
        period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'year', 'custom')),
        range_from TEXT NOT NULL,
        range_to TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        executive_summary TEXT NOT NULL,
        themes_json TEXT NOT NULL DEFAULT '[]',
        highlights_json TEXT NOT NULL DEFAULT '[]',
        verification_json TEXT NOT NULL DEFAULT '[]',
        comparison_json TEXT NOT NULL DEFAULT '[]',
        risks_json TEXT NOT NULL DEFAULT '[]',
        decisions_json TEXT NOT NULL DEFAULT '[]',
        next_steps_json TEXT NOT NULL DEFAULT '[]',
        source_session_ids_json TEXT NOT NULL DEFAULT '[]',
        generated_by_agent TEXT NOT NULL,
        generated_by_model TEXT,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
      );
      INSERT INTO report_summaries_next (
        id, request_id, period, range_from, range_to, project_id, title, executive_summary,
        themes_json, highlights_json, verification_json, comparison_json, risks_json, decisions_json,
        next_steps_json, source_session_ids_json, generated_by_agent, generated_by_model,
        prompt_version, created_at, is_current
      )
      SELECT
        id, request_id, period, range_from, range_to, project_id, title, executive_summary,
        themes_json, highlights_json, verification_json, comparison_json, risks_json, decisions_json,
        next_steps_json, source_session_ids_json, generated_by_agent, generated_by_model,
        prompt_version, created_at, is_current
      FROM report_summaries;

      DROP TABLE report_summaries;
      DROP TABLE report_synthesis_requests;
      ALTER TABLE report_synthesis_requests_next RENAME TO report_synthesis_requests;
      ALTER TABLE report_summaries_next RENAME TO report_summaries;
      CREATE INDEX IF NOT EXISTS idx_report_synthesis_requests_status ON report_synthesis_requests(status, requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_report_synthesis_requests_scope
        ON report_synthesis_requests(project_id, period, range_from, range_to, requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_report_summaries_request_created ON report_summaries(request_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_report_summaries_current_scope
        ON report_summaries(is_current, project_id, period, range_from, range_to, created_at DESC);
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
