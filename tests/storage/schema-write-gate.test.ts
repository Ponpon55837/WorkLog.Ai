import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { isDatabaseSchemaChangedError } from "../../packages/storage/src/schema-write-gate.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. A raw connection on the same file stands in for a newer process that migrated the database.
const stores: WorkIntelligenceStore[] = [];
const connections: DatabaseSync[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(): { store: WorkIntelligenceStore; other: DatabaseSync; root: (name: string) => string } {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-schema-gate-"));
  tempDirs.push(directory);
  const databasePath = join(directory, "shared.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const other = new DatabaseSync(databasePath);
  connections.push(other);
  return { store, other, root: (name) => join(directory, name) };
}

/** What a newer release does: a DDL change plus its migration record, in one transaction. */
function migrateFromAnotherProcess(other: DatabaseSync): void {
  other.exec("BEGIN IMMEDIATE");
  other.exec("CREATE TABLE future_feature (id TEXT PRIMARY KEY)");
  other
    .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
    .run(LATEST_SCHEMA_VERSION + 1, "future_feature", "2030-01-01T00:00:00.000Z");
  other.exec("COMMIT");
}

/** Counts the schema_migrations lookups the gate runs on the store's own connection. */
function countVersionLookups(store: WorkIntelligenceStore): () => number {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const prepare = db.prepare.bind(db);
  let count = 0;
  db.prepare = ((sql: string) => {
    if (sql.includes("MAX(version)")) count += 1;
    return prepare(sql);
  }) as typeof db.prepare;
  return () => count;
}

describe("schema write gate", () => {
  it("lets writes through while the database is at this build's schema version", () => {
    const { store, root } = setup();

    expect(store.addProject("Apiary", root("apiary")).name).toBe("Apiary");
  });

  it("rejects every kind of write after another process migrated the database, and writes nothing", () => {
    const { store, other, root } = setup();
    const project = store.addProject("Apiary", root("apiary"));
    migrateFromAnotherProcess(other);

    const failure = (operation: () => unknown): unknown => {
      try {
        operation();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(isDatabaseSchemaChangedError(failure(() => store.addProject("Burrow", root("burrow"))))).toBe(true);
    expect(isDatabaseSchemaChangedError(failure(() => store.updateProject(project.id, { name: "Renamed" })))).toBe(
      true,
    );
    expect(store.listProjects().map((entry) => entry.name)).toEqual(["Apiary"]);
  });

  it("keeps reads working for the old process", () => {
    const { store, other, root } = setup();
    store.addProject("Apiary", root("apiary"));
    migrateFromAnotherProcess(other);

    expect(store.listProjects()).toHaveLength(1);
  });

  it("reports MCP_RESTART_REQUIRED from withCompatibleSchema", () => {
    const { store, other } = setup();
    migrateFromAnotherProcess(other);

    expect(() => store.withCompatibleSchema(LATEST_SCHEMA_VERSION, () => "wrote")).toThrow(
      expect.objectContaining({ code: "MCP_RESTART_REQUIRED" }),
    );
  });

  it("rejects a caller built for a different schema version even when nothing changed", () => {
    const { store } = setup();

    expect(() => store.withCompatibleSchema(LATEST_SCHEMA_VERSION - 1, () => "wrote")).toThrow(
      expect.objectContaining({ code: "MCP_RESTART_REQUIRED" }),
    );
    expect(store.withCompatibleSchema(LATEST_SCHEMA_VERSION, () => "wrote")).toBe("wrote");
  });

  it("does not look up the migration table again while no other connection committed", () => {
    const { store, root } = setup();
    const lookups = countVersionLookups(store);

    store.addProject("Apiary", root("apiary"));
    store.addProject("Burrow", root("burrow"));
    store.withCompatibleSchema(LATEST_SCHEMA_VERSION, () => store.addProject("Cellar", root("cellar")));

    expect(lookups()).toBe(1);
  });

  it("looks the version up once more after another connection commits, then caches again", () => {
    const { store, other, root } = setup();
    const lookups = countVersionLookups(store);
    store.addProject("Apiary", root("apiary"));
    other.exec("CREATE TABLE unrelated_note (id TEXT)");

    store.addProject("Burrow", root("burrow"));
    store.addProject("Cellar", root("cellar"));

    expect(lookups()).toBe(2);
  });
});
