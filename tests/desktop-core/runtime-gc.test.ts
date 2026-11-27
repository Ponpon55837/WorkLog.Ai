import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GC_STATE_FILE_NAME,
  LEASE_HEARTBEAT_MS,
  RETIRED_GRACE_MS,
  collectOldRuntimes,
  leaseDirectoryFor,
  type CollectOldRuntimesOptions,
  type RuntimeCollection,
  type RuntimeCollectionDeps,
} from "../../packages/desktop-core/src/runtime/index.js";
import { REAL_COLLECTION_DEPS } from "../../packages/desktop-core/src/runtime/runtime-gc.js";
import { IS_WINDOWS, installFixture, makeRoot } from "./runtime-helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2030-01-01T00:00:00Z");

let root = "";

beforeEach(async () => {
  root = await makeRoot("desktop-gc");
  await installFixture(root, "old-1");
  await installFixture(root, "prev-1");
  await installFixture(root, "cur-1", { commit: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

class FakeClock {
  wall = START;
  monotonic = 0;
  readonly sleeps: number[] = [];
  onSleep: () => Promise<void> = async () => undefined;

  readonly deps: Partial<RuntimeCollectionDeps> = {
    now: () => this.wall,
    monotonic: () => this.monotonic,
    sleep: async (milliseconds) => {
      this.sleeps.push(milliseconds);
      await this.onSleep();
      this.advance(milliseconds);
    },
  };

  advance(milliseconds: number): void {
    this.wall += milliseconds;
    this.monotonic += milliseconds;
  }
}

const runtimeNames = async (): Promise<string[]> => (await fs.readdir(path.join(root, "runtimes"))).sort();
const statePath = (): string => path.join(root, "leases", GC_STATE_FILE_NAME);

async function readState(): Promise<{ version: number; retiredAt: Record<string, string>; kept?: string[] }> {
  return JSON.parse(await fs.readFile(statePath(), "utf8")) as {
    version: number;
    retiredAt: Record<string, string>;
    kept?: string[];
  };
}

async function seedRetired(clock: FakeClock, names: readonly string[], age: number): Promise<void> {
  const retiredAt = Object.fromEntries(names.map((name) => [name, new Date(clock.wall - age).toISOString()]));
  await fs.writeFile(statePath(), JSON.stringify({ version: 1, retiredAt, kept: ["prev-1"] }));
}

async function writeLease(clock: FakeClock, runtimeId: string, name: string, ageMs: number): Promise<string> {
  const directory = leaseDirectoryFor(root, runtimeId);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await fs.writeFile(file, JSON.stringify({ action: "mcp", createdAt: new Date(clock.wall).toISOString() }));
  const modified = new Date(clock.wall - ageMs);
  await fs.utimes(file, modified, modified);
  return file;
}

function collect(clock: FakeClock, options: CollectOldRuntimesOptions = {}): Promise<RuntimeCollection> {
  return collectOldRuntimes(root, { keep: ["prev-1"], ...options, deps: { ...clock.deps, ...options.deps } });
}

describe("collectOldRuntimes: retirement", () => {
  it("records when it first saw a runtime retired and defers it until the grace period has passed", async () => {
    const clock = new FakeClock();
    expect(await collect(clock)).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "retired-recently" }],
      failed: [],
    });
    expect((await readState()).retiredAt).toEqual({ "old-1": new Date(START).toISOString() });
    if (!IS_WINDOWS) expect((await fs.stat(statePath())).mode & 0o777).toBe(0o600);
    clock.advance(RETIRED_GRACE_MS - DAY_MS);
    expect((await collect(clock)).deferred).toEqual([{ name: "old-1", reason: "retired-recently" }]);
    expect((await readState()).retiredAt["old-1"]).toBe(new Date(START).toISOString());
    clock.advance(DAY_MS);
    expect(await collect(clock)).toEqual({ removed: ["old-1"], deferred: [], failed: [] });
    expect(await runtimeNames()).toEqual(["cur-1", "prev-1"]);
  });

  it("never removes current or the previous runtime, however long they were listed as retired", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["cur-1", "prev-1"], 100 * DAY_MS);
    expect(await collect(clock)).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "retired-recently" }],
      failed: [],
    });
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
    expect((await readState()).retiredAt).toEqual({ "old-1": new Date(START).toISOString() });
  });

  it("keeps the previous runtime a later start no longer names", async () => {
    const clock = new FakeClock();
    await collect(clock);
    clock.advance(30 * DAY_MS);
    const result = await collectOldRuntimes(root, { deps: clock.deps });
    expect(result.removed).toEqual(["old-1"]);
    expect(await runtimeNames()).toEqual(["cur-1", "prev-1"]);
  });

  it("keeps the runtime the last install named even when the record on disk is an older one (L-13)", async () => {
    const clock = new FakeClock();
    await collect(clock);
    await fs.writeFile(
      statePath(),
      JSON.stringify({
        version: 1,
        retiredAt: { "prev-1": new Date(clock.wall - 100 * DAY_MS).toISOString() },
        kept: ["older-1"],
      }),
    );
    clock.advance(30 * DAY_MS);
    const result = await collectOldRuntimes(root, { deps: clock.deps });
    expect(result.removed).not.toContain("prev-1");
    expect(await runtimeNames()).toContain("prev-1");
  });

  it("replaces a malformed record instead of trusting or failing on it", async () => {
    const clock = new FakeClock();
    for (const damaged of ["{not json", "[]", JSON.stringify({ version: 2, retiredAt: {} }), "x".repeat(300 * 1024)]) {
      await fs.writeFile(statePath(), damaged);
      expect((await collect(clock)).deferred).toEqual([{ name: "old-1", reason: "retired-recently" }]);
      expect(await readState()).toMatchObject({ version: 1, retiredAt: { "old-1": new Date(START).toISOString() } });
    }
  });

  it("drops the record of runtimes that are gone or current again, and writes nothing when nothing changed", async () => {
    const clock = new FakeClock();
    await fs.writeFile(
      statePath(),
      JSON.stringify({
        version: 1,
        retiredAt: { "old-1": new Date(START).toISOString(), "gone-1": new Date(START).toISOString() },
        kept: ["prev-1"],
      }),
    );
    await collect(clock);
    expect((await readState()).retiredAt).toEqual({ "old-1": new Date(START).toISOString() });
    const before = await fs.stat(statePath(), { bigint: true });
    await collect(clock);
    expect((await fs.stat(statePath(), { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  });
});

describe("collectOldRuntimes: proof of no live connection", () => {
  it("defers a runtime with a fresh lease, and keeps its directory and lease", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    const lease = await writeLease(clock, "old-1", "aaaa.lease", LEASE_HEARTBEAT_MS);
    expect(await collect(clock)).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "live-lease" }],
      failed: [],
    });
    expect(await runtimeNames()).toContain("old-1");
    await expect(fs.access(lease)).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([]);
  });

  it("defers a runtime whose stale-looking lease is renewed while the collector waits", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    const lease = await writeLease(clock, "old-1", "bbbb.lease", 10 * 60_000);
    clock.onSleep = async () => {
      const renewed = new Date(clock.wall + 1_000);
      await fs.utimes(lease, renewed, renewed);
    };
    expect((await collect(clock)).deferred).toEqual([{ name: "old-1", reason: "live-lease" }]);
    expect(clock.sleeps).toEqual([2 * LEASE_HEARTBEAT_MS]);
    expect(await runtimeNames()).toContain("old-1");
  });

  it("defers a runtime whose lease is joined by a new one while the collector waits", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    await writeLease(clock, "old-1", "cccc.lease", 10 * 60_000);
    clock.onSleep = async () => void (await writeLease(clock, "old-1", "dddd.lease", 0));
    expect((await collect(clock)).deferred).toEqual([{ name: "old-1", reason: "live-lease" }]);
  });

  it("removes a runtime whose leases are crash leftovers, waiting on the monotonic clock first, and its lease folder", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    await writeLease(clock, "old-1", "eeee.lease", 10 * 60_000);
    await writeLease(clock, "old-1", "ffff.lease", 2 * DAY_MS);
    expect(await collect(clock)).toEqual({ removed: ["old-1"], deferred: [], failed: [] });
    expect(clock.monotonic).toBeGreaterThanOrEqual(2 * LEASE_HEARTBEAT_MS);
    expect(await runtimeNames()).toEqual(["cur-1", "prev-1"]);
    await expect(fs.access(leaseDirectoryFor(root, "old-1"))).rejects.toThrow();
  });

  it("does not stop waiting early when a sleep returns before the monotonic clock has advanced enough", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    await writeLease(clock, "old-1", "gggg.lease", 10 * 60_000);
    const deps: Partial<RuntimeCollectionDeps> = {
      ...clock.deps,
      sleep: async (milliseconds) => {
        clock.sleeps.push(milliseconds);
        clock.advance(Math.ceil(milliseconds / 2));
      },
    };
    expect((await collectOldRuntimes(root, { keep: ["prev-1"], deps })).removed).toEqual(["old-1"]);
    expect(clock.sleeps.length).toBeGreaterThan(1);
    expect(clock.monotonic).toBeGreaterThanOrEqual(2 * LEASE_HEARTBEAT_MS);
  });

  it("renames a runtime back and defers it when a lease appears after the rename", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    await writeLease(clock, "old-1", "hhhh.lease", 10 * 60_000);
    const renames: string[] = [];
    const rename: RuntimeCollectionDeps["rename"] = async (from, to) => {
      await fs.rename(from, to);
      renames.push(`${path.basename(from)} -> ${path.basename(to).replace(/-[0-9a-f]{8}$/, "-<random>")}`);
      if (path.basename(to).startsWith(".quarantine-")) await writeLease(clock, "old-1", "iiii.lease", 0);
    };
    expect(await collect(clock, { deps: { rename } })).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "lease-appeared" }],
      failed: [],
    });
    expect(renames).toEqual([
      "old-1 -> .quarantine-old-1-<random>",
      expect.stringMatching(/^\.quarantine-old-1-[0-9a-f]{8} -> old-1$/),
    ]);
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
    await expect(fs.access(path.join(root, "runtimes", "old-1", "launcher.mjs"))).resolves.toBeUndefined();
  });

  it("defers a runtime that cannot be moved aside (a Windows lock) and removes it once it can", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    const locked: RuntimeCollectionDeps["rename"] = () =>
      Promise.reject(Object.assign(new Error("in use"), { code: "EPERM" }));
    expect(await collect(clock, { deps: { rename: locked } })).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "locked" }],
      failed: [],
    });
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
    clock.advance(10 * 60_000);
    expect(await collect(clock)).toEqual({ removed: ["old-1"], deferred: [], failed: [] });
    expect(await runtimeNames()).toEqual(["cur-1", "prev-1"]);
  });

  it("reports a quarantined directory it cannot delete as failed, and collects it as a leftover next time", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    const stuck = async (): Promise<void> => Promise.reject(Object.assign(new Error("in use"), { code: "EBUSY" }));
    expect(await collect(clock, { remove: stuck })).toEqual({ removed: [], deferred: [], failed: ["old-1"] });
    const [leftover] = (await runtimeNames()).filter((name) => name.startsWith(".quarantine-old-1-"));
    expect(leftover).toBeDefined();
    expect((await collect(clock)).removed).toEqual([leftover]);
    expect(await runtimeNames()).toEqual(["cur-1", "prev-1"]);
  });
});

