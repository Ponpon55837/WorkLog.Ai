import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeProjectRoot } from "../../packages/project-policy/src/index.js";
import { listDatabaseBackups } from "../../packages/storage/src/backup.js";
import { initializeWorkIntelligenceDatabase } from "../../packages/storage/src/database-initialization.js";
import { ProjectRepository } from "../../packages/storage/src/project-repository.js";

// A root saved before canonicalization: mixed case on Windows, a trailing separator elsewhere.
const legacyRoot = process.platform === "win32" ? "C:\\Fictional\\Legacy-Project" : "/fictional/legacy-project/";
const canonicalRoot = canonicalizeProjectRoot(legacyRoot);

const roots: string[] = [];

function openDatabase(): { databasePath: string; db: DatabaseSync } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-project-root-"));
  roots.push(root);
  const databasePath = join(root, "work-intelligence.sqlite");
  const db = new DatabaseSync(databasePath);
  initializeWorkIntelligenceDatabase(db, databasePath);
  return { databasePath, db };
}

function insertProject(db: DatabaseSync, id: string, rootPath: string): void {
  db.prepare(
    "INSERT INTO projects (id, name, root_path, status, created_at, updated_at) VALUES (?, ?, ?, 'tracked', '2026-09-24', '2026-09-24')",
  ).run(id, id, rootPath);
}

function rootPaths(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare("SELECT id, root_path AS rootPath FROM projects ORDER BY id").all() as Array<{
    id: string;
    rootPath: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.id, row.rootPath]));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy project root canonicalization", () => {
  it("canonicalizes an old root on startup so a tracked project is found again, after a backup", () => {
    const { databasePath, db } = openDatabase();
    try {
      insertProject(db, "legacy", legacyRoot);
      expect(new ProjectRepository(db).getByRootPath(legacyRoot)).toBeUndefined();

      initializeWorkIntelligenceDatabase(db, databasePath);

      expect(rootPaths(db)).toEqual({ legacy: canonicalRoot });
      expect(new ProjectRepository(db).getByRootPath(legacyRoot)).toMatchObject({ id: "legacy", status: "tracked" });
      expect(listDatabaseBackups(databasePath)).toHaveLength(1);

      initializeWorkIntelligenceDatabase(db, databasePath);
      expect(listDatabaseBackups(databasePath)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("leaves a root from another platform for the location service instead of resolving it here", () => {
    const { databasePath, db } = openDatabase();
    const foreignRoot = process.platform === "win32" ? "/Users/fictional/mac-project" : "C:\\Fictional\\Win-Project";
    try {
      insertProject(db, "foreign", foreignRoot);

      initializeWorkIntelligenceDatabase(db, databasePath);

      expect(rootPaths(db)).toEqual({ foreign: foreignRoot });
      expect(listDatabaseBackups(databasePath)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("leaves an old root unchanged when another project already owns its canonical root", () => {
    const { databasePath, db } = openDatabase();
    try {
      insertProject(db, "canonical", canonicalRoot);
      insertProject(db, "legacy", legacyRoot);

      initializeWorkIntelligenceDatabase(db, databasePath);

      expect(rootPaths(db)).toEqual({ canonical: canonicalRoot, legacy: legacyRoot });
      expect(new ProjectRepository(db).getByRootPath(legacyRoot)).toMatchObject({ id: "canonical" });
      expect(listDatabaseBackups(databasePath)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
