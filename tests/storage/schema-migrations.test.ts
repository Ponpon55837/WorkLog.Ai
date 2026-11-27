import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applySchemaMigrations as applyRuntimeMigrations,
  LATEST_SCHEMA_VERSION,
  schemaMigrationSql,
} from "../../packages/storage/src/schema-migrations.js";
import { initializeWorkIntelligenceDatabase } from "../../packages/storage/src/database-initialization.js";
import { undoMigrationsAfter } from "../helpers/schema-migration-fixture.js";

const migration31ProjectDataTables = [
  "projects",
  "sessions",
  "work_events",
  "raw_snapshots",
  "evidence",
  "void_audit",
  "session_verification_updates",
  "session_links",
  "knowledge",
  "session_decisions",
  "knowledge_pages",
  "knowledge_page_versions",
  "session_diagrams",
  "knowledge_audit",
  "knowledge_feedback",
  "knowledge_candidate_requests",
  "knowledge_candidates",
  "report_synthesis_requests",
  "report_summaries",
  "report_presentations",
  "attention_preferences",
  "metadata_backfill_requests",
  "session_summary_updates",
  "session_work_summary_updates",
  "outstanding_items",
  "outstanding_item_events",
  "outstanding_cleanup_requests",
  "outstanding_cleanup_submissions",
  "outstanding_cleanup_request_items",
  "outstanding_cleanup_proposals",
  "outstanding_cleanup_proposal_evidence",
  "agent_review_requests",
  "agent_review_submissions",
  "agent_review_request_items",
] as const;

const migration31Operations = ["INSERT", "UPDATE", "DELETE"] as const;