describe("collectOldRuntimes: lease folders", () => {
  it("removes the lease folders and lease files of runtimes that no longer exist", async () => {
    const clock = new FakeClock();
    await writeLease(clock, "ghost-1", "jjjj.lease", 3 * DAY_MS);
    await writeLease(clock, "cur-1", "kkkk.lease", 0);
    await fs.mkdir(leaseDirectoryFor(root, "ghost-2"), { recursive: true });
    await fs.writeFile(path.join(leaseDirectoryFor(root, "ghost-2"), "notes.txt"), "not a lease");
    await fs.mkdir(path.join(root, "leases", "not a runtime id"), { recursive: true });
    await collect(clock);
    await expect(fs.access(leaseDirectoryFor(root, "ghost-1"))).rejects.toThrow();
    await expect(fs.access(path.join(leaseDirectoryFor(root, "cur-1"), "kkkk.lease"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(leaseDirectoryFor(root, "ghost-2"), "notes.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "leases", "not a runtime id"))).resolves.toBeUndefined();
  });

  it("keeps its own record when it cleans orphan lease folders, and never changes the launcher root", async () => {
    const clock = new FakeClock();
    await writeLease(clock, "ghost-1", "llll.lease", 3 * DAY_MS);
    await collect(clock);
    await expect(fs.access(statePath())).resolves.toBeUndefined();
    await fs.rm(path.join(root, "leases", "ghost-1"), { recursive: true, force: true });
    expect(await fs.readdir(root)).not.toContain("runtime-gc-state.json");
    const before = await fs.stat(root, { bigint: true });
    await fs.rm(statePath());
    await collect(clock);
    await expect(fs.access(statePath())).resolves.toBeUndefined();
    expect((await fs.stat(root, { bigint: true })).ctimeNs).toBe(before.ctimeNs);
  });

  it.skipIf(IS_WINDOWS)(
    "never follows a link: not for an orphan lease folder, not for a runtime's, not for a lease file",
    async () => {
      const clock = new FakeClock();
      await seedRetired(clock, ["old-1"], 8 * DAY_MS);
      const outside = path.join(root, "outside");
      await fs.mkdir(outside);
      const precious = path.join(outside, "precious.lease");
      await fs.writeFile(precious, "{}");
      await fs.symlink(outside, leaseDirectoryFor(root, "ghost-1"));
      await fs.symlink(outside, leaseDirectoryFor(root, "old-1"));
      const result = await collect(clock);
      expect(result).toEqual({ removed: [], deferred: [{ name: "old-1", reason: "live-lease" }], failed: [] });
      expect((await fs.lstat(leaseDirectoryFor(root, "ghost-1"))).isSymbolicLink()).toBe(true);
      expect((await fs.lstat(leaseDirectoryFor(root, "old-1"))).isSymbolicLink()).toBe(true);
      await expect(fs.access(precious)).resolves.toBeUndefined();

      await fs.rm(leaseDirectoryFor(root, "old-1"));
      await fs.mkdir(leaseDirectoryFor(root, "ghost-3"));
      await fs.symlink(precious, path.join(leaseDirectoryFor(root, "ghost-3"), "link.lease"));
      await collect(clock);
      await expect(fs.access(precious)).resolves.toBeUndefined();
    },
  );
});

async function quarantine(runtimeId: string, suffix = "ab12cd34"): Promise<string> {
  const name = `.quarantine-${runtimeId}-${suffix}`;
  await fs.rename(path.join(root, "runtimes", runtimeId), path.join(root, "runtimes", name));
  return name;
}

describe("collectOldRuntimes: quarantined directories need the same proof", () => {
  it("renames a quarantine back and defers it when its runtime has a fresh lease and its name is free", async () => {
    const clock = new FakeClock();
    const name = await quarantine("old-1");
    await writeLease(clock, "old-1", "mmmm.lease", 0);
    expect(await collect(clock)).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "lease-appeared" }],
      failed: [],
    });
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
    expect(await runtimeNames()).not.toContain(name);
    await expect(fs.access(path.join(root, "runtimes", "old-1", "launcher.mjs"))).resolves.toBeUndefined();
  });

  it("keeps a quarantine with a fresh lease when its runtime name is taken, and never deletes it", async () => {
    const clock = new FakeClock();
    const name = await quarantine("old-1");
    await installFixture(root, "old-1");
    await writeLease(clock, "old-1", "nnnn.lease", LEASE_HEARTBEAT_MS);
    const result = await collect(clock);
    expect(result.removed).toEqual([]);
    expect(result.deferred).toContainEqual({ name, reason: "live-lease" });
    expect(await runtimeNames()).toContain(name);
    await expect(fs.access(path.join(root, "runtimes", name, "launcher.mjs"))).resolves.toBeUndefined();
  });

  it("keeps a quarantine whose stale-looking lease is renewed while the collector waits", async () => {
    const clock = new FakeClock();
    const name = await quarantine("old-1");
    await installFixture(root, "old-1");
    const lease = await writeLease(clock, "old-1", "oooo.lease", 10 * 60_000);
    clock.onSleep = async () => {
      const renewed = new Date(clock.wall + 1_000);
      await fs.utimes(lease, renewed, renewed);
    };
    const result = await collect(clock);
    expect(result.removed).toEqual([]);
    expect(result.deferred).toContainEqual({ name, reason: "live-lease" });
    expect(clock.sleeps).toEqual([2 * LEASE_HEARTBEAT_MS]);
    expect(await runtimeNames()).toContain(name);
  });

  it("removes a quarantine only after its leases stayed silent for two heartbeats on the monotonic clock", async () => {
    const clock = new FakeClock();
    const name = await quarantine("old-1");
    await writeLease(clock, "old-1", "pppp.lease", 10 * 60_000);
    expect(await collect(clock)).toEqual({ removed: [name], deferred: [], failed: [] });
    expect(clock.monotonic).toBeGreaterThanOrEqual(2 * LEASE_HEARTBEAT_MS);
    expect(await runtimeNames()).toEqual(["cur-1", "prev-1"]);
  });

  it("finishes the path of a failed rename back: kept while a lease lives, removed once it has gone stale", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    await writeLease(clock, "old-1", "qqqq.lease", 10 * 60_000);
    const failingBack: RuntimeCollectionDeps["rename"] = async (from, to) => {
      if (path.basename(from).startsWith(".quarantine-")) throw Object.assign(new Error("in use"), { code: "EPERM" });
      await fs.rename(from, to);
      if (path.basename(to).startsWith(".quarantine-")) await writeLease(clock, "old-1", "rrrr.lease", 0);
    };
    expect(await collect(clock, { deps: { rename: failingBack } })).toEqual({
      removed: [],
      deferred: [],
      failed: ["old-1"],
    });
    const [leftover] = (await runtimeNames()).filter((name) => name.startsWith(".quarantine-old-1-"));
    expect(leftover).toBeDefined();
    expect(await collect(clock, { deps: { rename: failingBack } })).toMatchObject({ removed: [], failed: [] });
    expect(await runtimeNames()).toContain(leftover);
    expect(await collect(clock)).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "lease-appeared" }],
      failed: [],
    });
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    clock.advance(10 * 60_000);
    expect(await collect(clock)).toEqual({ removed: ["old-1"], deferred: [], failed: [] });
  });

  it("never deletes the quarantine of current or the previous runtime, and does not rename it back", async () => {
    const clock = new FakeClock();
    const previous = await quarantine("prev-1");
    await installFixture(root, "prev-1");
    const current = await quarantine("cur-1", "ef56ab78");
    const result = await collect(clock);
    expect(result.removed).toEqual([]);
    expect(result.deferred).toEqual(
      expect.arrayContaining([
        { name: previous, reason: "live-lease" },
        { name: current, reason: "live-lease" },
      ]),
    );
    expect(await runtimeNames()).toEqual(expect.arrayContaining([previous, current]));
    expect(await runtimeNames()).not.toContain("cur-1");
  });

  it("reads the runtime id from the name when the id itself has hyphens, and leaves a name it cannot read alone", async () => {
    const clock = new FakeClock();
    await installFixture(root, "old-a-2");
    const hyphenated = await quarantine("old-a-2", "0a1b2c3d");
    await fs.mkdir(path.join(root, "runtimes", ".quarantine-not-ours"), { recursive: true });
    await writeLease(clock, "old-a-2", "ssss.lease", 0);
    await installFixture(root, "old-a-2");
    const result = await collect(clock);
    expect(result.deferred).toContainEqual({ name: hyphenated, reason: "live-lease" });
    expect(result.removed).toEqual([]);
    expect(await runtimeNames()).toContain(".quarantine-not-ours");
  });

  it("re-reads current right before removing a quarantine", async () => {
    const clock = new FakeClock();
    const name = await quarantine("old-1");
    await writeLease(clock, "old-1", "tttt.lease", 10 * 60_000);
    clock.onSleep = async () => void (await fs.writeFile(path.join(root, "current"), "old-1\n"));
    expect(await collect(clock)).toEqual({
      removed: [],
      deferred: [{ name, reason: "live-lease" }],
      failed: [],
    });
    expect(await runtimeNames()).toContain(name);
  });

  it("still removes a quarantine with no leases when current cannot be read", async () => {
    const clock = new FakeClock();
    const name = await quarantine("old-1");
    await fs.rm(path.join(root, "current"));
    expect(await collectOldRuntimes(root, { deps: clock.deps })).toEqual({ removed: [name], deferred: [], failed: [] });
  });
});

