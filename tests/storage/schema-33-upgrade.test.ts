import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseInitializationError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { undoMigrationsAfter } from "../helpers/schema-migration-fixture.js";

// Fictional fixtures only.
type Fingerprint = Record<string, { rows: number; hash: string }>;

const tempDirs: string[] = [];

function paths() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-schema-33-"));
  tempDirs.push(root);
  const projectRoot = join(root, "meadow");
  return { root, projectRoot, databasePath: join(root, "wi.sqlite"), backupDirectory: join(root, "backups") };
}

function expectOutcome<T extends { outcome: string }, O extends T["outcome"]>(
  result: T,
  outcome: O,
): Extract<T, { outcome: O }> {
  if (result.outcome !== outcome) throw new Error(`Expected ${outcome}, got ${result.outcome}`);
  return result as Extract<T, { outcome: O }>;
}

/** Writes Sessions, evidence, links, Knowledge, a page with versions, candidates in each state, items and a report. */
function seed(store: WorkIntelligenceStore, projectRoot: string): void {
  const project = store.addProject("Meadow", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const sessions = [0, 1, 2, 3].map((index) => {
    const result = expectOutcome(
      store.finalizeSession({
        projectRoot,
        idempotencyKey: `seed-${index}`,
        title: `Valve lease step ${index}`,
        summary: `Tuned the sprinkler valve lease, part ${index}.`,
        workSummary: {
          outcomes: [`Lease ${index} holds.`],
          scope: ["src/valve.ts"],
          decisions: [`Keep the lease under ${index + 2} minutes because the coil overheats.`],
          verification: ["pnpm test passed."],
          nextSteps: [`Check valve ${index} after rain.`],
        },
        changedFiles: ["src/valve.ts", `src/zone-${index}.ts`],
        verification: { status: "passed" },
        git: { branch: "main", commitSha: `${index}`.repeat(7).padEnd(40, "a") },
        handoffContent: `# Handoff\nThe valve ${index} sticks when cold.`,
      }),
      "finalized",
    );
    return result.session.id;
  });
  expectOutcome(
    store.attachEvidence({ sessionId: sessions[0]!, kind: "test", reference: "ci://run/1" }),
    "evidence_attached",
  );
  store.linkSessions({ sessionId: sessions[0]!, relatedSessionId: sessions[2]!, relation: "related", linked: true });
  expectOutcome(
    store.recordKnowledge({
      projectRoot,
      idempotencyKey: "lease-rule",
      kind: "gotcha",
      title: "Valve lease must stay short",
      body: "The valve lease must stay under three minutes or the coil overheats.",
      sessionId: sessions[0]!,
    }),
    "knowledge_recorded",
  );
  store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
  for (const version of [1, 2]) {
    store.saveKnowledgePage({
      projectRoot,
      slug: "architecture",
      idempotencyKey: `page-${version}`,
      sections: [
        { heading: "Modules", content: `Valve driver, revision ${version}.`, sourceSessionIds: [sessions[0]!] },
      ],
    });
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
  }
  const request = expectOutcome(store.requestKnowledgeCandidates(projectRoot), "knowledge_candidate_request");
  store.getKnowledgeCandidateContext({ requestId: request.request.id });
  const submitted = expectOutcome(
    store.submitKnowledgeCandidates({
      requestId: request.request.id,
      candidates: ["Valve lease must stay short", "Drip line clogs in frost", "Hose reel jams"].map((title) => ({
        sourceSessionId: sessions[0]!,
        kind: "gotcha" as const,
        title,
        body: `${title}: the valve lease must stay under three minutes or the coil overheats.`,
        rationale: "The handoff describes it.",
      })),
    }),
    "knowledge_candidates_submitted",
  );
  store.decideKnowledgeCandidate({ candidateId: submitted.candidates[1]!.id, decision: "accept" });
  store.decideKnowledgeCandidate({ candidateId: submitted.candidates[2]!.id, decision: "reject" });
  const items = store.listOutstandingItems({ projectRoot, status: "pending" });
  if (items.outcome === "outstanding_items") store.updateOutstandingItemStatus(items.items[0]!.id, "completed");
  store.createReportSynthesisRequest({ period: "week", projectId: project.id, idempotencyKey: "week" });
}

/** Row count and content hash per table over the columns that existed before the upgrade. */
function fingerprint(
  databasePath: string,
  columnsByTable?: Map<string, string[]>,
): {
  tables: Fingerprint;
  columns: Map<string, string[]>;
} {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
    )
      .map((row) => row.name)
      .filter((name) => name !== "schema_migrations");
    const columns = new Map<string, string[]>();
    const tables: Fingerprint = {};
    for (const name of names) {
      const own = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      const selected = columnsByTable?.get(name) ?? own;
      columns.set(name, selected);
      const list = selected.map((column) => `"${column}"`).join(", ");
      const rows = db.prepare(`SELECT ${list} FROM "${name}" ORDER BY ${list}`).all() as Array<Record<string, unknown>>;
      const hash = createHash("sha256");
      for (const row of rows) hash.update(`${JSON.stringify(selected.map((column) => String(row[column])))}\n`);
      tables[name] = { rows: rows.length, hash: hash.digest("hex") };
    }
    return { tables, columns };
  } finally {
    db.close();
  }
}

