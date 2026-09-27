import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { RedactionSummary, SensitiveDataKind } from "@work-intelligence/core";
import type { BackupRetentionOptions } from "./backup.js";
import { backupDatabaseBeforeMaintenance } from "./backup.js";
import { redactText } from "./secret-redaction.js";

export type DatabaseRedactionErrorCode =
  "DATABASE_MISSING" | "DATABASE_IN_USE" | "DATABASE_INVALID" | "DATABASE_BACKUP_FAILED" | "DATABASE_REDACTION_FAILED";

export class DatabaseRedactionError extends Error {
  public constructor(
    public readonly code: DatabaseRedactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DatabaseRedactionError";
  }
}

export interface DatabaseRedactionResult {
  mode: "dry_run" | "applied";
  backupFileName?: string;
  affectedSessions: number;
  redactions: RedactionSummary;
}

/** Free-text columns db:redact scans in every project data table (checked by project-data-coverage.test.ts). */
export const REDACTED_TEXT_FIELDS = {
  sessions: ["title", "summary", "work_summary_json", "verification_json", "void_reason"],
  work_events: ["summary", "details_json"],
  raw_snapshots: ["content"],
  evidence: ["kind", "reference", "summary", "void_reason"],
  void_audit: ["reason"],
  session_verification_updates: ["previous_json", "resulting_json"],
  session_summary_updates: ["summary", "previous_summary", "resulting_summary"],
  session_work_summary_updates: ["work_summary_json", "previous_work_summary_json", "resulting_work_summary_json"],
  knowledge: ["title", "body", "tags_json", "references_json", "applies_to_json", "review_json"],
  knowledge_audit: ["before_json", "after_json", "changed_fields_json"],
  knowledge_candidate_requests: ["failure_reason"],
  knowledge_candidates: ["title", "body", "tags_json", "references_json", "applies_to_json", "rationale"],
  report_synthesis_requests: ["failure_reason"],
  report_summaries: [
    "title",
    "executive_summary",
    "themes_json",
    "highlights_json",
    "verification_json",
    "comparison_json",
    "risks_json",
    "decisions_json",
    "next_steps_json",
    "generated_by_agent",
    "generated_by_model",
  ],
  metadata_backfill_requests: ["failure_reason"],
  session_decisions: ["text"],
  knowledge_pages: ["title", "question", "sections_json"],
  knowledge_page_versions: ["title", "question", "sections_json"],
  session_diagrams: ["title", "source", "void_reason"],
} as const;

