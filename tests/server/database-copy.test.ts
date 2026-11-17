import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { copyDatabaseConsistently } from "../../apps/server/src/database-copy.js";

// A consistent copy of a real (synthetic) SQLite database through the storage backup path. Fictional data only.
const directories: string[] = [];

function tempDir(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "wi-copy-")));
  directories.push(directory);
  return directory;
}

/** A real store database with one project, left in WAL mode with its last writes still in the `-wal` file. */
function createSource(directory: string): string {
  const path = join(directory, "source.sqlite");
  const store = new WorkIntelligenceStore(path);
  store.close();
  return path;
}

function fingerprint(path: string): { bytes: string; mtimeMs: number } {
  return { bytes: readFileSync(path).toString("base64"), mtimeMs: statSync(path).mtimeMs };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("copyDatabaseConsistently", () => {
  it("copies a database, reports the copy's identity and leaves the source untouched", async () => {
    const directory = tempDir();
    const source = createSource(directory);
    const before = fingerprint(source);
    const target = join(directory, "local", "copy.sqlite");

    const result = await copyDatabaseConsistently(source, target);

    expect(result.status).toBe("ok");
    expect(result.identity?.realPath).toBe(target);
    expect(result.identity?.lineageId).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(target).size).toBeGreaterThan(0);
    const copy = new DatabaseSync(target, { readOnly: true });
    expect((copy.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check).toBe("ok");
    copy.close();
    expect(fingerprint(source)).toEqual(before);
  });

  it("includes a change that only lives in the -wal file of a database another connection keeps open", async () => {
    const directory = tempDir();
    const source = createSource(directory);
    const writer = new DatabaseSync(source);
    writer.exec(
      "PRAGMA wal_autocheckpoint = 0; CREATE TABLE copy_probe (value TEXT); INSERT INTO copy_probe VALUES ('wal-only')",
    );
    try {
      expect(statSync(`${source}-wal`).size).toBeGreaterThan(0);
      const target = join(directory, "copy.sqlite");

      expect((await copyDatabaseConsistently(source, target)).status).toBe("ok");

      const copy = new DatabaseSync(target, { readOnly: true });
      expect(copy.prepare("SELECT value FROM copy_probe").all()).toEqual([{ value: "wal-only" }]);
      copy.close();
    } finally {
      writer.close();
    }
  });

  it("copies a database that is older than this build without migrating either file", async () => {
    const directory = tempDir();
    const source = createSource(directory);
    const old = new DatabaseSync(source);
    old.exec("DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)");
    old.close();
    const before = fingerprint(source);
    const target = join(directory, "copy.sqlite");

    const result = await copyDatabaseConsistently(source, target);

    expect(result.status).toBe("ok");
    const copy = new DatabaseSync(target, { readOnly: true });
    const versions = (copy.prepare("SELECT COUNT(*) AS total FROM schema_migrations").get() as { total: number }).total;
    const original = new DatabaseSync(source, { readOnly: true });
    expect(versions).toBe(
      (original.prepare("SELECT COUNT(*) AS total FROM schema_migrations").get() as { total: number }).total,
    );
    copy.close();
    original.close();
    expect(fingerprint(source)).toEqual(before);
  });

  it("never overwrites: an existing target (even a dangling symlink) is target-exists and stays as it was", async () => {
    const directory = tempDir();
    const source = createSource(directory);
    const target = join(directory, "taken.sqlite");
    writeFileSync(target, "someone else's file");
    const link = join(directory, "dangling.sqlite");
    symlinkSync(join(directory, "nowhere"), link);

    expect((await copyDatabaseConsistently(source, target)).status).toBe("target-exists");
    expect((await copyDatabaseConsistently(source, link)).status).toBe("target-exists");
    expect(readFileSync(target, "utf8")).toBe("someone else's file");
  });

  it("answers failed for a source that is missing, and for one that is not a database", async () => {
    const directory = tempDir();
    const target = join(directory, "copy.sqlite");
    expect((await copyDatabaseConsistently(join(directory, "missing.sqlite"), target)).status).toBe("failed");
    const notDatabase = join(directory, "text.sqlite");
    writeFileSync(notDatabase, "not a database at all, just some text".repeat(40));
    expect((await copyDatabaseConsistently(notDatabase, target)).status).toBe("failed");
    expect(existsSync(target)).toBe(false);
  });

  it("answers integrity-failed and publishes nothing when the staged copy fails its check", async () => {
    const directory = tempDir();
    const source = createSource(directory);
    const target = join(directory, "copy.sqlite");

    const result = await copyDatabaseConsistently(source, target, {
      verifySnapshot: () => {
        throw new Error("The snapshot failed its integrity check: *** in database main ***");
      },
    });

    expect(result).toEqual({ status: "integrity-failed", detail: "the copy failed its integrity check" });
    expect(existsSync(target)).toBe(false);
  });

  it("answers no-space for a full disk, from an errno or from SQLite", async () => {
    const directory = tempDir();
    const source = createSource(directory);
    const full = (error: unknown) => ({
      verifySnapshot: () => {
        throw error;
      },
    });

    const errno = Object.assign(new Error("write failed"), { code: "ENOSPC" });
    expect((await copyDatabaseConsistently(source, join(directory, "a.sqlite"), full(errno))).status).toBe("no-space");
    const sqlite = Object.assign(new Error("database or disk is full"), { errcode: 13 });
    expect((await copyDatabaseConsistently(source, join(directory, "b.sqlite"), full(sqlite))).status).toBe("no-space");
    const message = new Error("database or disk is full");
    expect((await copyDatabaseConsistently(source, join(directory, "c.sqlite"), full(message))).status).toBe(
      "no-space",
    );
  });

  it("answers failed with a fixed detail for an unexpected error, never the error text", async () => {
    const directory = tempDir();
    const source = createSource(directory);
    const result = await copyDatabaseConsistently(source, join(directory, "d.sqlite"), {
      verifySnapshot: () => {
        throw new Error(`secret detail at ${directory}`);
      },
    });
    expect(result).toEqual({ status: "failed", detail: "the copy could not be made" });
  });

  it("answers failed when the target folder cannot be created", async () => {
    const directory = tempDir();
    const source = createSource(directory);
    const blocker = join(directory, "blocker");
    writeFileSync(blocker, "a file where a folder is needed");
    expect((await copyDatabaseConsistently(source, join(blocker, "inside", "copy.sqlite"))).status).toBe("failed");
    mkdirSync(join(directory, "ok"));
  });
});