describe("collectOldRuntimes: no known kept list", () => {
  it("records nothing and retires nothing when the record is missing and the caller names no previous runtime", async () => {
    const clock = new FakeClock();
    const first = await collectOldRuntimes(root, { keep: [], deps: clock.deps });
    expect(first.removed).toEqual([]);
    expect(first.deferred).toEqual(
      expect.arrayContaining([
        { name: "old-1", reason: "retired-recently" },
        { name: "prev-1", reason: "retired-recently" },
      ]),
    );
    await expect(fs.access(statePath())).rejects.toThrow();
    clock.advance(30 * DAY_MS);
    const later = await collectOldRuntimes(root, { deps: clock.deps });
    expect(later.removed).toEqual([]);
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
    await expect(fs.access(statePath())).rejects.toThrow();
  });

  it("starts retiring once an install names the previous runtime", async () => {
    const clock = new FakeClock();
    await collectOldRuntimes(root, { deps: clock.deps });
    expect(await collect(clock)).toMatchObject({ deferred: [{ name: "old-1", reason: "retired-recently" }] });
    expect(await readState()).toMatchObject({
      kept: ["prev-1"],
      retiredAt: { "old-1": new Date(START).toISOString() },
    });
    clock.advance(RETIRED_GRACE_MS);
    expect(await collectOldRuntimes(root, { deps: clock.deps })).toEqual({
      removed: ["old-1"],
      deferred: [],
      failed: [],
    });
    expect(await runtimeNames()).toEqual(["cur-1", "prev-1"]);
  });

  it("retires nothing when the record is damaged and no previous runtime is named, and does not rewrite it", async () => {
    const clock = new FakeClock();
    for (const damaged of [
      "{not json",
      JSON.stringify({ version: 1, retiredAt: { "old-1": new Date(START - 30 * DAY_MS).toISOString() } }),
    ]) {
      await fs.writeFile(statePath(), damaged);
      const result = await collectOldRuntimes(root, { deps: clock.deps });
      expect(result.removed).toEqual([]);
      expect(result.deferred.map((entry) => entry.reason)).toEqual(["retired-recently", "retired-recently"]);
      expect(await fs.readFile(statePath(), "utf8")).toBe(damaged);
    }
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
  });

  it("retires nothing when the record cannot be written and no previous runtime is named", async () => {
    const clock = new FakeClock();
    await fs.rm(path.join(root, "leases"), { recursive: true, force: true });
    await fs.writeFile(path.join(root, "leases"), "not a directory");
    clock.advance(30 * DAY_MS);
    const result = await collectOldRuntimes(root, { deps: clock.deps });
    expect(result.removed).toEqual([]);
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
  });
});

