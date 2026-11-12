import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_DATA_TABLES, type ProjectDataExport } from "../../packages/core/src/index.js";
import {
  projectDataColumnDefaults,
  projectDataExportSchema,
  projectDataExportTableColumns,
} from "../../packages/schema/src/index.js";
import { initializeWorkIntelligenceDatabase } from "../../packages/storage/src/database-initialization.js";
import { OLDEST_IMPORTABLE_EXPORT_SCHEMA_VERSION } from "../../packages/storage/src/project-data-transfer.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { undoMigrationsAfter } from "../helpers/schema-migration-fixture.js";

// Synthetic exports written by the schema-31 (v1.6.8) and schema-32 (v1.6.21) builds through their own store API.
const FIXTURES = [
  { schemaVersion: 31, file: "project-data-export-schema-31.json", root: "/tmp/wi-fixture-31" },
  { schemaVersion: 32, file: "project-data-export-schema-32.json", root: "/tmp/wi-fixture-32" },
] as const;

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function loadFixture(file: string): ProjectDataExport {
  return JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8")) as ProjectDataExport;
}

function columnsOf(db: DatabaseSync): Map<string, Set<string>> {
  const columns = new Map<string, Set<string>>();
  for (const table of PROJECT_DATA_TABLES) {
    const names = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
    if (names.length > 0) columns.set(table, new Set(names));
  }
  return columns;
}

function counts(tables: ProjectDataExport["tables"]): Record<string, number> {
  return Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length]));
}

function total(values: Record<string, number | undefined>): number {
  return Object.values(values).reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("portable import of older exports", () => {
  it("gives every column and table added after the import floor an import default", () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeWorkIntelligenceDatabase(db, ":memory:");
      const latest = columnsOf(db);
      undoMigrationsAfter(db, OLDEST_IMPORTABLE_EXPORT_SCHEMA_VERSION);
      const floor = columnsOf(db);
      const missing: string[] = [];
      for (const table of PROJECT_DATA_TABLES) {
        const exported = projectDataExportTableColumns[table] as readonly string[];
        // Every live column travels in the portable format, so a new column cannot be left out by accident.
        expect({ table, columns: [...(latest.get(table) ?? [])].sort() }).toEqual({
          table,
          columns: [...exported].sort(),
        });
        for (const column of exported) {
          if (!floor.get(table)?.has(column) && !Object.hasOwn(projectDataColumnDefaults[table] ?? {}, column)) {
            missing.push(`${table}.${column}`);
          }
        }
        if (!floor.has(table)) {
          // A table the floor schema lacked must parse as empty when an older export omits it.
          const bundle = loadFixture(FIXTURES[0].file) as unknown as { tables: Record<string, unknown> };
          delete bundle.tables[table];
          expect({ table, parsed: projectDataExportSchema.safeParse(bundle).success }).toEqual({ table, parsed: true });
        }
      }
      expect(missing).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(FIXTURES)(
    "imports the schema-$schemaVersion export with both strategies, without conflicts, and skips it the second time",
    ({ schemaVersion, file, root }) => {
      const bundle = loadFixture(file);
      expect(bundle).toMatchObject({ format: "work-intelligence-export", formatVersion: 1, schemaVersion });
      expect(projectDataExportSchema.safeParse(bundle).success).toBe(true);
      for (const strategy of ["merge", "newer-wins"] as const) {
        const directory = mkdtempSync(join(tmpdir(), "work-intelligence-import-floor-"));
        tempDirs.push(directory);
        const store = new WorkIntelligenceStore(join(directory, "target.sqlite"));
        stores.push(store);
        // Paths move under this machine's temp directory so the roots are native on every platform.
        const input = { bundle, remap: [{ from: root, to: join(directory, "projects") }], strategy };

        const preview = store.previewProjectDataImport(input);
        expect(total(preview.conflicts)).toBe(0);
        const result = store.importProjectData(input);
        expect(total(result.conflicts)).toBe(0);
        expect(total(result.additions)).toBe(total(counts(bundle.tables)));
        expect(counts(store.exportProjectData({ type: "all" }).tables)).toEqual(counts(bundle.tables));
        expect(store.listKnowledgeCandidates({ status: "rejected" })).toMatchObject({
          outcome: "knowledge_candidates",
        });

        const again = store.importProjectData(input);
        expect(total(again.additions)).toBe(0);
        expect(total(again.conflicts)).toBe(0);
        expect(counts(store.exportProjectData({ type: "all" }).tables)).toEqual(counts(bundle.tables));
      }
    },
  );

  it("refuses an export from a newer schema with an update message, and one older than the floor", () => {
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    const bundle = loadFixture(FIXTURES[1].file);
    expect(() =>
      store.previewProjectDataImport({ bundle: { ...bundle, schemaVersion: LATEST_SCHEMA_VERSION + 1 } }),
    ).toThrow(/較新的 schema 版本.*請先更新 Work Intelligence/);
    expect(() =>
      store.previewProjectDataImport({
        bundle: { ...bundle, schemaVersion: OLDEST_IMPORTABLE_EXPORT_SCHEMA_VERSION - 1 },
      }),
    ).toThrow(/schema 版本/);
  });
});
