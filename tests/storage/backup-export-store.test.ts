import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDataExport, ProjectDataTable } from "../../packages/core/src/index.js";
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

const GOLDEN_TOKEN = `ghp_${"C".repeat(36)}`;
const GOLDEN_PROJECT_COUNT = 520; // above the 500-id batch of rowsByIds
const GOLDEN_COLLATOR = new Intl.Collator();
// Tables whose rows the export reads in SQL order without the collator sort (in at least one scope).
const SQL_ORDER_TABLES = new Set<string>([
  "projects",
  "session_links",
  "report_synthesis_requests",
  "metadata_backfill_requests",
  "knowledge_candidates",
  "report_summaries",
]);

function goldenId(index: number): string {
  // Mixed case and punctuation, so the binary order of SQL differs from the collator order.
  const prefixes = ["b-", "A_", "a.", "B~", "Z", "z", "_", "-", "é", "漢"];
  return `${prefixes[index % prefixes.length]}${index.toString(36)}`;
}

/** Synthetic rows inserted by id in a scrambled order, so SQL id order and collator order disagree. */
function goldenDatabase(): string {
  const { databasePath } = seededDatabase();
  const db = new DatabaseSync(databasePath);
  const at = (minute: number) => `2026-01-02T03:${String(minute % 60).padStart(2, "0")}:00.000Z`;
  const insertProject = db.prepare(
    "INSERT INTO projects (id, name, root_path, status, created_at, updated_at, last_ingested_at, repository_url) VALUES (?, ?, ?, 'tracked', ?, ?, NULL, NULL)",
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, project_id, idempotency_key, title, summary, status, completed_at, created_at, commit_sha, redaction_count)
     VALUES (?, ?, ?, ?, ?, 'finalized', ?, ?, NULL, 0)`,
  );
  const insertEvent = db.prepare(
    "INSERT INTO work_events (id, session_id, type, summary, details_json, occurred_at) VALUES (?, ?, 'note', ?, ?, ?)",
  );
  const insertItem = db.prepare(
    "INSERT INTO outstanding_items (id, source_session_id, project_id, position, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
  );
  const insertItemEvent = db.prepare(
    "INSERT INTO outstanding_item_events (id, item_id, project_id, from_status, to_status, source, created_at) VALUES (?, ?, ?, NULL, 'pending', 'web', ?)",
  );
  const texts = [
    "漢字の要約 和文 한국어",
    "emoji 🚀👩‍💻 and a lone surrogate \ud800 end",
    "line\u2028separator and\u2029paragraph",
    "controls \u0000\u0007\u001b[31m\t\r\n",
    `secret ${GOLDEN_TOKEN} stays masked`,
  ];
  db.exec("BEGIN");
  for (let step = 0; step < GOLDEN_PROJECT_COUNT; step += 1) {
    const index = (step * 7919) % GOLDEN_PROJECT_COUNT; // scrambled insertion order
    const projectId = `p-${goldenId(index)}`;
    const sessionId = `s-${goldenId(index)}`;
    insertProject.run(projectId, `Golden ${index}`, `/synthetic/golden/${index}`, at(index), at(index));
    insertSession.run(
      sessionId,
      projectId,
      `golden-${index}`,
      texts[index % texts.length]!,
      "golden summary",
      at(index),
      at(index),
    );
    for (let eventIndex = 0; eventIndex < 3; eventIndex += 1) {
      insertEvent.run(
        `e-${goldenId(index)}-${eventIndex}`,
        sessionId,
        texts[(index + eventIndex) % texts.length]!,
        eventIndex === 0 ? null : JSON.stringify({ count: index, ratio: index / 8, text: texts[eventIndex]! }),
        at(index),
      );
    }
    if (index % 5 === 0) {
      const itemId = `i-${goldenId(index)}`;
      insertItem.run(
        itemId,
        sessionId,
        projectId,
        index % 10 === 0 ? 1.5 : index,
        texts[index % texts.length]!,
        at(index),
        at(index),
      );
      // Equal created_at, so the ids alone decide the order.
      for (const suffix of ["b", "B", "a", "A", "_", "-"]) {
        insertItemEvent.run(`ev-${suffix}-${goldenId(index)}`, itemId, projectId, at(0));
      }
    }
  }
  db.exec("COMMIT");
  db.close();
  return databasePath;
}

/** The pre-change export path: every table the export sorts is sorted again with the collator, unconditionally. */
function alwaysSorted(exported: ProjectDataExport): ProjectDataExport {
  const tables = { ...exported.tables } as Record<string, Record<string, unknown>[]>;
  for (const [table, rows] of Object.entries(tables)) {
    if (SQL_ORDER_TABLES.has(table)) continue;
    tables[table] = [...rows].sort((left, right) => {
      if ((table as ProjectDataTable) === "outstanding_item_events") {
        const byCreatedAt = GOLDEN_COLLATOR.compare(String(left.created_at), String(right.created_at));
        if (byCreatedAt !== 0) return byCreatedAt;
      }
      return GOLDEN_COLLATOR.compare(String(left.id), String(right.id));
    });
  }
  return { ...exported, tables: tables as unknown as ProjectDataExport["tables"] };
}

function sha256(exported: ProjectDataExport): string {
  return createHash("sha256").update(JSON.stringify(exported)).digest("hex");
}

afterEach(() => {
  vi.useRealTimers();
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

  it("keeps the bytes of the always-sort path when the sort is skipped or needed, for every scope", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-07T08:09:10.000Z"));
    const databasePath = goldenDatabase();
    const lean = new BackupExportStore(databasePath, { expectedSchemaVersion: LATEST_SCHEMA_VERSION });
    const full = new WorkIntelligenceStore(databasePath, {
      mode: "read-only",
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
    });
    try {
      const projectId = `p-${goldenId(5)}`;
      for (const scope of [{ type: "all" as const }, { type: "project" as const, projectId }]) {
        const actual = await lean.exportProjectData(scope);
        const reference = alwaysSorted(actual);
        expect(sha256(actual)).toBe(sha256(reference));
        expect(sha256(full.exportProjectData(scope))).toBe(sha256(actual));
        expect(actual.exportedAt).toBe("2026-06-07T08:09:10.000Z");
        expect(JSON.stringify(actual)).not.toContain(GOLDEN_TOKEN);
        expect(actual.tables.report_summaries).toHaveLength(0);
        if (scope.type === "all") {
          const sessionIds = actual.tables.sessions.map((row) => String(row.id));
          expect(sessionIds).toHaveLength(GOLDEN_PROJECT_COUNT + 3);
          // The batches of 500 projects each arrive in SQL order, so the merged list needed the sort.
          expect(sessionIds).not.toEqual([...sessionIds].sort());
          expect(actual.tables.sessions.some((row) => Number(row.redaction_count) > 0)).toBe(true);
          const events = actual.tables.outstanding_item_events.slice(0, 6).map((row) => String(row.id));
          expect(events).toEqual([...events].sort((left, right) => GOLDEN_COLLATOR.compare(left, right)));
        }
      }
    } finally {
      full.close();
      lean.close();
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

  it("reads with a small page cache so the worker leaves little resident after it exits", () => {
    const { databasePath } = seededDatabase();
    const lean = new BackupExportStore(databasePath, { expectedSchemaVersion: LATEST_SCHEMA_VERSION });
    try {
      const db = (lean as unknown as { db: DatabaseSync }).db;
      expect(db.prepare("PRAGMA cache_size").get()).toEqual({ cache_size: -1000 });
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
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
