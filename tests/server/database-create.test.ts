import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseIfMissing } from "../../apps/server/src/database-create.js";
import {
  DesktopChild,
  type DesktopChildDependencies,
  type DesktopChildHost,
} from "../../apps/server/src/desktop-child.js";
import { preflightDatabase } from "../../apps/server/src/database-preflight.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const directories: string[] = [];

function tempDir(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "wi-create-")));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("createDatabaseIfMissing", () => {
  it("creates an empty current database where nothing exists, and a preflight then finds it ok", async () => {
    const path = join(tempDir(), "work.sqlite");
    expect(createDatabaseIfMissing(path)).toBeUndefined();
    const result = await preflightDatabase(path);
    expect(result).toMatchObject({ status: "ok", compatibility: "current", projectCount: 0 });
    expect(result.identity?.lineageId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates the missing parent directories", async () => {
    const path = join(tempDir(), "a", "b", "work.sqlite");
    expect(createDatabaseIfMissing(path)).toBeUndefined();
    expect((await preflightDatabase(path)).status).toBe("ok");
  });

  it("never touches an existing non-database file", async () => {
    const path = join(tempDir(), "notes.sqlite");
    writeFileSync(path, "not a database");
    expect(createDatabaseIfMissing(path)).toEqual({ status: "unreadable", detail: "EEXIST" });
    expect(readFileSync(path, "utf8")).toBe("not a database");
    expect((await preflightDatabase(path)).status).toBe("unreadable");
  });

  it("reports an existing valid database as not created, and leaves it as it was", async () => {
    const path = join(tempDir(), "existing.sqlite");
    new WorkIntelligenceStore(path).close();
    const before = readFileSync(path);
    expect(createDatabaseIfMissing(path)).toEqual({ status: "unreadable", detail: "EEXIST" });
    expect(readFileSync(path)).toEqual(before);
    expect((await preflightDatabase(path)).status).toBe("ok");
  });

  it("never touches a zero-byte file, a directory or a symlink", () => {
    const root = tempDir();
    const empty = join(root, "empty.sqlite");
    writeFileSync(empty, "");
    const directory = join(root, "dir.sqlite");
    mkdirSync(directory);
    const dangling = join(root, "link.sqlite");
    symlinkSync(join(root, "nowhere.sqlite"), dangling);
    for (const path of [empty, directory, dangling]) {
      expect(createDatabaseIfMissing(path)).toEqual({ status: "unreadable", detail: "EEXIST" });
    }
    expect(readFileSync(empty)).toHaveLength(0);
    expect(readdirSync(directory)).toEqual([]);
    expect(existsSync(join(root, "nowhere.sqlite"))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(["dir.sqlite", "empty.sqlite", "link.sqlite"]);
  });

  it("reports unreadable and leaves nothing behind when a parent is a file", () => {
    const root = tempDir();
    writeFileSync(join(root, "blocker"), "x");
    const result = createDatabaseIfMissing(join(root, "blocker", "work.sqlite"));
    expect(result?.status).toBe("unreadable");
    expect(readdirSync(root)).toEqual(["blocker"]);
  });
});

describe("the child's createIfMissing preflight", () => {
  function child(path: string): { child: DesktopChild; sent: Record<string, unknown>[] } {
    const sent: Record<string, unknown>[] = [];
    const host: DesktopChildHost = {
      pid: 1,
      execPath: "/synthetic/node",
      send: (message, done) => {
        sent.push(message as unknown as Record<string, unknown>);
        done();
      },
      onMessage: () => undefined,
      onDisconnect: () => undefined,
      onSignal: () => undefined,
      exit: () => undefined,
      log: () => undefined,
    };
    void path;
    const dependencies: DesktopChildDependencies = {
      preflight: (value) => preflightDatabase(value),
      createDatabase: createDatabaseIfMissing,
      probePort: async () => ({ free: true }),
      startApi: vi.fn() as unknown as DesktopChildDependencies["startApi"],
    };
    const instance = new DesktopChild(host, dependencies);
    instance.begin();
    return { child: instance, sent };
  }

  it("creates and answers ok with an identity", async () => {
    const path = join(tempDir(), "sub", "work.sqlite");
    const { child: instance, sent } = child(path);
    await instance.handle({ type: "preflight", path, createIfMissing: true });
    expect(sent[1]).toMatchObject({ type: "preflight-result", status: "ok", identity: { realPath: path } });
    expect(existsSync(path)).toBe(true);
  });

  it("without the flag a missing file stays missing and nothing is created", async () => {
    const root = tempDir();
    const path = join(root, "sub", "work.sqlite");
    const { child: instance, sent } = child(path);
    await instance.handle({ type: "preflight", path });
    expect(sent[1]).toMatchObject({ status: "missing" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("with the flag an existing non-database file stays unchanged and is reported unreadable", async () => {
    const path = join(tempDir(), "work.sqlite");
    writeFileSync(path, "not a database");
    const { child: instance, sent } = child(path);
    await instance.handle({ type: "preflight", path, createIfMissing: true });
    expect(sent[1]).toMatchObject({ status: "unreadable" });
    expect(readFileSync(path, "utf8")).toBe("not a database");
  });
});