function normalizeSql(sql: string | undefined): string {
  return (sql ?? "").replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function migration31DataRevisionTriggerSql(
  table: (typeof migration31ProjectDataTables)[number],
  operation: (typeof migration31Operations)[number],
): string {
  return (
    "CREATE TRIGGER trg_data_revision_" +
    table +
    "_" +
    operation.toLowerCase() +
    " AFTER " +
    operation +
    " ON " +
    table +
    " BEGIN UPDATE change_revisions SET data_revision = data_revision + 1 WHERE singleton = 1; END;"
  );
}

function migration31AgentReadRevisionTriggerSql(operation: (typeof migration31Operations)[number]): string {
  return (
    "CREATE TRIGGER trg_agent_read_revision_" +
    operation.toLowerCase() +
    " AFTER " +
    operation +
    " ON agent_read_audit BEGIN UPDATE change_revisions SET audit_revision = audit_revision + 1 WHERE singleton = 1; END;"
  );
}

function expectedMigration31RevisionTriggers(): Array<{ name: string; sql: string }> {
  const dataTriggers = migration31ProjectDataTables.flatMap((table) =>
    migration31Operations.map((operation) => ({
      name: "trg_data_revision_" + table + "_" + operation.toLowerCase(),
      sql: migration31DataRevisionTriggerSql(table, operation),
    })),
  );
  const agentReadTriggers = migration31Operations.map((operation) => ({
    name: "trg_agent_read_revision_" + operation.toLowerCase(),
    sql: migration31AgentReadRevisionTriggerSql(operation),
  }));
  return [...dataTriggers, ...agentReadTriggers].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function applySchemaMigrations(db: DatabaseSync): void {
  for (const [table, version] of [
    ["report_synthesis_requests", 8],
    ["metadata_backfill_requests", 0],
    ["knowledge", 0],
    ["session_decisions", 15],
    ["knowledge_pages", 16],
  ] as const) {
    if (
      (version === 0 || db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)) &&
      !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
    )
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
  }
  // Migration 36 indexes these two tables on columns the id-only stubs above do not have.
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_candidates (id TEXT PRIMARY KEY, project_id TEXT, decided_at TEXT);
  `);
  for (const column of ["project_id", "origin", "reviewed_at"]) {
    const columns = db.prepare("PRAGMA table_info(session_decisions)").all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some((entry) => entry.name === column))
      db.exec(`ALTER TABLE session_decisions ADD COLUMN ${column} TEXT`);
  }
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (31, 'database-change-revisions', 'fixture')",
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (33, 'candidate-overlaps-and-session-lookups', 'fixture')",
  ).run();
  applyRuntimeMigrations(db);
}

describe("related work file posting migration", () => {
  it("upgrades 27, schedules existing Sessions and creates a covering seek", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 27);
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec(
        "INSERT INTO sessions (id,project_id,idempotency_key,title,summary,completed_at,status,created_at) VALUES ('s','p','legacy','Legacy','Saved','2026-10-01','finalized','2026-10-01')",
      );
      applySchemaMigrations(db);
      expect(db.prepare("SELECT session_id FROM related_work_dirty").all()).toEqual([{ session_id: "s" }]);
      expect(
        JSON.stringify(
          db
            .prepare(
              "EXPLAIN QUERY PLAN SELECT doc_id FROM related_work_paths WHERE project_id='p' AND path='src/a.ts' ORDER BY doc_date DESC,doc_id LIMIT 1001",
            )
            .all(),
        ),
      ).toContain("idx_related_work_project_path");
    } finally {
      db.close();
    }
  });
});

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

      // Partial legacy fixtures marked migration 19 as applied; include its diagram table before the rebuild.
      if (
        db.prepare("SELECT 1 FROM schema_migrations WHERE version = 19").get() &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_diagrams'").get()
      )
        db.exec(schemaMigrationSql(19)!);
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
        "reviewed_by",
        "review_reason",
        "review_request_id",
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

      if (
        db.prepare("SELECT 1 FROM schema_migrations WHERE version = 19").get() &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_diagrams'").get()
      )
        db.exec(schemaMigrationSql(19)!);
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

      if (
        db.prepare("SELECT 1 FROM schema_migrations WHERE version = 19").get() &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_diagrams'").get()
      )
        db.exec(schemaMigrationSql(19)!);
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

      if (
        db.prepare("SELECT 1 FROM schema_migrations WHERE version = 19").get() &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_diagrams'").get()
      )
        db.exec(schemaMigrationSql(19)!);
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

  it("adds empty agent source columns on upgrade from schema 23 and leaves old Sessions unknown", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      db.exec(
        "INSERT INTO projects (id, name, root_path, status, created_at, updated_at) VALUES ('p1', 'Fiction', '/fiction', 'tracked', 't', 't')",
      );
      undoMigrationsAfter(db, 23);
      db.exec(
        "INSERT INTO sessions (id, project_id, idempotency_key, title, summary, status, completed_at, created_at) VALUES ('s1', 'p1', 'k1', 'Old', 'Old summary', 'finalized', 't', 't')",
      );
      expect(db.prepare("SELECT name FROM pragma_table_info('sessions') WHERE name LIKE 'agent_%'").all()).toEqual([]);

      if (
        db.prepare("SELECT 1 FROM schema_migrations WHERE version = 19").get() &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_diagrams'").get()
      )
        db.exec(schemaMigrationSql(19)!);
      db.exec("BEGIN IMMEDIATE");
      applySchemaMigrations(db);
      db.exec("COMMIT");

      expect(db.prepare("SELECT agent_client, agent_model FROM sessions WHERE id = 's1'").get()).toEqual({
        agent_client: null,
        agent_model: null,
      });
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 24").get()).toEqual({
        name: "session-agent-source",
      });
    } finally {
      db.close();
    }
  });

  it("adds the empty Agent read audit tables on upgrade from schema 24", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 24);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'agent_read_audit%'").all()).toEqual([]);

      if (
        db.prepare("SELECT 1 FROM schema_migrations WHERE version = 19").get() &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_diagrams'").get()
      )
        db.exec(schemaMigrationSql(19)!);
      db.exec("BEGIN IMMEDIATE");
      applySchemaMigrations(db);
      db.exec("COMMIT");

      expect(db.prepare("SELECT COUNT(*) AS count FROM agent_read_audit").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM agent_read_audit_records").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 25").get()).toEqual({
        name: "agent-read-audit",
      });
    } finally {
      db.close();
    }
  });

  it("adds the Session deletion audit and lets item history cascade only after its item on upgrade from schema 25", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 25);
      // Rewinding drops the replaced trigger too; restore the schema-25 definition it upgrades from.
      db.exec(`CREATE TRIGGER trg_outstanding_item_events_no_delete
        BEFORE DELETE ON outstanding_item_events
        WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) BEGIN
          SELECT RAISE(ABORT, 'outstanding item events are append-only');
        END`);

      if (
        db.prepare("SELECT 1 FROM schema_migrations WHERE version = 19").get() &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_diagrams'").get()
      )
        db.exec(schemaMigrationSql(19)!);
      db.exec("BEGIN IMMEDIATE");
      applySchemaMigrations(db);
      db.exec("COMMIT");

      expect(db.prepare("SELECT COUNT(*) AS count FROM session_deletion_audit").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 26").get()).toEqual({
        name: "session-permanent-deletion",
      });
      const trigger = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_outstanding_item_events_no_delete'",
        )
        .get() as { sql: string };
      expect(trigger.sql).toContain("FROM outstanding_items WHERE id = OLD.item_id");
    } finally {
      db.close();
    }
  });
});

describe("versioned diagrams migration", () => {
  it("upgrades 26 to 27 preserving Mermaid rows, tie order, void state and constraints", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 26);
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(`INSERT INTO session_diagrams (id, session_id, project_id, idempotency_key, title, kind, source, created_at, voided_at, void_reason)
        VALUES ('z-first','s','p','one','First','mermaid','flowchart LR; A --> B','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z','Old'),
        ('a-second','s','p','two','Second','mermaid','flowchart LR; B --> C','2026-10-01T00:00:00Z',NULL,NULL);`);
      applySchemaMigrations(db);
      expect(
        db.prepare("SELECT id, format_version, void_reason FROM session_diagrams ORDER BY created_at, rowid").all(),
      ).toEqual([
        { id: "z-first", format_version: 1, void_reason: "Old" },
        { id: "a-second", format_version: 1, void_reason: null },
      ]);
      expect(() => db.exec("UPDATE session_diagrams SET kind = 'html'")).toThrow();
      expect(() => db.exec("UPDATE session_diagrams SET format_version = 0")).toThrow();
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='idx_session_diagrams_session'").get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });
});

describe("attention display preference migration", () => {
  it("upgrades schema 29 while preserving original sources and starts with no hidden issues", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 29);
      db.exec(
        "INSERT INTO projects (id,name,root_path,status,created_at,updated_at) VALUES ('fictional','Orchard','/fictional/orchard','tracked','2026-09-01','2026-09-01')",
      );
      applySchemaMigrations(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM attention_preferences").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT status FROM projects WHERE id='fictional'").get()).toEqual({ status: "tracked" });
      expect(
        JSON.stringify(
          db
            .prepare(
              "EXPLAIN QUERY PLAN SELECT * FROM attention_preferences WHERE project_id='fictional' AND kind='decision' AND source_id='source'",
            )
            .all(),
        ),
      ).toContain("sqlite_autoindex_attention_preferences");
    } finally {
      db.close();
    }
  });
});

describe("database change revision migration", () => {
  it("upgrades schema 30 with one database identity and revision counters", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 30);
      const futureTable = "future_project_data";
      db.exec("CREATE TABLE " + futureTable + " (id TEXT PRIMARY KEY)");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='change_revisions'").get()).toBe(
        undefined,
      );

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: LATEST_SCHEMA_VERSION,
      });
      expect(
        db.prepare("SELECT singleton, database_id, data_revision, audit_revision FROM change_revisions").get(),
      ).toMatchObject({
        singleton: 1,
        data_revision: 0,
        audit_revision: 0,
      });
      expect(db.prepare("SELECT database_id FROM change_revisions").get()).toMatchObject({
        database_id: expect.any(String),
      });
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_data_revision_sessions_insert'")
          .get(),
      ).toBeDefined();
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_agent_read_revision_insert'")
          .get(),
      ).toBeDefined();
      const changeRevisionsSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='change_revisions'")
        .get() as { sql: string } | undefined;
      expect(normalizeSql(changeRevisionsSql?.sql)).toBe(
        "CREATE TABLE change_revisions ( singleton INTEGER PRIMARY KEY CHECK (singleton = 1), database_id TEXT NOT NULL, data_revision INTEGER NOT NULL CHECK (data_revision >= 0), audit_revision INTEGER NOT NULL CHECK (audit_revision >= 0) )",
      );
      const actualRevisionTriggers = db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND (name GLOB 'trg_data_revision_*' OR name GLOB 'trg_agent_read_revision_*') ORDER BY name",
        )
        .all() as Array<{ name: string; sql: string }>;
      const expectedRevisionTriggers = expectedMigration31RevisionTriggers();
      expect(actualRevisionTriggers.map(({ name }) => name)).toEqual(expectedRevisionTriggers.map(({ name }) => name));
      const actualTriggerSql = new Map(actualRevisionTriggers.map(({ name, sql }) => [name, sql]));
      for (const expected of expectedRevisionTriggers) {
        expect(normalizeSql(actualTriggerSql.get(expected.name))).toBe(normalizeSql(expected.sql));
      }
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'trg_data_revision_future_project_data_*'",
          )
          .all(),
      ).toEqual([]);
      expect(schemaMigrationSql(31) ?? "").not.toContain(futureTable);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_data_revision_search_chunks_insert'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("agent read audit timing migration", () => {
  it("upgrades schema 31 leaving old audit rows with unknown duration and error code", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 31);
      db.exec(`INSERT INTO agent_read_audit
        (id, created_at, tool, agent_client, project_id, outcome, returned_count, session_ids_json, knowledge_ids_json,
         omitted_session_count, omitted_knowledge_count)
        VALUES ('old-read', '2026-11-01T00:00:00.000Z', 'work_search', 'Fictional Agent', NULL, 'ok', 0, '[]', '[]', 0, 0)`);
      const before = db.prepare("SELECT data_revision, audit_revision FROM change_revisions").get() as {
        data_revision: number;
        audit_revision: number;
      };

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: LATEST_SCHEMA_VERSION,
      });
      expect(db.prepare("SELECT id, duration_ms, error_code FROM agent_read_audit").all()).toEqual([
        { id: "old-read", duration_ms: null, error_code: null },
      ]);
      db.exec(`INSERT INTO agent_read_audit
        (id, created_at, tool, outcome, returned_count, session_ids_json, knowledge_ids_json,
         omitted_session_count, omitted_knowledge_count, duration_ms, error_code)
        VALUES ('new-read', '2026-11-02T00:00:00.000Z', 'work_search', 'error', 0, '[]', '[]', 0, 0, 12, 'database_busy')`);
      expect(db.prepare("SELECT data_revision, audit_revision FROM change_revisions").get()).toEqual({
        data_revision: before.data_revision,
        audit_revision: before.audit_revision + 1,
      });
    } finally {
      db.close();
    }
  });
});

describe("candidate overlap and Session lookup migration", () => {
  it("upgrades schema 32 with an empty advisory column and two indexes, changing no row", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 32);
      db.exec(`INSERT INTO projects (id, name, root_path, status, created_at, updated_at)
        VALUES ('meadow', 'Meadow', '/fictional/meadow', 'tracked', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
      const revisions = db.prepare("SELECT data_revision, audit_revision FROM change_revisions").get();

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 33").get()).toEqual({ version: 33 });
      expect(
        (db.prepare("PRAGMA table_info(knowledge_candidates)").all() as Array<Record<string, unknown>>).find(
          (column) => column.name === "overlaps_json",
        ),
      ).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
      const indexes = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (?, ?) ORDER BY name")
        .all("idx_sessions_commit_sha", "idx_sessions_live_project") as Array<{ name: string; sql: string }>;
      expect(indexes.map(({ name, sql }) => ({ name, sql: normalizeSql(sql) }))).toEqual([
        { name: "idx_sessions_commit_sha", sql: "CREATE INDEX idx_sessions_commit_sha ON sessions(commit_sha)" },
        {
          name: "idx_sessions_live_project",
          sql: "CREATE INDEX idx_sessions_live_project ON sessions(project_id) WHERE voided_at IS NULL",
        },
      ]);
      expect(db.prepare("SELECT data_revision, audit_revision FROM change_revisions").get()).toEqual(revisions);
      const plan = (sql: string) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
          .map((row) => row.detail)
          .join(" | ");
      expect(plan("SELECT COUNT(*) FROM sessions WHERE project_id = 'meadow' AND voided_at IS NULL")).toContain(
        "idx_sessions_live_project",
      );
      expect(plan("SELECT id FROM sessions WHERE commit_sha >= 'abc1234' AND commit_sha < 'abc1235'")).toContain(
        "idx_sessions_commit_sha",
      );
    } finally {
      db.close();
    }
  });
});

