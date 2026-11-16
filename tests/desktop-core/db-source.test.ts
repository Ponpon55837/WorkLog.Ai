import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileIdentity } from "../../packages/shared/src/file-identity.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectDbCandidates,
  resolveDbSource,
  type DbCandidate,
  type DbProbe,
  type DbProbeResult,
  type DbSourceKind,
  type EnvironmentSource,
} from "../../packages/desktop-core/src/db-source/index.js";

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-db-source-"));
  directories.push(directory);
  return directory;
}

/** Creates a tiny SQLite file; `name` varies the schema_migrations row and so the lineage. */
function createDb(path: string, name: string | null = "initial"): string {
  const db = new DatabaseSync(path);
  if (name !== null) {
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    db.prepare("INSERT INTO schema_migrations VALUES (1, ?, '2026-01-01T00:00:00Z')").run(name);
    db.prepare("INSERT INTO schema_migrations VALUES (2, 'later', '2026-02-01T00:00:00Z')").run();
  }
  db.close();
  return path;
}

function lineageOf(path: string): string | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version LIMIT 1").get() as
      { version: number; name: string; applied_at: string } | undefined;
    return row ? createHash("sha256").update(`${row.version}|${row.name}|${row.applied_at}`).digest("hex") : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** A faithful fake: real identity reads, real lineage, with per-path overrides for states hard to produce. */
function fakeProbe(overrides: Record<string, DbProbeResult> = {}, calls: string[] = []): DbProbe {
  return async (path) => {
    calls.push(path);
    if (overrides[path]) return overrides[path];
    const read = readFileIdentity(path);
    if (!read.ok) return { status: read.kind, detail: read.code };
    return {
      status: "ok",
      identity: { ...read.identity, lineageId: lineageOf(read.identity.realPath) },
      schemaVersion: 2,
      projectCount: 3,
    };
  };
}

function candidate(kind: DbSourceKind, absolutePath: string): DbCandidate {
  return { kind, rawValue: absolutePath, resolutionBase: "/", absolutePath, managedByCurrentUser: true };
}