function migrationRows(databasePath: string): unknown[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all();
  } finally {
    db.close();
  }
}

/** A file database written through the store, then rewound to schema 31 the way the other migration tests are. */
function schema31Database() {
  const location = paths();
  mkdirSync(location.projectRoot);
  const store = new WorkIntelligenceStore(location.databasePath, { backup: { directory: location.backupDirectory } });
  try {
    seed(store, location.projectRoot);
  } finally {
    store.close();
  }
  const db = new DatabaseSync(location.databasePath);
  try {
    undoMigrationsAfter(db, 31);
  } finally {
    db.close();
  }
  return location;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("schema 31 to 33 upgrade", () => {
  it("backs up first, keeps every row and value, and does nothing on the next open", () => {
    const location = schema31Database();
    const before = fingerprint(location.databasePath);
    expect(Math.max(...migrationRows(location.databasePath).map((row) => (row as { version: number }).version))).toBe(
      31,
    );

    const store = new WorkIntelligenceStore(location.databasePath, { backup: { directory: location.backupDirectory } });
    try {
      const backups = expectOutcome(store.listBackups(), "database_backups");
      expect(backups.backups).toHaveLength(1);
      expect(backups.backups[0]).toMatchObject({ kind: "migration" });
      expect(backups.backups[0]!.fileName).toContain("pre-migration-v32-");
    } finally {
      store.close();
    }
    // Opening only migrates: every table, the search index included, holds the same rows and values.
    expect(fingerprint(location.databasePath, before.columns).tables).toEqual(before.tables);

    const reader = new WorkIntelligenceStore(location.databasePath, {
      backup: { directory: location.backupDirectory },
    });
    try {
      const hits = reader.search("valve lease");
      expect(Array.isArray(hits) && hits.length).toBeGreaterThan(0);
      expect(reader.getDashboardSummary()).toMatchObject({ finalizedSessions: 4 });
      const candidates = expectOutcome(reader.listKnowledgeCandidates({}), "knowledge_candidates");
      expect(candidates.items).toHaveLength(1);
      // Candidates submitted before schema 33 have no stored advisory, so none is listed.
      expect(candidates.items[0]).not.toHaveProperty("overlaps");
      expect(reader.listSessionsForAgent({ projectRoot: location.projectRoot, commitSha: "1111111" })).toMatchObject({
        items: [{ title: "Valve lease step 1" }],
      });
    } finally {
      reader.close();
    }
    const after = fingerprint(location.databasePath, before.columns);
    const derived = [
      "search_chunks",
      "search_dirty",
      "search_fts",
      "search_fts_data",
      "search_fts_docsize",
      "search_fts_idx",
      "search_paths",
      "related_work_dirty",
    ];
    for (const [table, value] of Object.entries(before.tables)) {
      // Reads may refresh derived index state; every project-data table stays byte-for-byte the same.
      if (!derived.includes(table)) expect({ table, ...after.tables[table] }).toEqual({ table, ...value });
    }
    const upgraded = new DatabaseSync(location.databasePath, { readOnly: true });
    try {
      expect(
        upgraded.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates WHERE overlaps_json IS NOT NULL").get(),
      ).toEqual({ count: 0 });
      expect(
        upgraded
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?) ORDER BY name")
          .all("idx_sessions_commit_sha", "idx_sessions_live_project"),
      ).toHaveLength(2);
    } finally {
      upgraded.close();
    }

    const migrations = migrationRows(location.databasePath);
    expect(migrations.at(-1)).toMatchObject({ version: LATEST_SCHEMA_VERSION });
    const reopened = new WorkIntelligenceStore(location.databasePath, {
      backup: { directory: location.backupDirectory },
    });
    try {
      expect(expectOutcome(reopened.listBackups(), "database_backups").backups).toHaveLength(1);
    } finally {
      reopened.close();
    }
    expect(migrationRows(location.databasePath)).toEqual(migrations);
  });

  it("does not migrate when the pre-migration backup cannot be written", () => {
    const location = schema31Database();
    writeFileSync(location.backupDirectory + "-blocked", "not a directory");
    const before = fingerprint(location.databasePath);

    let error: unknown;
    try {
      new WorkIntelligenceStore(location.databasePath, {
        backup: { directory: join(location.backupDirectory + "-blocked", "inside") },
      }).close();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DatabaseInitializationError);
    expect((error as DatabaseInitializationError).code).toBe("DATABASE_MIGRATION_BACKUP_FAILED");
    expect(Math.max(...migrationRows(location.databasePath).map((row) => (row as { version: number }).version))).toBe(
      31,
    );
    expect(fingerprint(location.databasePath).tables).toEqual(before.tables);
  });
});