describe("collectOldRuntimes: leases of kept runtimes", () => {
  it("removes the dead leases of current and the previous runtime, and nothing that lives", async () => {
    const clock = new FakeClock();
    const dead = await writeLease(clock, "cur-1", "uuuu.lease", 10 * 60_000);
    const alive = await writeLease(clock, "cur-1", "vvvv.lease", 0);
    const renewed = await writeLease(clock, "prev-1", "wwww.lease", 10 * 60_000);
    const deadPrevious = await writeLease(clock, "prev-1", "xxxx.lease", 3 * DAY_MS);
    clock.onSleep = async () => {
      const moved = new Date(clock.wall + 1_000);
      await fs.utimes(renewed, moved, moved);
    };
    await collect(clock);
    expect(clock.sleeps).toEqual([2 * LEASE_HEARTBEAT_MS]);
    await expect(fs.access(dead)).rejects.toThrow();
    await expect(fs.access(deadPrevious)).rejects.toThrow();
    await expect(fs.access(alive)).resolves.toBeUndefined();
    await expect(fs.access(renewed)).resolves.toBeUndefined();
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
  });

  it.skipIf(IS_WINDOWS)("never follows or removes a link named like a lease", async () => {
    const clock = new FakeClock();
    const outside = path.join(root, "outside.lease");
    await fs.writeFile(outside, "{}");
    await fs.mkdir(leaseDirectoryFor(root, "cur-1"), { recursive: true });
    const link = path.join(leaseDirectoryFor(root, "cur-1"), "yyyy.lease");
    await fs.symlink(outside, link);
    const old = new Date(clock.wall - 10 * 60_000);
    await fs.lutimes(link, old, old);
    await collect(clock);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    await expect(fs.access(outside)).resolves.toBeUndefined();
  });
});

