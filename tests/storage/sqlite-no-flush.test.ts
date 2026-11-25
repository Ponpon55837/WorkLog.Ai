import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

// Guards tests/helpers/sqlite-no-flush.ts: the setup file must reach the connections the product code opens, or the
// suites silently go back to paying a disk flush per commit (the Windows CI stalls).
const SYNCHRONOUS_OFF = 0;
const directories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-no-flush-"));
  directories.push(directory);
  return join(directory, "test.sqlite");
}

function synchronousLevel(database: DatabaseSync): unknown {
  return (database.prepare("PRAGMA synchronous").get() as { synchronous: unknown }).synchronous;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("test databases are opened without disk flushes", () => {
  it("turns flushes off on the store's own connection, file-backed and in memory", () => {
    for (const path of [temporaryDatabase(), ":memory:"]) {
      const store = new WorkIntelligenceStore(path);
      try {
        expect(synchronousLevel((store as unknown as { db: DatabaseSync }).db)).toBe(SYNCHRONOUS_OFF);
      } finally {
        store.close();
      }
    }
  });

  it("turns flushes off on a connection a test opens itself, also when it is opened later", () => {
    const path = temporaryDatabase();
    const direct = new DatabaseSync(path);
    const deferred = new DatabaseSync(path, { open: false });
    try {
      expect(synchronousLevel(direct)).toBe(SYNCHRONOUS_OFF);
      deferred.open();
      expect(synchronousLevel(deferred)).toBe(SYNCHRONOUS_OFF);
    } finally {
      direct.close();
      deferred.close();
    }
  });

  it("leaves a read-only connection exactly as SQLite opens it", () => {
    const path = temporaryDatabase();
    new WorkIntelligenceStore(path).close();
    const readOnly = new DatabaseSync(path, { readOnly: true });
    try {
      expect(synchronousLevel(readOnly)).not.toBe(SYNCHRONOUS_OFF);
    } finally {
      readOnly.close();
    }
  });

  it("does not turn a database another connection has locked into an error at open time", () => {
    const path = temporaryDatabase();
    new WorkIntelligenceStore(path).close();
    const holder = new DatabaseSync(path);
    holder.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    try {
      // The pragma reads the schema and meets the exclusive lock; the open itself must still succeed.
      const blocked = new DatabaseSync(path);
      expect(() => blocked.exec("SELECT COUNT(*) FROM sqlite_master")).toThrow();
      blocked.close();
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});
