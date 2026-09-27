import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PROJECT_DATA_TABLES } from "../../packages/core/src/index.js";
import { projectDataExportTableColumns } from "../../packages/schema/src/index.js";
import { initializeWorkIntelligenceDatabase } from "../../packages/storage/src/database-initialization.js";
import { REDACTED_TEXT_FIELDS } from "../../packages/storage/src/database-redaction.js";

/**
 * Tables that deliberately stay out of the portable project export. Everything else holds project data and
 * must be exported, imported, and removed by permanent project deletion. Adding a table here needs a reason.
 */
const NOT_PROJECT_DATA: Record<string, string> = {
  schema_migrations: "schema version bookkeeping",
  search_chunks: "search index and derived raw-content hashes, rebuilt from the source rows",
  search_paths: "search index, rebuilt from the source rows",
  search_dirty: "search index queue",
  search_fts: "full-text index, rebuilt from the source rows",
  project_data_import_audits: "content-free audit of imports on this machine",
  project_deletion_audit: "content-free audit that must outlive the deleted project",
  project_location_audit: "content-free location-change audit that must not retain either path",
  database_maintenance_runs: "per-database maintenance history",
};

/** Project data tables with no free text for db:redact to scan. Adding one here needs a reason. */
const NO_FREE_TEXT: Record<string, string> = {
  projects: "name, root path, and https repository URL (credentials rejected) are chosen by the user in the Web UI",
  session_links: "ids, relation, and source only",
  knowledge_feedback: "ids, kind, and time only",
};

function userTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .filter((name) => !name.startsWith("search_fts_"));
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name).sort();
}

describe("project data coverage", () => {
  const db = new DatabaseSync(":memory:");
  initializeWorkIntelligenceDatabase(db, ":memory:");

  it("classifies every table as exportable project data or an explicit exception", () => {
    const exported = new Set<string>(PROJECT_DATA_TABLES);
    const unclassified = userTables(db).filter((table) => !exported.has(table) && !(table in NOT_PROJECT_DATA));
    // A new table must join PROJECT_DATA_TABLES (plus export, import, and deletion handling) or NOT_PROJECT_DATA.
    expect(unclassified).toEqual([]);
    expect(PROJECT_DATA_TABLES.filter((table) => !userTables(db).includes(table))).toEqual([]);
  });

  it("lets db:redact scan the free text of every project data table", () => {
    const scanned = new Set(Object.keys(REDACTED_TEXT_FIELDS));
    // A new table with text must join REDACTED_TEXT_FIELDS in database-redaction.ts, or NO_FREE_TEXT with a reason.
    expect(PROJECT_DATA_TABLES.filter((table) => !scanned.has(table) && !(table in NO_FREE_TEXT))).toEqual([]);
    for (const [table, fields] of Object.entries(REDACTED_TEXT_FIELDS)) {
      const existing = new Set(columns(db, table));
      expect({ table, missing: fields.filter((field) => !existing.has(field)) }).toEqual({ table, missing: [] });
    }
  });

  it("exports exactly the columns each project data table has", () => {
    for (const table of PROJECT_DATA_TABLES) {
      // A new column must be added to projectDataExportTableColumns, or it silently drops out of exports.
      expect({ table, columns: [...projectDataExportTableColumns[table]].sort() }).toEqual({
        table,
        columns: columns(db, table),
      });
    }
  });

  it("keeps raw handoff hashes on the rebuildable search index", () => {
    expect(columns(db, "search_chunks")).toContain("content_hash");
    expect(NOT_PROJECT_DATA.search_chunks).toContain("derived raw-content hashes");
  });
});