type DataTable = keyof typeof REDACTED_TEXT_FIELDS;

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnsFor(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function acquireExclusiveLock(database: DatabaseSync): void {
  try {
    database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
  } catch (error) {
    throw new DatabaseRedactionError(
      "DATABASE_IN_USE",
      "資料庫目前無法取得獨佔鎖。請先停止 Work Intelligence server，並關閉會啟動 MCP 的 Agent 對話後重試。",
      { cause: error },
    );
  }
}

function emptySummary(): RedactionSummary {
  return { total: 0, byKind: {} };
}

function addSummary(target: RedactionSummary, source: RedactionSummary): void {
  target.total += source.total;
  for (const [kind, count] of Object.entries(source.byKind) as Array<[SensitiveDataKind, number]>) {
    target.byKind[kind] = (target.byKind[kind] ?? 0) + count;
  }
}

function applyToDatabase(database: DatabaseSync, apply: boolean): DatabaseRedactionResult {
  const redactions = emptySummary();
  const sessionCounts = new Map<string, number>();
  const dirty = new Set<string>();
  const dirtyKnowledge = new Set<string>();

  for (const table of Object.keys(REDACTED_TEXT_FIELDS) as DataTable[]) {
    if (!tableExists(database, table)) {
      continue;
    }
    const availableColumns = columnsFor(database, table);
    const textFields = REDACTED_TEXT_FIELDS[table].filter((field) => availableColumns.has(field));
    if (textFields.length === 0) {
      continue;
    }
    const selected = [
      "rowid AS __rowid__",
      ...(availableColumns.has("session_id") ? ["session_id"] : []),
      ...(availableColumns.has("id") ? ["id"] : []),
      ...(availableColumns.has("knowledge_id") ? ["knowledge_id"] : []),
      ...textFields,
    ].join(", ");
    const rows = database.prepare(`SELECT ${selected} FROM ${table}`).all() as Array<Record<string, unknown>>;
    const update = apply
      ? database.prepare(`UPDATE ${table} SET ${textFields.map((field) => `${field} = ?`).join(", ")} WHERE rowid = ?`)
      : undefined;

    for (const row of rows) {
      const values: Array<string | null> = [];
      let rowRedactions = 0;
      for (const field of textFields) {
        const value = typeof row[field] === "string" ? String(row[field]) : row[field];
        if (typeof value !== "string") {
          values.push(value == null ? (value as null) : String(value));
          continue;
        }
        const sanitized = redactText(value);
        values.push(sanitized.value);
        rowRedactions += sanitized.redactions.total;
        addSummary(redactions, sanitized.redactions);
      }
      if (rowRedactions === 0) {
        continue;
      }
      const sessionId = table === "sessions" ? String(row.id ?? "") : String(row.session_id ?? "");
      if (sessionId) {
        sessionCounts.set(sessionId, (sessionCounts.get(sessionId) ?? 0) + rowRedactions);
        dirty.add(sessionId);
      }
      const knowledgeId = table === "knowledge" ? String(row.id ?? "") : String(row.knowledge_id ?? "");
      if (knowledgeId) {
        dirtyKnowledge.add(knowledgeId);
      }
      if (update) {
        update.run(...values, Number(row.__rowid__));
      }
    }
  }

  if (apply) {
    const sessionColumns = tableExists(database, "sessions") ? columnsFor(database, "sessions") : new Set<string>();
    const updateCount = sessionColumns.has("redaction_count")
      ? database.prepare("UPDATE sessions SET redaction_count = redaction_count + ? WHERE id = ?")
      : undefined;
    for (const [sessionId, count] of sessionCounts) {
      updateCount?.run(count, sessionId);
    }

    if (tableExists(database, "search_chunks") && tableExists(database, "search_fts")) {
      const removeFts = database.prepare("DELETE FROM search_fts WHERE rowid = ?");
      const removeChunks = database.prepare("DELETE FROM search_chunks WHERE doc_type = ? AND doc_id = ?");
      const removePaths = tableExists(database, "search_paths")
        ? database.prepare("DELETE FROM search_paths WHERE doc_type = ? AND doc_id = ?")
        : undefined;
      for (const sessionId of dirty) {
        const chunks = database
          .prepare("SELECT id FROM search_chunks WHERE doc_type = 'session' AND doc_id = ?")
          .all(sessionId) as Array<{ id: number }>;
        for (const chunk of chunks) {
          removeFts.run(chunk.id);
        }
        removeChunks.run("session", sessionId);
        removePaths?.run("session", sessionId);
      }
      for (const knowledgeId of dirtyKnowledge) {
        const chunks = database
          .prepare("SELECT id FROM search_chunks WHERE doc_type = 'knowledge' AND doc_id = ?")
          .all(knowledgeId) as Array<{ id: number }>;
        for (const chunk of chunks) {
          removeFts.run(chunk.id);
        }
        removeChunks.run("knowledge", knowledgeId);
        removePaths?.run("knowledge", knowledgeId);
      }
    }
    if (tableExists(database, "search_dirty")) {
      const markDirty = database.prepare("INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) VALUES (?, ?)");
      for (const sessionId of dirty) {
        markDirty.run("session", sessionId);
      }
      for (const knowledgeId of dirtyKnowledge) {
        markDirty.run("knowledge", knowledgeId);
      }
    }
  }

  return {
    mode: apply ? "applied" : "dry_run",
    affectedSessions: sessionCounts.size,
    redactions,
  };
}

/** Dry-run scans read-only. Apply takes an exclusive lock, backs up, and rewrites text in one transaction. */
export function redactDatabase(options: {
  databasePath: string;
  apply?: boolean;
  backup?: BackupRetentionOptions;
}): DatabaseRedactionResult {
  const apply = options.apply ?? false;
  if (options.databasePath === ":memory:" || !existsSync(options.databasePath)) {
    throw new DatabaseRedactionError("DATABASE_MISSING", "找不到已建立的資料庫；敏感資料整理沒有執行。");
  }

  let database: DatabaseSync;
  try {
    database = apply
      ? new DatabaseSync(options.databasePath)
      : new DatabaseSync(options.databasePath, { readOnly: true });
  } catch (error) {
    throw new DatabaseRedactionError("DATABASE_INVALID", "無法開啟資料庫；敏感資料整理沒有執行。", { cause: error });
  }

  try {
    if (!tableExists(database, "sessions") || !tableExists(database, "projects")) {
      throw new DatabaseRedactionError("DATABASE_INVALID", "指定檔案不是 Work Intelligence 資料庫。");
    }
    if (!apply) {
      return applyToDatabase(database, false);
    }

    acquireExclusiveLock(database);
    let backupFileName: string;
    try {
      backupFileName = backupDatabaseBeforeMaintenance(database, options.databasePath, options.backup).created.fileName;
    } catch (error) {
      throw new DatabaseRedactionError("DATABASE_BACKUP_FAILED", "整理前備份失敗；資料庫沒有變更。", {
        cause: error,
      });
    }

    try {
      database.exec("BEGIN IMMEDIATE");
      const result = applyToDatabase(database, true);
      database.exec("COMMIT");
      return { ...result, backupFileName };
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original maintenance failure if SQLite already rolled back.
      }
      throw new DatabaseRedactionError("DATABASE_REDACTION_FAILED", "資料庫敏感資料整理失敗；變更已回復。", {
        cause: error,
      });
    }
  } finally {
    database.close();
  }
}