function snapshot(directory: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stat = statSync(full);
      entries.push(`${full}:${stat.isDirectory() ? "d" : stat.size}:${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(directory);
  return entries;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("collectDbCandidates", () => {
  it("collects every source kind with shared path rules and records evidence", () => {
    const root = tempDir();
    const configDir = join(root, "cfg");
    const service: EnvironmentSource = {
      label: "svc",
      environment: { WORK_INTELLIGENCE_DB: "rel/svc.sqlite" },
      resolutionBase: join(root, "svc"),
      managedByCurrentUser: false,
    };
    const candidates = collectDbCandidates({
      platform: process.platform,
      environment: { WORK_INTELLIGENCE_CONFIG_DIR: configDir },
      checkoutRoot: join(root, "repo"),
      desktopCommitted: join(root, "committed.sqlite"),
      explicitSelection: join(root, "picked.sqlite"),
      serviceDefinitions: [service, { label: "none", environment: {}, resolutionBase: root }],
      agentMcpConfigs: [{ label: "mcp", environment: { WORK_INTELLIGENCE_DB: "mcp.sqlite" }, resolutionBase: root }],
      readTextFile: () => JSON.stringify({ repositoryRoot: join(root, "linked") }),
    });
    expect(candidates.map((entry) => entry.kind)).toEqual([
      "desktop-committed",
      "explicit-selection",
      "legacy-service",
      "plugin-link",
      "agent-mcp",
      "standalone-default",
      "checkout-default",
    ]);
    const byKind = new Map(candidates.map((entry) => [entry.kind, entry]));
    expect(byKind.get("legacy-service")).toMatchObject({
      rawValue: "rel/svc.sqlite",
      resolutionBase: join(root, "svc"),
      absolutePath: join(root, "svc", "rel", "svc.sqlite"),
      managedByCurrentUser: false,
    });
    expect(byKind.get("agent-mcp")).toMatchObject({ managedByCurrentUser: "unknown" });
    expect(byKind.get("plugin-link")?.absolutePath).toBe(join(root, "linked", "data", "work-intelligence.sqlite"));
    expect(byKind.get("standalone-default")?.absolutePath).toBe(join(configDir, "data", "work-intelligence.sqlite"));
    expect(byKind.get("checkout-default")?.absolutePath).toBe(join(root, "repo", "data", "work-intelligence.sqlite"));
  });

  it("omits optional sources and tolerates a broken plugin link", () => {
    const configDir = tempDir();
    const candidates = collectDbCandidates({
      platform: "linux",
      environment: { WORK_INTELLIGENCE_CONFIG_DIR: configDir },
      readTextFile: () => "not json",
    });
    expect(candidates.map((entry) => entry.kind)).toEqual(["standalone-default"]);
    for (const content of ["null", JSON.stringify({ repositoryRoot: 5 }), JSON.stringify({ repositoryRoot: " " })]) {
      expect(
        collectDbCandidates({
          platform: "linux",
          environment: { WORK_INTELLIGENCE_CONFIG_DIR: configDir },
          readTextFile: () => content,
        }).map((entry) => entry.kind),
      ).toEqual(["standalone-default"]);
    }
  });

  it("reads plugin-link.json from the config directory by default", () => {
    const configDir = tempDir();
    writeFileSync(join(configDir, "plugin-link.json"), JSON.stringify({ repositoryRoot: "/somewhere/repo" }));
    const candidates = collectDbCandidates({
      platform: "linux",
      environment: { WORK_INTELLIGENCE_CONFIG_DIR: configDir },
    });
    expect(candidates.find((entry) => entry.kind === "plugin-link")?.absolutePath).toBe(
      "/somewhere/repo/data/work-intelligence.sqlite",
    );
  });

  it("marks values that cannot be paths as invalid instead of throwing", () => {
    const candidates = collectDbCandidates({
      platform: "win32",
      environment: { WORK_INTELLIGENCE_CONFIG_DIR: "C:\\cfg" },
      desktopCommitted: "C:data.sqlite",
      explicitSelection: ":memory:",
      readTextFile: () => "{}",
    });
    expect(candidates[0]).toMatchObject({
      kind: "desktop-committed",
      invalidReason: expect.stringContaining("磁碟相對路徑"),
    });
    expect(candidates[1]).toMatchObject({ kind: "explicit-selection", invalidReason: "in-memory database" });
  });

  it("uses the process environment and home when none are injected", () => {
    const candidates = collectDbCandidates({ readTextFile: () => "{}", home: "/h", environment: {} });
    expect(candidates[0]?.kind).toBe("standalone-default");
  });
});

describe("resolveDbSource", () => {
  it("caps in-flight probes at the concurrency option and rejects a non-positive cap", async () => {
    const root = tempDir();
    let inFlight = 0;
    let peak = 0;
    const probe = async (): Promise<{ status: "missing" }> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { status: "missing" };
    };
    const candidates = ["a", "b", "c", "d", "e"].map((name) =>
      candidate("explicit-selection", join(root, `${name}.sqlite`)),
    );
    const capped = await resolveDbSource({ candidates, probe, concurrency: 2 });
    expect(capped.candidates).toHaveLength(5);
    expect(peak).toBe(2);
    peak = 0;
    await resolveDbSource({ candidates, probe });
    expect(peak).toBe(5);
    await expect(resolveDbSource({ candidates, probe, concurrency: 0 })).rejects.toThrow(RangeError);
  });

  it("uses a legacy checkout database when it is the only one", async () => {
    const root = tempDir();
    mkdirSync(join(root, "repo", "data"), { recursive: true });
    const db = createDb(join(root, "repo", "data", "work-intelligence.sqlite"));
    const result = await resolveDbSource({
      candidates: [
        candidate("standalone-default", join(root, "cfg", "work-intelligence.sqlite")),
        candidate("checkout-default", db),
      ],
      probe: fakeProbe(),
    });
    expect(result.decision).toMatchObject({ kind: "use", reason: "default" });
    expect(result.decision.kind === "use" && result.decision.group.preview).toEqual({
      schemaVersion: 2,
      projectCount: 3,
    });
  });

  it("uses a standalone-only database", async () => {
    const root = tempDir();
    const db = createDb(join(root, "s.sqlite"));
    const result = await resolveDbSource({ candidates: [candidate("standalone-default", db)], probe: fakeProbe() });
    expect(result.decision).toMatchObject({ kind: "use", reason: "default" });
  });

  it("uses a plugin-linked database as consistent legacy", async () => {
    const root = tempDir();
    const db = createDb(join(root, "p.sqlite"));
    const result = await resolveDbSource({
      candidates: [candidate("plugin-link", db), candidate("standalone-default", join(root, "absent.sqlite"))],
      probe: fakeProbe(),
    });
    expect(result.decision).toMatchObject({ kind: "use", reason: "consistent-legacy" });
  });

  it("dedupes three sources that agree through symlinks and keeps all kinds as evidence", async () => {
    const root = tempDir();
    const db = createDb(join(root, "real.sqlite"));
    symlinkSync(db, join(root, "link1.sqlite"));
    symlinkSync(db, join(root, "link2.sqlite"));
    const calls: string[] = [];
    const result = await resolveDbSource({
      candidates: [
        candidate("plugin-link", db),
        candidate("standalone-default", join(root, "link1.sqlite")),
        candidate("checkout-default", join(root, "link2.sqlite")),
        candidate("agent-mcp", db),
      ],
      probe: fakeProbe({}, calls),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.kinds).toEqual(["plugin-link", "standalone-default", "checkout-default", "agent-mcp"]);
    expect(result.decision).toMatchObject({ kind: "use", reason: "consistent-legacy" });
    expect(calls.filter((path) => path === db)).toHaveLength(1);
  });

  it("asks the user when two distinct databases are configured", async () => {
    const root = tempDir();
    const a = createDb(join(root, "a.sqlite"), "one");
    const b = createDb(join(root, "b.sqlite"), "two");
    const result = await resolveDbSource({
      candidates: [candidate("plugin-link", a), candidate("legacy-service", b)],
      probe: fakeProbe(),
    });
    expect(result.decision).toMatchObject({ kind: "needs-user-choice", reason: "multiple-distinct" });
    expect(result.groups.map((group) => group.status)).toEqual(["ok", "ok"]);
  });

  it("marks copies of one lineage as conflict", async () => {
    const root = tempDir();
    const a = createDb(join(root, "a.sqlite"));
    copyFileSync(a, join(root, "copy.sqlite"));
    const result = await resolveDbSource({
      candidates: [candidate("plugin-link", a), candidate("agent-mcp", join(root, "copy.sqlite"))],
      probe: fakeProbe(),
    });
    expect(result.groups.map((group) => group.status)).toEqual(["conflict", "conflict"]);
    expect(result.decision).toMatchObject({ kind: "needs-user-choice", reason: "conflict" });
  });

  it("flags a single readable group that conflicts with a missing-free copy among defaults", async () => {
    const root = tempDir();
    const a = createDb(join(root, "a.sqlite"));
    copyFileSync(a, join(root, "copy.sqlite"));
    const only = await resolveDbSource({
      candidates: [candidate("standalone-default", a), candidate("checkout-default", join(root, "copy.sqlite"))],
      probe: fakeProbe({ [join(root, "copy.sqlite")]: { status: "denied" } }),
    });
    expect(only.decision).toMatchObject({ kind: "needs-user-choice", reason: "unverifiable" });
  });

  it("reports conflict when the only ok legacy group has a conflicting copy elsewhere", async () => {
    const root = tempDir();
    const a = createDb(join(root, "a.sqlite"));
    copyFileSync(a, join(root, "copy.sqlite"));
    // The copy is committed (authoritative) and fine; the legacy original is flagged conflict but not chosen.
    const committed = await resolveDbSource({
      candidates: [candidate("desktop-committed", join(root, "copy.sqlite")), candidate("plugin-link", a)],
      probe: fakeProbe(),
    });
    expect(committed.decision).toMatchObject({ kind: "use", reason: "desktop-committed" });
  });

  it("does not merge two different files that merely share a name stem", async () => {
    const root = tempDir();
    const a = createDb(join(root, "x.sqlite"), "one");
    const b = createDb(join(root, "y.sqlite"), "two");
    const result = await resolveDbSource({
      candidates: [candidate("standalone-default", a), candidate("checkout-default", b)],
      probe: fakeProbe(),
    });
    expect(result.decision).toMatchObject({ kind: "needs-user-choice", reason: "multiple-distinct" });
  });

  it("merges same-realPath candidates only when no fileId is available", async () => {
    const path = "/vol/db.sqlite";
    const identity = { realPath: path, fileId: null, lineageId: null };
    const result = await resolveDbSource({
      candidates: [candidate("plugin-link", path), candidate("agent-mcp", "/vol/../vol/db.sqlite")],
      probe: async () => ({ status: "ok", identity }),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.decision).toMatchObject({ kind: "use" });
  });

  it("keeps different fileIds at one path apart", async () => {
    let call = 0;
    const result = await resolveDbSource({
      candidates: [candidate("plugin-link", "/p/a.sqlite"), candidate("agent-mcp", "/p/b.sqlite")],
      probe: async () => ({
        status: "ok",
        identity: { realPath: "/p/same", fileId: { device: "1", inode: String(++call) }, lineageId: null },
      }),
    });
    expect(result.groups).toHaveLength(2);
  });

  it("blocks when the committed source is offline instead of falling back to a default", async () => {
    const root = tempDir();
    const fallback = createDb(join(root, "default.sqlite"));
    const committed = join(root, "drive-gone", "db.sqlite");
    const result = await resolveDbSource({
      candidates: [candidate("desktop-committed", committed), candidate("standalone-default", fallback)],
      probe: fakeProbe({ [committed]: { status: "offline" } }),
    });
    expect(result.decision).toMatchObject({ kind: "blocked", status: "offline", source: "desktop-committed" });
  });

  it.each(["missing", "denied", "unreadable", "unsupported-schema"] as const)(
    "blocks on an unavailable explicit selection (%s) rather than using legacy",
    async (status) => {
      const root = tempDir();
      const legacy = createDb(join(root, "legacy.sqlite"));
      const picked = join(root, "picked.sqlite");
      const result = await resolveDbSource({
        candidates: [candidate("explicit-selection", picked), candidate("plugin-link", legacy)],
        probe: fakeProbe({ [picked]: { status } }),
      });
      expect(result.decision).toMatchObject({ kind: "blocked", reason: "selected-source-unavailable", status });
    },
  );

  it("prefers committed over explicit and explicit over legacy", async () => {
    const root = tempDir();
    const committed = createDb(join(root, "c.sqlite"), "c");
    const explicit = createDb(join(root, "e.sqlite"), "e");
    const legacy = createDb(join(root, "l.sqlite"), "l");
    const all = await resolveDbSource({
      candidates: [
        candidate("plugin-link", legacy),
        candidate("explicit-selection", explicit),
        candidate("desktop-committed", committed),
      ],
      probe: fakeProbe(),
    });
    expect(all.decision).toMatchObject({ kind: "use", reason: "desktop-committed" });
    const noCommitted = await resolveDbSource({
      candidates: [candidate("plugin-link", legacy), candidate("explicit-selection", explicit)],
      probe: fakeProbe(),
    });
    expect(noCommitted.decision).toMatchObject({ kind: "use", reason: "explicit-selection" });
  });

  it("asks when a chosen tier points at two distinct databases", async () => {
    const root = tempDir();
    const result = await resolveDbSource({
      candidates: [
        candidate("explicit-selection", createDb(join(root, "1.sqlite"), "1")),
        candidate("explicit-selection", createDb(join(root, "2.sqlite"), "2")),
      ],
      probe: fakeProbe(),
    });
    expect(result.decision).toMatchObject({ kind: "needs-user-choice", reason: "multiple-distinct" });
  });

  it("treats an invalid raw value as unreadable without probing it", async () => {
    const calls: string[] = [];
    const result = await resolveDbSource({
      candidates: [{ ...candidate("desktop-committed", "C:x"), invalidReason: "bad" }],
      probe: fakeProbe({}, calls),
    });
    expect(calls).toEqual([]);
    expect(result.decision).toMatchObject({ kind: "blocked", status: "unreadable" });
    expect(result.candidates[0]?.detail).toBe("bad");
  });

  it("converts a throwing probe into unreadable", async () => {
    const result = await resolveDbSource({
      candidates: [candidate("desktop-committed", "/x"), candidate("explicit-selection", "/y")],
      probe: async (path) => {
        throw path === "/x" ? new Error("boom") : "text";
      },
    });
    expect(result.candidates.map((entry) => entry.detail)).toEqual(["boom", "text"]);
    expect(result.decision).toMatchObject({ kind: "blocked", status: "unreadable" });
  });

  it("keeps denied and unreadable distinct", async () => {
    const root = tempDir();
    const denied = await resolveDbSource({
      candidates: [candidate("plugin-link", join(root, "d"))],
      probe: fakeProbe({ [join(root, "d")]: { status: "denied" } }),
    });
    const unreadable = await resolveDbSource({
      candidates: [candidate("plugin-link", join(root, "u"))],
      probe: fakeProbe({ [join(root, "u")]: { status: "unreadable" } }),
    });
    expect(denied.groups[0]?.status).toBe("denied");
    expect(unreadable.groups[0]?.status).toBe("unreadable");
    expect(denied.decision).toMatchObject({ kind: "needs-user-choice", reason: "unverifiable" });
  });

  it("asks when the only ok legacy database sits beside an unreadable one", async () => {
    const root = tempDir();
    const ok = createDb(join(root, "ok.sqlite"));
    const result = await resolveDbSource({
      candidates: [candidate("plugin-link", ok), candidate("agent-mcp", join(root, "locked.sqlite"))],
      probe: fakeProbe({ [join(root, "locked.sqlite")]: { status: "denied" } }),
    });
    expect(result.decision).toMatchObject({ kind: "needs-user-choice", reason: "unverifiable" });
  });

  it("ignores a dangling legacy pointer when a default database is fine", async () => {
    const root = tempDir();
    const result = await resolveDbSource({
      candidates: [
        candidate("plugin-link", join(root, "gone.sqlite")),
        candidate("standalone-default", createDb(join(root, "s.sqlite"))),
      ],
      probe: fakeProbe(),
    });
    expect(result.decision).toMatchObject({ kind: "use", reason: "default" });
  });

  it("asks instead of offering a new database when a legacy pointer dangles and defaults are missing", async () => {
    const root = tempDir();
    const result = await resolveDbSource({
      candidates: [
        candidate("plugin-link", join(root, "gone.sqlite")),
        candidate("standalone-default", join(root, "n.sqlite")),
      ],
      probe: fakeProbe(),
    });
    expect(result.decision).toMatchObject({ kind: "needs-user-choice", reason: "unverifiable" });
  });

  it("flags conflict among defaults and distinct defaults", async () => {
    const root = tempDir();
    const a = createDb(join(root, "a.sqlite"));
    copyFileSync(a, join(root, "b.sqlite"));
    const result = await resolveDbSource({
      candidates: [candidate("standalone-default", a), candidate("checkout-default", join(root, "b.sqlite"))],
      probe: fakeProbe(),
    });
    expect(result.decision).toMatchObject({ kind: "needs-user-choice", reason: "conflict" });
  });

  it("flags a lone ok group that is a copy of a group excluded from the decision tier", async () => {
    const root = tempDir();
    const a = createDb(join(root, "a.sqlite"));
    copyFileSync(a, join(root, "b.sqlite"));
    const result = await resolveDbSource({
      candidates: [candidate("plugin-link", a), candidate("desktop-committed", join(root, "b.sqlite"))],
      probe: fakeProbe({
        [join(root, "b.sqlite")]: { status: "ok", identity: { realPath: "/b", fileId: null, lineageId: lineageOf(a) } },
      }),
    });
    expect(result.decision.kind).toBe("use");
    const legacyOnly = await resolveDbSource({
      candidates: [candidate("plugin-link", a), candidate("standalone-default", join(root, "b.sqlite"))],
      probe: fakeProbe(),
    });
    expect(legacyOnly.decision).toMatchObject({ kind: "needs-user-choice", reason: "conflict" });
  });

  it("offers a new database with explicit consent only when every default is missing", async () => {
    const root = tempDir();
    const standalone = join(root, "cfg", "work-intelligence.sqlite");
    const result = await resolveDbSource({
      candidates: [
        candidate("checkout-default", join(root, "repo.sqlite")),
        candidate("standalone-default", standalone),
      ],
      probe: fakeProbe(),
    });
    expect(result.decision).toEqual({ kind: "offer-new-database", path: standalone, requiresExplicitConsent: true });
    const checkoutOnly = await resolveDbSource({
      candidates: [candidate("checkout-default", join(root, "repo.sqlite"))],
      probe: fakeProbe(),
    });
    expect(checkoutOnly.decision).toMatchObject({ kind: "offer-new-database", path: join(root, "repo.sqlite") });
  });

  it("does not offer a new database on a known-offline volume", async () => {
    const root = tempDir();
    const result = await resolveDbSource({
      candidates: [candidate("standalone-default", join(root, "cfg", "db.sqlite"))],
      probe: fakeProbe(),
      isOfflineVolume: (directory) => directory === join(root, "cfg"),
    });
    expect(result.decision).toMatchObject({ kind: "needs-user-choice", reason: "unverifiable" });
  });

  it("cannot offer anything without a default candidate", async () => {
    const result = await resolveDbSource({ candidates: [], probe: fakeProbe() });
    expect(result.decision).toEqual({ kind: "needs-user-choice", groups: [], reason: "unverifiable" });
  });

  it("uses win32 path rules for parents when asked", async () => {
    const result = await resolveDbSource({
      candidates: [candidate("standalone-default", "C:\\cfg\\db.sqlite")],
      probe: async () => ({ status: "missing" }),
      platform: "win32",
      isOfflineVolume: (directory) => directory === "C:\\cfg",
    });
    expect(result.decision.kind).toBe("needs-user-choice");
  });

  it("never writes: the directory is identical before and after", async () => {
    const root = tempDir();
    const a = createDb(join(root, "a.sqlite"), "one");
    createDb(join(root, "b.sqlite"), "two");
    const before = snapshot(root);
    await resolveDbSource({
      candidates: [
        candidate("plugin-link", a),
        candidate("agent-mcp", join(root, "b.sqlite")),
        candidate("standalone-default", join(root, "new", "db.sqlite")),
      ],
      probe: fakeProbe(),
    });
    expect(snapshot(root)).toEqual(before);
  });

  it("handles a database without schema_migrations (null lineage never conflicts)", async () => {
    const root = tempDir();
    const result = await resolveDbSource({
      candidates: [
        candidate("plugin-link", createDb(join(root, "a.sqlite"), null)),
        candidate("agent-mcp", createDb(join(root, "b.sqlite"), null)),
      ],
      probe: fakeProbe(),
    });
    expect(result.decision).toMatchObject({ kind: "needs-user-choice", reason: "multiple-distinct" });
  });
});