describe("knowledge page Session coverage migration", () => {
  it("upgrades schema 33 with two empty coverage columns, keeping every page and revision", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 33);
      db.exec(`INSERT INTO projects (id, name, root_path, status, created_at, updated_at)
        VALUES ('meadow', 'Meadow', '/fictional/meadow', 'tracked', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
        INSERT INTO knowledge_pages (id, project_id, slug, title, question, sections_json, version, sourced_through,
          created_at, updated_at)
        VALUES ('page-1', 'meadow', 'architecture', 'Architecture', 'How is it built?', '[]', 2,
          '2026-11-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');`);
      const revisions = db.prepare("SELECT data_revision, audit_revision FROM change_revisions").get();

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 34").get()).toEqual({ version: 34 });
      const columns = db.prepare("PRAGMA table_info(knowledge_pages)").all() as Array<Record<string, unknown>>;
      for (const name of ["covered_through_completed_at", "covered_through_session_id"]) {
        expect(columns.find((column) => column.name === name)).toMatchObject({
          type: "TEXT",
          notnull: 0,
          dflt_value: null,
        });
      }
      expect(
        db
          .prepare(
            "SELECT version, sourced_through, covered_through_completed_at, covered_through_session_id FROM knowledge_pages",
          )
          .get(),
      ).toEqual({
        version: 2,
        sourced_through: "2026-11-02T00:00:00.000Z",
        covered_through_completed_at: null,
        covered_through_session_id: null,
      });
      expect(db.prepare("SELECT data_revision, audit_revision FROM change_revisions").get()).toEqual(revisions);
    } finally {
      db.close();
    }
  });
});

