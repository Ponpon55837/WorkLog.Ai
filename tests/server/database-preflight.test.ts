import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "@work-intelligence/storage";
import {
  preflightDatabase,
  revalidateBeforeCommit,
  type DatabaseIdentity,
  type DatabasePreflightResult,
} from "../../apps/server/src/database-preflight.js";
import { startApi } from "../../apps/server/src/start-api.js";
import type { DbProbe, DbProbeResult } from "../../packages/desktop-core/src/db-source/types.js";

const directories: string[] = [];

function tempDir(): string {
  // Real path: macOS tmpdir() is under /var, a symlink to /private/var, and preflight reports resolved paths.
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "wi-preflight-")));
  directories.push(directory);
  return directory;
}

/** Hand-built database: only the tables the preflight reads, so schema versions can be chosen freely. */
function createDatabase(
  path: string,
  options: { versions?: number[]; appliedAt?: string; projects?: number; wal?: boolean } = {},
): DatabaseSync {
  const database = new DatabaseSync(path);
  if (options.wal) {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  }
  database.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const version of options.versions ?? [LATEST_SCHEMA_VERSION]) {
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, `m${version}`, options.appliedAt ?? "2026-01-01T00:00:00.000Z");
  }
  database.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY)");
  for (let index = 0; index < (options.projects ?? 0); index += 1) {
    database.prepare("INSERT INTO projects (id) VALUES (?)").run(index + 1);
  }
  return database;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireIdentity(result: DatabasePreflightResult): DatabaseIdentity {
  if (!result.identity) throw new Error("expected an identity");
  return result.identity;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const directory of directories.splice(0)) {
    try {
      chmodSync(directory, 0o755);
    } catch {
      // already removed
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DbProbe contract", () => {
  it("preflightDatabase is assignable to desktop-core's DbProbe, and its result to DbProbeResult", async () => {
    const probe: DbProbe = preflightDatabase;
    const result: DbProbeResult = await probe(join(tempDir(), "absent.sqlite"));
    expect(result.status).toBe("missing");
  });
});

