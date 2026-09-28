import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "@work-intelligence/shared";

/*
 * Versioned migrations. Each runs once, inside the caller's transaction, and is recorded in
 * schema_migrations. Older column additions stay in the idempotent checks in database-initialization.ts.
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
  {
    version: 9,
    name: "project-data-import-audit",
    sql: `
      CREATE TABLE IF NOT EXISTS project_data_import_audits (
        id TEXT PRIMARY KEY,
        source_digest TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        additions_json TEXT NOT NULL,
        skipped_json TEXT NOT NULL,
        conflicts_json TEXT NOT NULL,
        remapped_paths_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_data_import_audits_imported_at
        ON project_data_import_audits(imported_at DESC);
    `,
  },
  {
    version: 10,
    name: "confirmed-empty-changed-files",
    sql: `
      ALTER TABLE sessions ADD COLUMN changed_files_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK (changed_files_confirmed IN (0, 1));
      UPDATE sessions
      SET changed_files_confirmed = 1
      WHERE json_valid(changed_files_json)
        AND json_type(changed_files_json) = 'array'
        AND json_array_length(changed_files_json) > 0;
    `,
  },
  {
    version: 11,
    name: "project-deletion-audit",
    sql: `
      CREATE TABLE IF NOT EXISTS project_deletion_audit (
        id TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL,
        project_id TEXT NOT NULL,
        deleted_counts_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_deletion_audit_project_deleted
        ON project_deletion_audit(project_id, deleted_at DESC);
    `,
  },
  {
    version: 12,
    name: "database-maintenance-history",
    sql: `
      CREATE TABLE IF NOT EXISTS database_maintenance_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        backup_file_name TEXT NOT NULL,
        indexed_sessions INTEGER NOT NULL DEFAULT 0 CHECK (indexed_sessions >= 0),
        indexed_knowledge INTEGER NOT NULL DEFAULT 0 CHECK (indexed_knowledge >= 0),
        indexed_chunks INTEGER NOT NULL DEFAULT 0 CHECK (indexed_chunks >= 0),
        indexed_paths INTEGER NOT NULL DEFAULT 0 CHECK (indexed_paths >= 0),
        failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
          'DATABASE_INTEGRITY_FAILED', 'DATABASE_MAINTENANCE_FAILED'
        ))
      );
      CREATE INDEX IF NOT EXISTS idx_database_maintenance_runs_started
        ON database_maintenance_runs(started_at DESC);
    `,
  },
  {
    version: 13,
    name: "project-location-audit",
    sql: `
      CREATE TABLE IF NOT EXISTS project_location_audit (
        id TEXT PRIMARY KEY,
        changed_at TEXT NOT NULL,
        project_id TEXT NOT NULL,
        paths_changed INTEGER NOT NULL CHECK (paths_changed IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS idx_project_location_audit_project_changed
        ON project_location_audit(project_id, changed_at DESC);
    `,
  },
  {
    version: 14,
    name: "session-redaction-count",
    sql: `
      ALTER TABLE sessions ADD COLUMN redaction_count INTEGER NOT NULL DEFAULT 0
        CHECK (redaction_count >= 0);
    `,
  },
  {
    version: 15,
    name: "session-decisions",
    sql: `
      CREATE TABLE session_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        text TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('user_requested', 'agent_autonomous', 'unspecified')),
        review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'confirmed', 'rejected', 'promoted')),
        reviewed_at TEXT,
        knowledge_id TEXT REFERENCES knowledge(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX idx_session_decisions_session_position
        ON session_decisions(session_id, position);
      CREATE INDEX idx_session_decisions_pending_project
        ON session_decisions(project_id, review_status, session_id)
        WHERE origin = 'agent_autonomous';
    `,
  },
  {
    version: 16,
    name: "knowledge-pages",
    sql: `
      CREATE TABLE knowledge_pages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        sections_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        sourced_through TEXT,
        update_requested_at TEXT,
        last_author TEXT CHECK (last_author IS NULL OR last_author IN ('agent', 'web')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_knowledge_pages_project_slug ON knowledge_pages(project_id, slug);
      CREATE TABLE knowledge_page_versions (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        sections_json TEXT NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('agent', 'web')),
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_knowledge_page_versions_page_version ON knowledge_page_versions(page_id, version);
      CREATE UNIQUE INDEX idx_knowledge_page_versions_idempotency
        ON knowledge_page_versions(page_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    version: 17,
    name: "knowledge-feedback",
    // Backfills only audit rows whose meaning is certain: a Session confirmation records that Session in
    // lastConfirmedSessionId at the audit time, a contradiction records review.sessionId at the audit time, and
    // a manual confirmation sets lastConfirmedAt to the audit time with no Session. The audit id is reused,
    // so a feedback row points back to the change that created it.
    sql: `
      CREATE TABLE knowledge_feedback (
        id TEXT PRIMARY KEY,
        knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('applied', 'contradicted', 'manual_confirm')),
        occurred_at TEXT NOT NULL,
        CHECK ((kind = 'manual_confirm') = (session_id IS NULL))
      );
      CREATE INDEX idx_knowledge_feedback_knowledge ON knowledge_feedback(knowledge_id, occurred_at DESC);
      CREATE UNIQUE INDEX idx_knowledge_feedback_session
        ON knowledge_feedback(knowledge_id, session_id, kind) WHERE session_id IS NOT NULL;
      INSERT OR IGNORE INTO knowledge_feedback (id, knowledge_id, project_id, session_id, kind, occurred_at)
      SELECT a.id, a.knowledge_id, a.project_id, s.id, 'applied', a.occurred_at
      FROM knowledge_audit a
      JOIN sessions s
        ON s.id = json_extract(a.after_json, '$.lastConfirmedSessionId') AND s.project_id = a.project_id
      WHERE EXISTS (SELECT 1 FROM json_each(a.changed_fields_json) WHERE value = 'lastConfirmedAt')
        AND json_extract(a.after_json, '$.lastConfirmedAt') = a.occurred_at;
      INSERT OR IGNORE INTO knowledge_feedback (id, knowledge_id, project_id, session_id, kind, occurred_at)
      SELECT a.id, a.knowledge_id, a.project_id, NULL, 'manual_confirm', a.occurred_at
      FROM knowledge_audit a
      WHERE EXISTS (SELECT 1 FROM json_each(a.changed_fields_json) WHERE value = 'lastConfirmedAt')
        AND json_extract(a.after_json, '$.lastConfirmedAt') = a.occurred_at
        AND json_extract(a.after_json, '$.lastConfirmedSessionId') IS NULL;
      INSERT OR IGNORE INTO knowledge_feedback (id, knowledge_id, project_id, session_id, kind, occurred_at)
      SELECT a.id, a.knowledge_id, a.project_id, s.id, 'contradicted', a.occurred_at
      FROM knowledge_audit a
      JOIN sessions s
        ON s.id = json_extract(a.after_json, '$.review.sessionId') AND s.project_id = a.project_id
      WHERE EXISTS (SELECT 1 FROM json_each(a.changed_fields_json) WHERE value = 'review')
        AND NOT EXISTS (SELECT 1 FROM json_each(a.changed_fields_json) WHERE value = 'lastConfirmedAt')
        AND json_extract(a.after_json, '$.review.reason') = 'contradicted'
        AND json_extract(a.after_json, '$.review.at') = a.occurred_at;
    `,
  },
  {
    version: 18,
    name: "project-repository-url",
    sql: `
      ALTER TABLE projects ADD COLUMN repository_url TEXT;
    `,
  },
  {
    version: 19,
    name: "session-diagrams",
    sql: `
      CREATE TABLE session_diagrams (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('mermaid')),
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        voided_at TEXT,
        void_reason TEXT,
        UNIQUE (session_id, idempotency_key)
      );
      CREATE INDEX idx_session_diagrams_session ON session_diagrams(session_id, created_at);
    `,
  },
  {
    version: 20,
    name: "raw-handoff-content-hashes",
    // search_chunks is a derived index, so legacy Sessions are lazily rebuilt before their next search.
    sql: `
      ALTER TABLE search_chunks ADD COLUMN content_hash TEXT;
      CREATE INDEX idx_search_chunks_raw_content_hash
        ON search_chunks(project_id, content_hash, doc_date, doc_id)
        WHERE field = 'raw' AND content_hash IS NOT NULL;
      INSERT OR IGNORE INTO search_dirty (doc_type, doc_id)
      SELECT 'session', id FROM sessions;
    `,
  },
  {
    version: 21,
    name: "knowledge-page-review-checkpoint",
    sql: `
      ALTER TABLE knowledge_pages
        ADD COLUMN checked_through_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** The SQL of one migration, for tests that rebuild the database as it was before that migration. */
export function schemaMigrationSql(version: number): string | undefined {
  return MIGRATIONS.find((migration) => migration.version === version)?.sql;
}

export function getAppliedSchemaVersions(db: DatabaseSync): number[] {
  const tableExists = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!tableExists) {
    return [];
  }
  return (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
    (row) => row.version,
  );
}

export function getNextPendingSchemaMigrationVersion(db: DatabaseSync): number | undefined {
  const applied = new Set(getAppliedSchemaVersions(db));
  return MIGRATIONS.find((migration) => !applied.has(migration.version))?.version;
}

/** Applies pending versioned migrations. Call inside an immediate transaction. */
export function applySchemaMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(getAppliedSchemaVersions(db));
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec(migration.sql);
    record.run(migration.version, migration.name, nowIso());
  }
}