describe("agent read audit response size migration", () => {
  it("adds a nullable response_chars column and leaves existing reads unknown, not 0", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 34);
      expect(
        (db.prepare("PRAGMA table_info(agent_read_audit)").all() as Array<{ name: string }>).map((c) => c.name),
      ).not.toContain("response_chars");
      db.exec(`INSERT INTO agent_read_audit (id, created_at, tool, outcome, duration_ms)
        VALUES ('old-read', '2026-11-01T00:00:00.000Z', 'work_recall', 'recall', 12)`);
      const revisions = db.prepare("SELECT data_revision FROM change_revisions").get();

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 35").get()).toEqual({ version: 35 });
      const columns = db.prepare("PRAGMA table_info(agent_read_audit)").all() as Array<Record<string, unknown>>;
      expect(columns.find((column) => column.name === "response_chars")).toMatchObject({
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
      });
      expect(
        db.prepare("SELECT duration_ms, response_chars FROM agent_read_audit WHERE id = 'old-read'").get(),
      ).toEqual({
        duration_ms: 12,
        response_chars: null,
      });
      expect(db.prepare("SELECT data_revision FROM change_revisions").get()).toEqual(revisions);
    } finally {
      db.close();
    }
  });
});

describe("agent review requests migration", () => {
  it("adds the request tables and attribution columns, and leaves earlier reviews without an attribution", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 35);
      const tables = (): string[] =>
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_review_%'")
            .all() as Array<{
            name: string;
          }>
        ).map((row) => row.name);
      expect(tables()).toEqual([]);
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec(`INSERT INTO session_decisions (id, session_id, project_id, position, text, origin, review_status, reviewed_at)
        VALUES ('old-decision', 's', 'p', 0, 'Reviewed before agent review', 'agent_autonomous', 'confirmed', '2026-11-01T00:00:00.000Z')`);
      db.exec("PRAGMA foreign_keys=ON");

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 36").get()).toEqual({
        name: "agent-review-requests",
      });
      expect(tables().sort()).toEqual([
        "agent_review_request_items",
        "agent_review_requests",
        "agent_review_submissions",
      ]);
      expect(db.prepare("SELECT reviewed_by, review_reason, review_request_id FROM session_decisions").get()).toEqual({
        reviewed_by: null,
        review_reason: null,
        review_request_id: null,
      });
      for (const table of ["session_decisions", "knowledge_candidates"]) {
        const names = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        expect(names).toEqual(expect.arrayContaining(["reviewed_by", "review_reason", "review_request_id"]));
      }
      expect(
        db
          .prepare("SELECT dflt_value FROM pragma_table_info('agent_review_requests') WHERE name = 'omitted_count'")
          .get(),
      ).toEqual({ dflt_value: "0" });
      const revisionTriggers = db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_data_revision_agent_review_%'",
        )
        .get();
      expect(revisionTriggers).toEqual({ count: 9 });
    } finally {
      db.close();
    }
  });

  it("allows one open request per project but any number of closed ones", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      db.exec("PRAGMA foreign_keys=OFF");
      const insert = db.prepare(
        `INSERT INTO agent_review_requests (id, project_id, idempotency_key, status, requested_at, item_count)
         VALUES (?, 'project-1', ?, ?, '2026-11-01T00:00:00.000Z', 1)`,
      );
      insert.run("closed-1", "key-1", "completed");
      insert.run("closed-2", "key-2", "cancelled");
      insert.run("open-1", "key-3", "failed");
      expect(() => insert.run("open-2", "key-4", "pending")).toThrow(/UNIQUE/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO agent_review_requests (id, project_id, idempotency_key, status, requested_at, item_count, omitted_count)
             VALUES ('negative', 'project-2', 'key-5', 'pending', '2026-11-01T00:00:00.000Z', 1, -1)`,
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});

describe("knowledge page deletion audit migration", () => {
  it("upgrades schema 36 with an empty content-free audit indexed by page id, keeping every page", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 36);
      const auditTable = () =>
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_page_deletion_audit'")
          .get();
      expect(auditTable()).toBeUndefined();
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec(`INSERT INTO knowledge_pages (id, project_id, slug, title, question, created_at, updated_at)
        VALUES ('page-1', 'project-1', 'release-process', 'Release', 'How do we release?', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
      db.exec("PRAGMA foreign_keys=ON");

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 37").get()).toEqual({
        name: "knowledge-page-deletion-audit",
      });
      expect(auditTable()).toEqual({ name: "knowledge_page_deletion_audit" });
      expect(
        (db.prepare("PRAGMA table_info(knowledge_page_deletion_audit)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      ).toEqual(["id", "deleted_at", "page_id", "project_id", "deleted_counts_json"]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_page_deletion_audit").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT id FROM knowledge_pages").all()).toEqual([{ id: "page-1" }]);
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT page_id FROM knowledge_page_deletion_audit WHERE page_id = ?")
        .all("page-1") as Array<{ detail: string }>;
      expect(plan.map((step) => step.detail).join(" ")).toContain("idx_knowledge_page_deletion_audit_page");
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(37);
    } finally {
      db.close();
    }
  });
});