describe("collectOldRuntimes: races", () => {
  it("skips a runtime that became current while the collector waited, and leaves it where it is", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    await writeLease(clock, "old-1", "zzzz.lease", 10 * 60_000);
    clock.onSleep = async () => void (await fs.writeFile(path.join(root, "current"), "old-1\n"));
    expect(await collect(clock)).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "became-kept" }],
      failed: [],
    });
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1"]);
  });

  it("skips a runtime that the record now keeps", async () => {
    const clock = new FakeClock();
    await seedRetired(clock, ["old-1"], 8 * DAY_MS);
    await writeLease(clock, "old-1", "abab.lease", 10 * 60_000);
    clock.onSleep = async () =>
      void (await fs.writeFile(statePath(), JSON.stringify({ version: 1, retiredAt: {}, kept: ["old-1"] })));
    expect((await collect(clock)).deferred).toEqual([{ name: "old-1", reason: "became-kept" }]);
    expect(await runtimeNames()).toContain("old-1");
  });

  it("compares runtime ids case-insensitively where the file system does", async () => {
    const clock = new FakeClock();
    const options = { keep: ["PREV-1"] };
    const insensitive = await collect(clock, { ...options, deps: { caseInsensitiveIds: true } });
    expect(insensitive.deferred).toEqual([{ name: "old-1", reason: "retired-recently" }]);
    expect((await readState()).retiredAt).toEqual({ "old-1": new Date(START).toISOString() });
    const sensitive = await collect(clock, { ...options, deps: { caseInsensitiveIds: false } });
    expect(sensitive.deferred.map((entry) => entry.name).sort()).toEqual(["old-1", "prev-1"]);
  });

  it("treats a lease folder that differs only in case as the installed runtime's where ids are case-insensitive", async () => {
    const clock = new FakeClock();
    await fs.mkdir(leaseDirectoryFor(root, "OLD-1"), { recursive: true });
    await collect(clock, { deps: { caseInsensitiveIds: true } });
    await expect(fs.access(leaseDirectoryFor(root, "OLD-1"))).resolves.toBeUndefined();
    await collect(clock, { deps: { caseInsensitiveIds: false } });
    await expect(fs.access(leaseDirectoryFor(root, "OLD-1"))).rejects.toThrow();
  });
});

