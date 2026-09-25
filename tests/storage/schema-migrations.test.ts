import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applySchemaMigrations } from "../../packages/storage/src/schema-migrations.js";

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
          changed_files_json TEXT NOT NULL DEFAULT '[]'
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
});