describe("agent review knowledge items migration", () => {
  const requestedAt = "2026-11-01T00:00:00.000Z";

  it("rebuilds the snapshot table for knowledge items, keeping rows, order, indexes and triggers", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 37);
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec(`INSERT INTO agent_review_requests (id, project_id, idempotency_key, status, requested_at, item_count)
        VALUES ('request-1', 'project-1', 'key-1', 'completed', '${requestedAt}', 3)`);
      const insert = db.prepare(
        `INSERT INTO agent_review_request_items
           (id, request_id, project_id, item_kind, item_id, source_session_id, position, fingerprint, submission_id,
            verdict, outcome, reason, knowledge_id, decided_at, overturned_at)
         VALUES (?, 'request-1', 'project-1', ?, ?, ?, ?, 'fingerprint', NULL, ?, ?, ?, NULL, ?, ?)`,
      );
      insert.run(
        "item-c",
        "candidate",
        "candidate-1",
        "session-1",
        2,
        "accept",
        "applied",
        "Quotes the fix.",
        requestedAt,
        null,
      );
      insert.run(
        "item-a",
        "decision",
        "decision-1",
        "session-1",
        0,
        "promote",
        "applied",
        "Matches the diff.",
        requestedAt,
        requestedAt,
      );
      insert.run("item-b", "decision", "decision-2", "session-2", 1, null, null, null, null, null);
      const readItems = () =>
        db
          .prepare(
            "SELECT rowid AS position_in_file, id, item_kind, verdict, outcome, reason, overturned_at FROM agent_review_request_items ORDER BY rowid",
          )
          .all();
      const before = readItems();
      expect(() =>
        db
          .prepare(
            `INSERT INTO agent_review_request_items (id, request_id, project_id, item_kind, item_id, position, fingerprint)
             VALUES ('late', 'request-1', 'project-1', 'knowledge', 'knowledge-1', 3, 'fingerprint')`,
          )
          .run(),
      ).toThrow(/CHECK/);

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 38").get()).toEqual({
        name: "agent-review-knowledge-items",
      });
      expect(readItems()).toEqual(before);
      expect(before.map((row) => (row as { id: string }).id)).toEqual(["item-c", "item-a", "item-b"]);

      const add = db.prepare(
        `INSERT INTO agent_review_request_items
           (id, request_id, project_id, item_kind, item_id, position, fingerprint, verdict, outcome)
         VALUES (?, 'request-1', 'project-1', ?, ?, ?, 'fingerprint', ?, ?)`,
      );
      add.run("knowledge-confirm", "knowledge", "knowledge-1", 3, "confirm", "applied");
      add.run("knowledge-archive", "knowledge", "knowledge-2", 4, "archive", "applied");
      add.run("knowledge-supersede", "knowledge", "knowledge-3", 5, "supersede", "applied");
      add.run("decision-archive", "decision", "decision-3", 6, "archive", "applied");
      expect(() => add.run("report", "report", "report-1", 7, null, null)).toThrow(/CHECK/);
      expect(() => add.run("odd-verdict", "knowledge", "knowledge-4", 7, "delete", null)).toThrow(/CHECK/);
      expect(() => add.run("repeat", "knowledge", "knowledge-1", 7, null, null)).toThrow(/UNIQUE/);

      const indexes = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_review_request_items'")
          .all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining(["idx_agent_review_items_item", "idx_agent_review_items_source_session"]),
      );
      const revision = (): number =>
        (
          db.prepare("SELECT data_revision FROM change_revisions WHERE singleton = 1").get() as {
            data_revision: number;
          }
        ).data_revision;
      for (const operation of ["insert", "update", "delete"]) {
        expect(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
            .get(`trg_data_revision_agent_review_request_items_${operation}`),
        ).toBeDefined();
      }
      const start = revision();
      add.run("knowledge-extra", "knowledge", "knowledge-5", 8, null, null);
      db.prepare("UPDATE agent_review_request_items SET reason = 'Changed.' WHERE id = 'knowledge-extra'").run();
      db.prepare("DELETE FROM agent_review_request_items WHERE id = 'knowledge-extra'").run();
      expect(revision()).toBe(start + 3);
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(38);
    } finally {
      db.close();
    }
  });

  it("adds the nullable connection id to the read audit and keeps existing rows without one", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 38);
      db.prepare(
        `INSERT INTO agent_read_audit (id, created_at, tool, outcome, returned_count, session_ids_json, knowledge_ids_json,
           omitted_session_count, omitted_knowledge_count)
         VALUES ('audit-1', '2030-01-01T00:00:00.000Z', 'work_recall', 'recall', 0, '[]', '[]', 0, 0)`,
      ).run();

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 39").get()).toEqual({
        name: "agent-read-audit-connection-id",
      });
      expect(db.prepare("SELECT connection_id FROM agent_read_audit WHERE id = 'audit-1'").get()).toEqual({
        connection_id: null,
      });
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(39);
    } finally {
      db.close();
    }
  });

  it("adds the nullable completion pages column to Agent review requests and leaves completed rows without one", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 39);
      const columns = () =>
        (db.prepare("PRAGMA table_info(agent_review_requests)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        );
      expect(columns()).not.toContain("completion_pages_json");
      db.exec(`INSERT INTO projects (id, name, root_path, status, created_at, updated_at)
        VALUES ('project-1', 'Orchard', '/fictional/orchard', 'tracked', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`);
      db.exec(`INSERT INTO agent_review_requests
        (id, project_id, idempotency_key, status, requested_at, completed_at, item_count, omitted_count)
        VALUES ('request-1', 'project-1', 'key-1', 'completed', '2030-01-01T00:00:00.000Z', '2030-01-01T01:00:00.000Z', 1, 0)`);

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 40").get()).toEqual({
        name: "agent-review-completion-pages",
      });
      expect(columns()).toContain("completion_pages_json");
      expect(
        db.prepare("SELECT status, completion_pages_json FROM agent_review_requests WHERE id = 'request-1'").get(),
      ).toEqual({ status: "completed", completion_pages_json: null });
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(40);
    } finally {
      db.close();
    }
  });

  it("adds the nullable convention columns to Knowledge and leaves existing items unmarked", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      undoMigrationsAfter(db, 40);
      const columns = () =>
        (db.prepare("PRAGMA table_info(knowledge)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns()).not.toContain("convention_confirmed_at");
      db.exec(`INSERT INTO projects (id, name, root_path, status, created_at, updated_at)
        VALUES ('project-1', 'Orchard', '/fictional/orchard', 'tracked', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`);
      db.exec(`INSERT INTO knowledge
        (id, project_id, idempotency_key, kind, title, body, tags_json, references_json, status, created_at, updated_at)
        VALUES ('knowledge-1', 'project-1', 'key-1', 'pattern', 'Rule', 'Body.', '[]', '[]', 'active',
          '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`);

      applyRuntimeMigrations(db);

      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 41").get()).toEqual({
        name: "knowledge-conventions",
      });
      expect(columns()).toEqual(expect.arrayContaining(["convention_confirmed_at", "convention_withdrawal_json"]));
      expect(
        db
          .prepare("SELECT convention_confirmed_at, convention_withdrawal_json FROM knowledge WHERE id = 'knowledge-1'")
          .get(),
      ).toEqual({ convention_confirmed_at: null, convention_withdrawal_json: null });
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(41);
    } finally {
      db.close();
    }
  });
});
