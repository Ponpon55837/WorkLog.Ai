import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDataExport } from "../../packages/core/src/index.js";
import { BackupExportStore } from "../../packages/storage/src/backup-export-store.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const roots: string[] = [];
const storageSource = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/storage/src");
const TOKEN = `ghp_${"B".repeat(36)}`;

function seededDatabase(): { root: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-export-"));
  roots.push(root);
  const databasePath = join(root, "work-intelligence.sqlite");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(databasePath);
  const project = store.addProject("Export fixture", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  for (let index = 0; index < 3; index += 1) {
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: `export-fixture-${index}`,
      title: `Synthetic Session ${index}`,
      summary: `Synthetic summary ${index} that mentions ${TOKEN} so masking is exercised.`,
      changedFiles: [`src/file-${index}.ts`],
      verification: { status: "passed" },
      workSummary: { outcomes: [`outcome ${index}`], scope: [], decisions: [], verification: [], nextSteps: [] },
      ...(index === 0
        ? {
            diagrams: [
              {
                title: "API",
                kind: "architecture" as const,
                formatVersion: 1 as const,
                source: JSON.stringify({ version: 1, nodes: [{ id: "api", label: `API ${TOKEN}` }] }),
              },
            ],
          }
        : {}),
    });
    if (result.outcome !== "finalized") throw new Error("Could not create the synthetic Session.");
  }
  store.close();
  return { root, databasePath };
}

/** Local relative imports of a source file, ignoring type-only and dynamic ones. */
function staticRuntimeImports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gm)) {
    specifiers.push(match[1]!);
  }
  for (const match of source.matchAll(/^import\s+"([^"]+)";/gm)) specifiers.push(match[1]!);
  return specifiers;
}

function runtimeGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of staticRuntimeImports(file)) {
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      else if (!specifier.startsWith("node:")) packages.add(specifier);
    }
  }
  return { files, packages };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("BackupExportStore", () => {
  it("exports the same bytes as the read-only WorkIntelligenceStore, for every scope", async () => {
    const { databasePath } = seededDatabase();
    const full = new WorkIntelligenceStore(databasePath, {
      mode: "read-only",
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
    });
    const lean = new BackupExportStore(databasePath, { expectedSchemaVersion: LATEST_SCHEMA_VERSION });
    try {
      const projectId = full.listProjects()[0]!.id;
      for (const scope of [{ type: "all" as const }, { type: "project" as const, projectId }]) {
        const expected: ProjectDataExport = full.exportProjectData(scope);
        const actual = await lean.exportProjectData(scope);
        expect(actual.tables.session_diagrams).toHaveLength(1);
        expect(JSON.stringify(actual)).not.toContain(TOKEN);
        // exportedAt is the export time; everything else must be identical.
        expect(JSON.stringify({ ...actual, exportedAt: "" })).toBe(JSON.stringify({ ...expected, exportedAt: "" }));
      }
    } finally {
      lean.close();
      full.close();
    }
  });

  it("refuses an unknown project the way the store does", async () => {
    const { databasePath } = seededDatabase();
    const lean = new BackupExportStore(databasePath, { expectedSchemaVersion: LATEST_SCHEMA_VERSION });
    try {
      await expect(lean.exportProjectData({ type: "project", projectId: "missing" })).rejects.toMatchObject({
        name: "ProjectDataTransferError",
        code: "project_not_found",
      });
    } finally {
      lean.close();
    }
  });

  it("creates checked backups and a whole-database export without writing the source", () => {
    const { root, databasePath } = seededDatabase();
    const lean = new BackupExportStore(databasePath, {
      backup: { directory: join(root, "backups") },
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
    });
    try {
      expect(lean.createBackup().outcome).toBe("database_backups");
      expect(lean.backupIfDue()?.created.kind).toBe("automatic");
      expect(lean.backupIfDue()).toBeNull();
      const target = join(root, "export.sqlite");
      expect(lean.exportTo(target).bytes).toBeGreaterThan(0);
      const exported = new DatabaseSync(target, { readOnly: true });
      try {
        expect(exported.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        exported.close();
      }
      expect(existsSync(join(root, "backups"))).toBe(true);
    } finally {
      lean.close();
    }
  });

  it("requires an existing file with the expected schema version", () => {
    const { databasePath } = seededDatabase();
    expect(() => new BackupExportStore(":memory:", { expectedSchemaVersion: LATEST_SCHEMA_VERSION })).toThrow();
    expect(() => new BackupExportStore(databasePath, { expectedSchemaVersion: 0 })).toThrow();
    expect(() => new BackupExportStore(databasePath, { expectedSchemaVersion: LATEST_SCHEMA_VERSION + 1 })).toThrow();
  });

  it("keeps the schema package and zod out of its static import graph", () => {
    const { files, packages } = runtimeGraph(join(storageSource, "backup-export.ts"));
    expect([...packages].filter((name) => name === "zod" || name.startsWith("@work-intelligence/schema"))).toEqual([]);
    // The one module that parses with the schema may only be reached through a dynamic import.
    expect([...files].map((file) => file.slice(storageSource.length + 1))).not.toContain("diagram-source-redaction.ts");
  });
});