describe("preflightDatabase statuses", () => {
  it("reports missing without creating the file", async () => {
    const path = join(tempDir(), "absent.sqlite");
    const result = await preflightDatabase(path);
    expect(result.status).toBe("missing");
    expect(result.identity).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("reports ok for a current schema with a project count, composite identity and sidecar evidence", async () => {
    const path = join(tempDir(), "ok.sqlite");
    createDatabase(path, { projects: 3 }).close();
    const result = await preflightDatabase(path);
    expect(result).toMatchObject({
      status: "ok",
      schemaVersion: LATEST_SCHEMA_VERSION,
      compatibility: "current",
      projectCount: 3,
    });
    const identity = requireIdentity(result);
    expect(identity.realPath).toBe(resolve(path));
    expect(identity.fileId).toEqual({ device: expect.any(String), inode: expect.any(String) });
    expect(identity.lineageId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sidecars?.before).toEqual({ wal: { exists: false, size: 0 }, shm: { exists: false, size: 0 } });
  });

  it("opens a database created by the real store as ok at the latest schema", async () => {
    const path = join(tempDir(), "real.sqlite");
    new WorkIntelligenceStore(path).close();
    const result = await preflightDatabase(path);
    expect(result).toMatchObject({ status: "ok", compatibility: "current", projectCount: 0 });
  });

  it("derives the lineage from the oldest migration row, so copies share it and other histories do not", async () => {
    const directory = tempDir();
    createDatabase(join(directory, "a.sqlite"), { versions: [1, 2, 3] }).close();
    writeFileSync(join(directory, "copy.sqlite"), readFileSync(join(directory, "a.sqlite")));
    createDatabase(join(directory, "other.sqlite"), {
      versions: [1, 2, 3],
      appliedAt: "2026-02-02T00:00:00.000Z",
    }).close();
    const [a, copy, other] = await Promise.all(
      ["a", "copy", "other"].map((name) => preflightDatabase(join(directory, `${name}.sqlite`))),
    );
    expect(requireIdentity(a!).lineageId).toBe(requireIdentity(copy!).lineageId);
    expect(requireIdentity(a!).fileId).not.toEqual(requireIdentity(copy!).fileId);
    expect(requireIdentity(a!).lineageId).not.toBe(requireIdentity(other!).lineageId);
  });

  it("reports an older schema as ok with older-needs-migration", async () => {
    const path = join(tempDir(), "old.sqlite");
    createDatabase(path, { versions: [1] }).close();
    const result = await preflightDatabase(path, { supportedSchemaVersion: 5 });
    expect(result).toMatchObject({ status: "ok", schemaVersion: 1, compatibility: "older-needs-migration" });
  });

  it("treats a legacy Work Intelligence database without schema_migrations as schema 0 needing migration", async () => {
    const path = join(tempDir(), "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY); CREATE TABLE sessions (id INTEGER PRIMARY KEY)");
    legacy.close();
    const result = await preflightDatabase(path);
    expect(result).toMatchObject({
      status: "ok",
      schemaVersion: 0,
      compatibility: "older-needs-migration",
      projectCount: 0,
    });
    expect(requireIdentity(result).lineageId).toBeNull();
  });

  it("reports an empty database file as ok with compatibility empty", async () => {
    const path = join(tempDir(), "empty.sqlite");
    new DatabaseSync(path).close();
    const result = await preflightDatabase(path);
    expect(result).toMatchObject({ status: "ok", schemaVersion: 0, compatibility: "empty" });
    expect(requireIdentity(result).lineageId).toBeNull();
  });

  it("rejects another application's database as unsupported-schema not-work-intelligence", async () => {
    const path = join(tempDir(), "foreign.sqlite");
    const foreign = new DatabaseSync(path);
    foreign.exec("CREATE TABLE unrelated (id INTEGER); CREATE TABLE projects (id INTEGER)");
    foreign.close();
    const result = await preflightDatabase(path);
    expect(result).toMatchObject({ status: "unsupported-schema", detail: "not-work-intelligence" });
    expect(result.compatibility).toBeUndefined();
  });

  it("reports unsupported-schema when the version is newer than supported", async () => {
    const path = join(tempDir(), "newer.sqlite");
    createDatabase(path, { versions: [1, LATEST_SCHEMA_VERSION + 1] }).close();
    const result = await preflightDatabase(path);
    expect(result).toMatchObject({
      status: "unsupported-schema",
      schemaVersion: LATEST_SCHEMA_VERSION + 1,
      compatibility: "newer-unsupported",
    });
    expect(result.detail).toContain("newer");
  });

  it("reports unreadable for a file that is not a database", async () => {
    const path = join(tempDir(), "garbage.sqlite");
    writeFileSync(path, Buffer.from("this is definitely not a sqlite database ".repeat(200)));
    const before = sha256(path);
    const result = await preflightDatabase(path);
    expect(result.status).toBe("unreadable");
    expect(requireIdentity(result).lineageId).toBeNull();
    expect(sha256(path)).toBe(before);
  });

  it("reports unreadable for a damaged schema_migrations version", async () => {
    const path = join(tempDir(), "damaged.sqlite");
    createDatabase(path, { versions: [1] }).close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE schema_migrations SET version = -4");
    raw.close();
    const result = await preflightDatabase(path);
    expect(result.status).toBe("unreadable");
  });

  it("reports unreadable (not missing) when the path is a directory", async () => {
    const result = await preflightDatabase(tempDir());
    expect(result.status).toBe("unreadable");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports denied for a file the user cannot read",
    async () => {
      const path = join(tempDir(), "locked.sqlite");
      createDatabase(path).close();
      chmodSync(path, 0o000);
      const result = await preflightDatabase(path);
      expect(result.status).toBe("denied");
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports denied when a parent directory blocks access",
    async () => {
      const directory = tempDir();
      const inner = join(directory, "inner");
      mkdirSync(inner);
      createDatabase(join(inner, "db.sqlite")).close();
      chmodSync(inner, 0o000);
      try {
        const result = await preflightDatabase(join(inner, "db.sqlite"));
        expect(result.status).toBe("denied");
      } finally {
        chmodSync(inner, 0o755); // afterEach only restores the temp root, so rmSync could not enter `inner`
      }
    },
  );
});

describe("revalidateBeforeCommit", () => {
  async function approved(path: string): Promise<DatabaseIdentity> {
    return requireIdentity(await preflightDatabase(path));
  }

  it("is ok for an unchanged file", async () => {
    const path = join(tempDir(), "db.sqlite");
    createDatabase(path).close();
    const identity = await approved(path);
    expect(revalidateBeforeCommit(path, identity)).toEqual({ ok: true, identity });
  });

  it("stays ok when business rows change but the history does not", async () => {
    const path = join(tempDir(), "db.sqlite");
    createDatabase(path).close();
    const identity = await approved(path);
    const writer = new DatabaseSync(path);
    writer.exec("INSERT INTO projects (id) VALUES (1)");
    writer.close();
    expect(revalidateBeforeCommit(path, identity).ok).toBe(true);
  });

  it("reports missing and never creates the file", async () => {
    const path = join(tempDir(), "db.sqlite");
    createDatabase(path).close();
    const identity = await approved(path);
    rmSync(path);
    expect(revalidateBeforeCommit(path, identity)).toMatchObject({ ok: false, reason: "missing" });
    expect(existsSync(path)).toBe(false);
  });

  it("reports file-replaced when a different database is swapped in at the same path", async () => {
    const directory = tempDir();
    const path = join(directory, "db.sqlite");
    createDatabase(path, { appliedAt: "2026-01-01T00:00:00.000Z" }).close();
    const identity = await approved(path);
    const replacement = join(directory, "replacement.sqlite");
    createDatabase(replacement, { appliedAt: "2026-03-03T00:00:00.000Z" }).close();
    renameSync(replacement, path);
    expect(revalidateBeforeCommit(path, identity)).toMatchObject({ ok: false, reason: "file-replaced" });
  });

  it("reports lineage-changed when the same file is rewritten with another history", async () => {
    const path = join(tempDir(), "db.sqlite");
    createDatabase(path).close();
    const identity = await approved(path);
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE schema_migrations SET applied_at = '2027-07-07T00:00:00.000Z'");
    raw.close();
    expect(revalidateBeforeCommit(path, identity)).toMatchObject({ ok: false, reason: "lineage-changed" });
  });

  it.skipIf(process.platform === "win32")(
    "reports path-replaced when a symlink is re-pointed at another database",
    async () => {
      const directory = tempDir();
      createDatabase(join(directory, "one.sqlite"), { appliedAt: "2026-01-01T00:00:00.000Z" }).close();
      createDatabase(join(directory, "two.sqlite"), { appliedAt: "2026-04-04T00:00:00.000Z" }).close();
      const link = join(directory, "link.sqlite");
      symlinkSync(join(directory, "one.sqlite"), link);
      const identity = await approved(link);
      expect(identity.realPath).toBe(join(directory, "one.sqlite"));
      rmSync(link);
      symlinkSync(join(directory, "two.sqlite"), link);
      expect(revalidateBeforeCommit(link, identity)).toMatchObject({ ok: false, reason: "path-replaced" });
    },
  );

  it("reports unreadable when the file turned into garbage", async () => {
    const path = join(tempDir(), "db.sqlite");
    createDatabase(path).close();
    const identity = await approved(path);
    writeFileSync(path, Buffer.from("garbage ".repeat(1000)));
    expect(revalidateBeforeCommit(path, identity)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("accepts a lineage that appears in the same file after the first migration, but not in a copy", async () => {
    const directory = tempDir();
    const path = join(directory, "fresh.sqlite");
    new DatabaseSync(path).close();
    const identity = await approved(path);
    expect(identity.lineageId).toBeNull();
    new WorkIntelligenceStore(path).close();
    const result = revalidateBeforeCommit(path, identity);
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity.lineageId).toMatch(/^[0-9a-f]{64}$/);

    const copyPath = join(directory, "other.sqlite");
    createDatabase(copyPath).close();
    renameSync(copyPath, path);
    expect(revalidateBeforeCommit(path, identity)).toMatchObject({ ok: false, reason: "file-replaced" });
  });

  it("reports lineage-changed when a null-lineage identity has no file id and the lineage appears", async () => {
    const path = join(tempDir(), "fresh.sqlite");
    new DatabaseSync(path).close();
    const identity = { ...(await approved(path)), fileId: null };
    new WorkIntelligenceStore(path).close();
    expect(revalidateBeforeCommit(path, identity)).toMatchObject({ ok: false, reason: "lineage-changed" });
  });

  it("reports lineage-changed when a known lineage disappears from the same file", async () => {
    const path = join(tempDir(), "db.sqlite");
    createDatabase(path).close();
    const identity = await approved(path);
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE schema_migrations");
    raw.close();
    expect(revalidateBeforeCommit(path, identity)).toMatchObject({ ok: false, reason: "lineage-changed" });
  });

  it("compares a null file id by lineage alone", async () => {
    const path = join(tempDir(), "db.sqlite");
    createDatabase(path).close();
    const identity = { ...(await approved(path)), fileId: null };
    expect(revalidateBeforeCommit(path, identity).ok).toBe(true);
  });
});

describe("sidecar side effects of the read-only probe", () => {
  it("leaves a live -wal/-shm untouched and sees rows that exist only in the WAL", async () => {
    const directory = tempDir();
    const path = join(directory, "live.sqlite");
    const writer = createDatabase(path, { wal: true, projects: 4 });
    try {
      const wal = `${path}-wal`;
      const shm = `${path}-shm`;
      expect(statSync(wal).size).toBeGreaterThan(0);
      const snapshot = {
        wal: { hash: sha256(wal), size: statSync(wal).size, ino: statSync(wal).ino },
        shm: { size: statSync(shm).size, ino: statSync(shm).ino },
        main: { hash: sha256(path), mtime: statSync(path).mtimeMs },
      };

      const result = await preflightDatabase(path);

      expect(result).toMatchObject({ status: "ok", projectCount: 4 });
      expect(sha256(wal)).toBe(snapshot.wal.hash);
      expect(statSync(wal)).toMatchObject({ size: snapshot.wal.size, ino: snapshot.wal.ino });
      expect(statSync(shm)).toMatchObject({ size: snapshot.shm.size, ino: snapshot.shm.ino });
      expect(sha256(path)).toBe(snapshot.main.hash);
      expect(statSync(path).mtimeMs).toBe(snapshot.main.mtime);
      expect(result.sidecars?.before.wal.exists).toBe(true);
      expect(result.sidecars?.after.wal).toEqual(result.sidecars?.before.wal);
    } finally {
      writer.close();
    }
  });

  // Observed on this Node 22 / bundled SQLite: a read-only open of a cleanly closed WAL database (no sidecars) CREATES
  // -shm and -wal beside it and leaves them behind after close (a read-only connection cannot checkpoint or delete
  // them), so "read-only" is not "0 writes". The contract asserted here is what matters to the user: main file bytes +
  // mtime and business rows unchanged, nothing that existed is removed, and only SQLite's own sidecars may appear.
  it("keeps main-file bytes and business data unchanged when probing a cleanly closed WAL database", async () => {
    const directory = tempDir();
    const path = join(directory, "closed.sqlite");
    createDatabase(path, { wal: true, projects: 2 }).close();
    expect(readdirSync(directory)).toEqual(["closed.sqlite"]);
    const main = { hash: sha256(path), mtime: statSync(path).mtimeMs };

    const result = await preflightDatabase(path);

    expect(result).toMatchObject({ status: "ok", projectCount: 2 });
    expect(sha256(path)).toBe(main.hash);
    expect(statSync(path).mtimeMs).toBe(main.mtime);
    const left = readdirSync(directory).filter((name) => name !== "closed.sqlite");
    for (const name of left) {
      expect(["closed.sqlite-wal", "closed.sqlite-shm"]).toContain(name);
    }
    expect(result.sidecars?.before).toEqual({ wal: { exists: false, size: 0 }, shm: { exists: false, size: 0 } });
    expect(result.sidecars?.after.wal.exists).toBe(left.includes("closed.sqlite-wal"));
    expect(result.sidecars?.after.shm.exists).toBe(left.includes("closed.sqlite-shm"));
    const reread = new DatabaseSync(path);
    expect(reread.prepare("SELECT COUNT(*) AS total FROM projects").get()).toEqual({ total: 2 });
    reread.close();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "returns ok or a clear denied/unreadable (never a crash) in a read-only directory",
    async () => {
      const directory = tempDir();
      const path = join(directory, "ro.sqlite");
      createDatabase(path, { projects: 1 }).close();
      chmodSync(directory, 0o555);
      const result = await preflightDatabase(path);
      expect(["ok", "denied", "unreadable"]).toContain(result.status);
      if (result.status === "ok") {
        expect(result.projectCount).toBe(1);
      }
    },
  );

  it("never opens a database as immutable", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../apps/server/src/database-preflight.ts"), "utf8");
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments).not.toMatch(/immutable/i);
    expect(withoutComments).not.toMatch(/file:/);
  });
});

describe("startApi with an injected database", () => {
  async function verified(path: string): Promise<{ path: string; identity: DatabaseIdentity }> {
    return { path, identity: requireIdentity(await preflightDatabase(path)) };
  }

  it("refuses to start, and creates nothing, when the verified database has disappeared", async () => {
    const path = join(tempDir(), "gone.sqlite");
    createDatabase(path).close();
    const database = await verified(path);
    rmSync(path);
    const messages = vi.spyOn(console, "error").mockImplementation(() => undefined);

    startApi({ database });

    expect(process.exitCode).toBe(1);
    expect(messages.mock.calls.flat().join("\n")).toContain("missing");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(resolve(path, ".."))).toEqual([]);
  });

  it("refuses to start when another database now sits at the path, leaving that file untouched", async () => {
    const directory = tempDir();
    const path = join(directory, "db.sqlite");
    createDatabase(path, { appliedAt: "2026-01-01T00:00:00.000Z" }).close();
    const database = await verified(path);
    const replacement = join(directory, "replacement.sqlite");
    createDatabase(replacement, { appliedAt: "2026-05-05T00:00:00.000Z" }).close();
    renameSync(replacement, path);
    const before = sha256(path);
    const messages = vi.spyOn(console, "error").mockImplementation(() => undefined);

    startApi({ database });

    expect(process.exitCode).toBe(1);
    expect(messages.mock.calls.flat().join("\n")).toContain("file-replaced");
    expect(sha256(path)).toBe(before);
    expect(readdirSync(directory)).toEqual(["db.sqlite"]);
  });
});
