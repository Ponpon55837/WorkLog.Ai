import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applySchemaMigrations } from "../../packages/storage/src/schema-migrations.js";
import { initializeWorkIntelligenceDatabase } from "../../packages/storage/src/database-initialization.js";
import { undoMigrationsAfter } from "../helpers/schema-migration-fixture.js";

describe("custom report synthesis migration", () => {
  it("preserves existing requests and summaries while allowing custom periods", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES
          (1, 'search-index', '2026-09-01T00:00:00.000Z'),
          (2, 'void-sessions-and-evidence', '2026-09-01T00:00:00.000Z'),
          (3, 'verification-audit', '2026-09-01T00:00:00.000Z'),
          (4, 'session-links', '2026-09-01T00:00:00.000Z'),
          (5, 'knowledge-trust', '2026-09-01T00:00:00.000Z'),
          (6, 'session-started-updated-at', '2026-09-01T00:00:00.000Z'),
          (7, 'knowledge-candidates', '2026-09-01T00:00:00.000Z');
        CREATE TABLE projects (id TEXT PRIMARY KEY);
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          changed_files_json TEXT NOT NULL DEFAULT '[]',
          work_summary_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT '2026-09-01T00:00:00.000Z',
          updated_at TEXT
        );
        CREATE TABLE knowledge (id TEXT PRIMARY KEY);
        CREATE TABLE search_chunks (
          id INTEGER PRIMARY KEY,
          doc_type TEXT NOT NULL,
          doc_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          field TEXT NOT NULL,
          heading TEXT,
          content TEXT NOT NULL,
          weight REAL NOT NULL,
          doc_date TEXT NOT NULL
        );
        CREATE TABLE search_dirty (doc_type TEXT NOT NULL, doc_id TEXT NOT NULL, PRIMARY KEY (doc_type, doc_id))
          WITHOUT ROWID;
        CREATE TABLE knowledge_audit (
          id TEXT PRIMARY KEY,
          knowledge_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          after_json TEXT NOT NULL,
          changed_fields_json TEXT NOT NULL DEFAULT '[]',
          occurred_at TEXT NOT NULL
        );
        INSERT INTO sessions (id, changed_files_json)
        VALUES
          ('legacy-files', '["src/legacy.ts"]'),
          ('legacy-empty', '[]');
        CREATE TABLE report_synthesis_requests (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'project')),
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'year')),
          range_from TEXT NOT NULL,
          range_to TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
          requested_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          failure_reason TEXT,
          source_session_ids_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE report_summaries (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES report_synthesis_requests(id) ON DELETE CASCADE,
          period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'year')),
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
        INSERT INTO report_synthesis_requests (
          id, idempotency_key, scope_type, period, range_from, range_to,
          status, requested_at, completed_at, source_session_ids_json
        ) VALUES (
          'legacy-request', 'legacy-request-key', 'all', 'week', '2026-09-14', '2026-09-20',
          'completed', '2026-09-21T09:00:00.000Z', '2026-09-21T09:01:00.000Z', '["source-session"]'
        );
        INSERT INTO report_summaries (
          id, request_id, period, range_from, range_to, title, executive_summary,
          highlights_json, source_session_ids_json, generated_by_agent, generated_by_model,
          prompt_version, created_at, is_current
        ) VALUES (
          'legacy-summary', 'legacy-request', 'week', '2026-09-14', '2026-09-20',
          '舊版摘要', '既有摘要內容必須保留。', '[{"title":"成果"}]', '["source-session"]',
          'claude', 'legacy-model', 'report-synthesis-v3', '2026-09-21T09:01:00.000Z', 1
        );
      `);

      db.exec("BEGIN IMMEDIATE");
      applySchemaMigrations(db);
      db.exec("COMMIT");

      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 8").get()).toEqual({
        version: 8,
        name: "custom-report-synthesis-ranges",
      });
      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 10").get()).toEqual({
        version: 10,
        name: "confirmed-empty-changed-files",
      });
      expect(db.prepare("SELECT id, changed_files_confirmed FROM sessions ORDER BY id").all()).toEqual([
        { id: "legacy-empty", changed_files_confirmed: 0 },
        { id: "legacy-files", changed_files_confirmed: 1 },
      ]);
      expect(db.prepare("SELECT id, redaction_count FROM sessions ORDER BY id").all()).toEqual([
        { id: "legacy-empty", redaction_count: 0 },
        { id: "legacy-files", redaction_count: 0 },
      ]);
      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 14").get()).toEqual({
        version: 14,
        name: "session-redaction-count",
      });
      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 15").get()).toEqual({
        version: 15,
        name: "session-decisions",
      });
      expect(
        (db.prepare("PRAGMA table_info(session_decisions)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      ).toEqual([
        "id",
        "session_id",
        "project_id",
        "position",
        "text",
        "origin",
        "review_status",
        "reviewed_at",
        "knowledge_id",
      ]);
      expect(
        db
          .prepare("SELECT id, period, range_from, range_to, source_session_ids_json FROM report_synthesis_requests")
          .get(),
      ).toEqual({
        id: "legacy-request",
        period: "week",
        range_from: "2026-09-14",
        range_to: "2026-09-20",
        source_session_ids_json: '["source-session"]',
      });
      expect(
        db.prepare("SELECT id, title, executive_summary, generated_by_model, is_current FROM report_summaries").get(),
      ).toEqual({
        id: "legacy-summary",
        title: "舊版摘要",
        executive_summary: "既有摘要內容必須保留。",
        generated_by_model: "legacy-model",
        is_current: 1,
      });

      db.prepare(
        `INSERT INTO report_synthesis_requests (
          id, idempotency_key, scope_type, period, range_from, range_to, status, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("custom-request", "custom-request-key", "all", "custom", "2026-09-01", "2026-09-10", "pending", "now");
      db.prepare(
        `INSERT INTO report_summaries (
          id, request_id, period, range_from, range_to, title, executive_summary,
          generated_by_agent, prompt_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "custom-summary",
        "custom-request",
        "custom",
        "2026-09-01",
        "2026-09-10",
        "自訂摘要",
        "可儲存自訂期間摘要。",
        "codex",
        "report-synthesis-v3",
        "now",
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT period FROM report_summaries WHERE id = 'custom-summary'").get()).toEqual({
        period: "custom",
      });
    } finally {
      db.close();
    }
  });

  it("adds the content-free project location audit when upgrading from schema 12", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE projects (id TEXT PRIMARY KEY);
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          work_summary_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT '2026-09-01T00:00:00.000Z',
          updated_at TEXT
        );
        CREATE TABLE knowledge (id TEXT PRIMARY KEY);
        CREATE TABLE search_chunks (
          id INTEGER PRIMARY KEY,
          doc_type TEXT NOT NULL,
          doc_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          field TEXT NOT NULL,
          heading TEXT,
          content TEXT NOT NULL,
          weight REAL NOT NULL,
          doc_date TEXT NOT NULL
        );
        CREATE TABLE search_dirty (doc_type TEXT NOT NULL, doc_id TEXT NOT NULL, PRIMARY KEY (doc_type, doc_id))
          WITHOUT ROWID;
        CREATE TABLE knowledge_audit (
          id TEXT PRIMARY KEY,
          knowledge_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          after_json TEXT NOT NULL,
          changed_fields_json TEXT NOT NULL DEFAULT '[]',
          occurred_at TEXT NOT NULL
        );
      `);
      const markApplied = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
      for (let version = 1; version <= 12; version += 1) {
        markApplied.run(version, `legacy-${version}`, "2026-09-27T00:00:00.000Z");
      }

      applySchemaMigrations(db);

      expect(
        (db.prepare("PRAGMA table_info(project_location_audit)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      ).toEqual(["id", "changed_at", "project_id", "paths_changed"]);
      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 13").get()).toEqual({
        version: 13,
        name: "project-location-audit",
      });
      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 14").get()).toEqual({
        version: 14,
        name: "session-redaction-count",
      });
      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 15").get()).toEqual({
        version: 15,
        name: "session-decisions",
      });
      expect(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name),
      ).toContain("redaction_count");
    } finally {
      db.close();
    }
  });

  it("adds raw content hashes and schedules existing Sessions for index rebuild", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          work_summary_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT '2026-09-01T00:00:00.000Z',
          updated_at TEXT
        );
        CREATE TABLE search_chunks (
          id INTEGER PRIMARY KEY,
          doc_type TEXT NOT NULL,
          doc_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          field TEXT NOT NULL,
          heading TEXT,
          content TEXT NOT NULL,
          weight REAL NOT NULL,
          doc_date TEXT NOT NULL
        );
        CREATE TABLE search_dirty (
          doc_type TEXT NOT NULL,
          doc_id TEXT NOT NULL,
          PRIMARY KEY (doc_type, doc_id)
        ) WITHOUT ROWID;
        CREATE TABLE knowledge_pages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          title TEXT NOT NULL,
          question TEXT NOT NULL,
          sections_json TEXT NOT NULL DEFAULT '[]',
          version INTEGER NOT NULL DEFAULT 0,
          sourced_through TEXT,
          update_requested_at TEXT,
          last_author TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO sessions (id) VALUES ('legacy-plan'), ('legacy-clean');
        INSERT INTO search_chunks (doc_type, doc_id, project_id, field, content, weight, doc_date)
        VALUES ('session', 'legacy-plan', 'project', 'raw', 'old planning section', 0.2, '2026-09-01T00:00:00.000Z');
      `);
      const markApplied = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
      for (let version = 1; version <= 19; version += 1) {
        markApplied.run(version, `legacy-${version}`, "2026-09-27T00:00:00.000Z");
      }

      db.exec("BEGIN IMMEDIATE");
      applySchemaMigrations(db);
      db.exec("COMMIT");

      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 20").get()).toEqual({
        version: 20,
        name: "raw-handoff-content-hashes",
      });
      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 21").get()).toEqual({
        version: 21,
        name: "knowledge-page-review-checkpoint",
      });
      expect(
        (db.prepare("PRAGMA table_info(knowledge_pages)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      ).toContain("checked_through_session_id");
      expect(
        (db.prepare("PRAGMA table_info(search_chunks)").all() as Array<{ name: string }>).map((column) => column.name),
      ).toContain("content_hash");
      expect(db.prepare("SELECT content_hash FROM search_chunks WHERE id = 1").get()).toEqual({ content_hash: null });
      expect(db.prepare("SELECT doc_type, doc_id FROM search_dirty ORDER BY doc_id").all()).toEqual([
        { doc_type: "session", doc_id: "legacy-clean" },
        { doc_type: "session", doc_id: "legacy-plan" },
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_search_chunks_raw_content_hash'",
          )
          .get(),
      ).toEqual({ name: "idx_search_chunks_raw_content_hash" });
    } finally {
      db.close();
    }
  });
});

describe("outstanding item migration", () => {
  it("backfills every legacy nextSteps string as pending without inferring completion", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      db.prepare(
        `INSERT INTO projects (id, name, root_path, status, created_at, updated_at)
         VALUES (?, ?, ?, 'tracked', ?, ?)`,
      ).run(
        "legacy-project",
        "Legacy project",
        "/tmp/legacy-project",
        "2026-09-20T00:00:00.000Z",
        "2026-09-20T00:00:00.000Z",
      );
      const insertSession = db.prepare(
        `INSERT INTO sessions (
          id, project_id, idempotency_key, title, summary, work_summary_json, status,
          execution_status, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'finalized', 'completed', ?, ?, ?)`,
      );
      insertSession.run(
        "legacy-with-steps",
        "legacy-project",
        "legacy-with-steps-key",
        "Legacy work",
        "Legacy summary",
        JSON.stringify({ nextSteps: ["Looks complete", "Still unresolved"] }),
        "2026-09-20T00:00:00.000Z",
        "2026-09-20T00:00:00.000Z",
        "2026-09-21T00:00:00.000Z",
      );
      insertSession.run(
        "legacy-empty-steps",
        "legacy-project",
        "legacy-empty-key",
        "Legacy empty",
        "Legacy summary",
        JSON.stringify({ nextSteps: [] }),
        "2026-09-20T00:00:00.000Z",
        "2026-09-20T00:00:00.000Z",
        "2026-09-21T00:00:00.000Z",
      );
      insertSession.run(
        "legacy-invalid-json",
        "legacy-project",
        "legacy-invalid-key",
        "Legacy invalid",
        "Legacy summary",
        "not json",
        "2026-09-20T00:00:00.000Z",
        "2026-09-20T00:00:00.000Z",
        "2026-09-21T00:00:00.000Z",
      );
      insertSession.run(
        "legacy-non-array-steps",
        "legacy-project",
        "legacy-non-array-key",
        "Legacy non-array",
        "Legacy summary",
        JSON.stringify({ nextSteps: "Already done" }),
        "2026-09-20T00:00:00.000Z",
        "2026-09-20T00:00:00.000Z",
        "2026-09-21T00:00:00.000Z",
      );
      undoMigrationsAfter(db, 21);

      db.exec("BEGIN IMMEDIATE");
      applySchemaMigrations(db);
      db.exec("COMMIT");

      expect(
        db
          .prepare(
            "SELECT source_session_id, position, text, status FROM outstanding_items ORDER BY source_session_id, position",
          )
          .all(),
      ).toEqual([
        { source_session_id: "legacy-with-steps", position: 0, text: "Looks complete", status: "pending" },
        { source_session_id: "legacy-with-steps", position: 1, text: "Still unresolved", status: "pending" },
      ]);
      expect(
        db.prepare("SELECT from_status, to_status, source, actor_session_id FROM outstanding_item_events").all(),
      ).toEqual([
        { from_status: null, to_status: "pending", source: "migration", actor_session_id: null },
        { from_status: null, to_status: "pending", source: "migration", actor_session_id: null },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("outstanding cleanup review migration", () => {
  it("preserves schema-22 outstanding rows and leaves new audit links empty", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE projects (id TEXT PRIMARY KEY);
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          UNIQUE (id, project_id)
        );
        CREATE TABLE outstanding_items (
          id TEXT PRIMARY KEY,
          source_session_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE outstanding_item_events (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          source TEXT NOT NULL,
          actor_session_id TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations (version, name, applied_at)
          SELECT value, 'legacy-schema-version', '2026-09-30T00:00:00.000Z'
          FROM json_each('[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22]');
        INSERT INTO projects (id) VALUES ('migration-project');
        INSERT INTO sessions (id, project_id) VALUES ('migration-session', 'migration-project');
        INSERT INTO outstanding_items (
          id, source_session_id, project_id, position, text, status, created_at, updated_at
        ) VALUES (
          'migration-item', 'migration-session', 'migration-project', 0, 'Pending survives migration',
          'pending', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'
        );
        INSERT INTO outstanding_item_events (
          id, item_id, project_id, from_status, to_status, source, actor_session_id, created_at
        ) VALUES (
          'migration-event', 'migration-item', 'migration-project', NULL, 'pending', 'migration', NULL,
          '2026-09-20T00:00:00.000Z'
        );
      `);

      db.exec("BEGIN IMMEDIATE");
      applySchemaMigrations(db);
      db.exec("COMMIT");

      expect(db.prepare("SELECT id, status FROM outstanding_items").all()).toEqual([
        { id: "migration-item", status: "pending" },
      ]);
      expect(
        db.prepare("SELECT id, cleanup_request_id, cleanup_proposal_id FROM outstanding_item_events").all(),
      ).toEqual([{ id: "migration-event", cleanup_request_id: null, cleanup_proposal_id: null }]);
      expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 23").get()).toEqual({
        version: 23,
        name: "outstanding-cleanup-review",
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