describe("collectOldRuntimes: the record cannot be written", () => {
  it("still collects when the record's path is taken by a folder", async () => {
    const clock = new FakeClock();
    await fs.mkdir(statePath(), { recursive: true });
    const result = await collect(clock);
    expect(result.failed).toEqual([]);
    expect((await fs.lstat(statePath())).isDirectory()).toBe(true);
    expect(await runtimeNames()).toEqual(expect.arrayContaining(["cur-1", "prev-1"]));
  });
});

describe("REAL_COLLECTION_DEPS", () => {
  it("sleeps for the time asked", async () => {
    const started = performance.now();
    await REAL_COLLECTION_DEPS.sleep(5);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4);
  });
});

describe.skipIf(IS_WINDOWS)("collectOldRuntimes: a leases folder that is a link", () => {
  it("does no lease work: defers every runtime that is not kept, writes no record and removes no orphan", async () => {
    const clock = new FakeClock();
    const name = await quarantine("old-1");
    await installFixture(root, "old-1");
    const outside = path.join(root, "outside-leases");
    await fs.mkdir(path.join(outside, "old-1"), { recursive: true });
    await fs.writeFile(path.join(outside, "old-1", "alive.lease"), "{}");
    await fs.mkdir(path.join(outside, "ghost-1"));
    await fs.rm(path.join(root, "leases"), { recursive: true, force: true });
    await fs.symlink(outside, path.join(root, "leases"));
    clock.advance(30 * DAY_MS);
    const result = await collect(clock);
    expect(result.removed).toEqual([]);
    expect(result.deferred).toEqual(
      expect.arrayContaining([
        { name: "old-1", reason: "live-lease" },
        { name, reason: "live-lease" },
      ]),
    );
    expect(await runtimeNames()).toEqual(["cur-1", "old-1", "prev-1", name].sort());
    expect(await fs.readdir(outside)).toEqual(expect.arrayContaining(["old-1", "ghost-1"]));
    expect(await fs.readdir(outside)).not.toContain(GC_STATE_FILE_NAME);
    expect((await fs.lstat(path.join(root, "leases"))).isSymbolicLink()).toBe(true);
  });
});
