import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEASE_FILE_SUFFIX,
  LEASE_HEARTBEAT_MS,
  PRINT_RUNTIME_INFO_FLAG,
  createLease,
  leaseDirectoryFor,
  observeLeases,
  runLauncher,
  type LauncherHost,
  type LeaseHandle,
} from "../../packages/desktop-core/src/runtime/index.js";
import { HOOK_BUDGET_MS, IS_WINDOWS, flipFirstByte, installFixture, makeRoot } from "./runtime-helpers.js";

// Synthetic ids and actions only.

let root = "";
let runtimeDirectory = "";

beforeEach(async () => {
  root = await makeRoot("desktop-lease");
  runtimeDirectory = (await installFixture(root, "rt-1", { commit: true })).runtimeDirectory;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface Recorded {
  readonly host: LauncherHost;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly events: string[];
  readonly exitHandlers: (() => void)[];
  readonly heartbeats: { tick: () => void; intervalMs: number }[];
}

/** A host whose lease comes from `acquire` (the real file lease by default) and whose process-level hooks are recorded. */
function recordingHost(acquire: LauncherHost["acquireLease"] = createLease): Recorded {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const events: string[] = [];
  const exitHandlers: (() => void)[] = [];
  const heartbeats: { tick: () => void; intervalMs: number }[] = [];
  const host: LauncherHost = {
    execPath: path.join(runtimeDirectory, "node/bin/node"),
    versions: { node: "24.0.0" },
    platform: "linux",
    arch: "x64",
    stdout: (text) => void stdout.push(text),
    stderr: (text) => void stderr.push(text),
    unsetEnv: () => undefined,
    getEnv: () => undefined,
    setEnv: () => undefined,
    desktopDatabase: () => ({ kind: "none" }),
    setArgv: () => undefined,
    importModule: async () => void events.push("import"),
    acquireLease: (...args) => {
      events.push("lease");
      return acquire(...args);
    },
    onExit: (handler) => void exitHandlers.push(handler),
    startHeartbeat: (tick, intervalMs) => void heartbeats.push({ tick, intervalMs }),
  };
  return { host, stdout, stderr, events, exitHandlers, heartbeats };
}

const refusing = (code: string): LauncherHost["acquireLease"] => {
  return () => {
    throw Object.assign(new Error(`${code}: cannot write ${root}`), { code });
  };
};

const leaseNames = async (): Promise<string[]> => [...(await observeLeases(leaseDirectoryFor(root, "rt-1"))).keys()];

describe("createLease", () => {
  it("creates one owner-only lease file with only the action and the time, and removes it", async () => {
    const lease = createLease(root, "rt-1", "mcp");
    const [name] = await leaseNames();
    expect(name).toMatch(new RegExp(`^[0-9a-f]{16}\\${LEASE_FILE_SUFFIX}$`));
    const file = path.join(leaseDirectoryFor(root, "rt-1"), name as string);
    const content = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(content).sort()).toEqual(["action", "createdAt"]);
    expect(content.action).toBe("mcp");
    expect(new Date(content.createdAt as string).toISOString()).toBe(content.createdAt);
    if (!IS_WINDOWS) expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    lease.remove();
    expect(await leaseNames()).toEqual([]);
    expect(() => lease.remove()).not.toThrow();
  });

  it("gives every process its own file", async () => {
    createLease(root, "rt-1", "serve");
    createLease(root, "rt-1", "serve");
    expect(await leaseNames()).toHaveLength(2);
  });

  it("refresh moves the modification time to now", async () => {
    const lease = createLease(root, "rt-1", "mcp");
    const [name] = await leaseNames();
    const file = path.join(leaseDirectoryFor(root, "rt-1"), name as string);
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(file, old, old);
    lease.refresh();
    expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it("throws, and leaves nothing behind, when the leases folder cannot exist", async () => {
    await fs.rm(path.join(root, "leases"), { recursive: true });
    await fs.writeFile(path.join(root, "leases"), "not a directory");
    expect(() => createLease(root, "rt-1", "mcp")).toThrow();
  });
});

describe("createLease: folders that are links or missing", () => {
  const linkedLeases = async (): Promise<string> => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.rm(path.join(root, "leases"), { recursive: true, force: true });
    await fs.symlink(outside, path.join(root, "leases"));
    return outside;
  };

  it.skipIf(IS_WINDOWS)(
    "never follows a leases folder that is a link: throws and writes nothing behind it",
    async () => {
      const outside = await linkedLeases();
      expect(() => createLease(root, "rt-1", "mcp")).toThrow(
        expect.objectContaining({ code: "LEASE_DIRECTORY_UNSAFE" }),
      );
      expect(await fs.readdir(outside)).toEqual([]);
    },
  );

  it.skipIf(IS_WINDOWS)("never follows a runtime's lease folder that is a link", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(path.join(root, "leases"), { recursive: true });
    await fs.symlink(outside, leaseDirectoryFor(root, "rt-1"));
    expect(() => createLease(root, "rt-1", "mcp")).toThrow(expect.objectContaining({ code: "LEASE_DIRECTORY_UNSAFE" }));
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("creates a missing leases folder, owner-only, one level at a time", async () => {
    await fs.rm(path.join(root, "leases"), { recursive: true, force: true });
    createLease(root, "rt-1", "mcp");
    expect(await leaseNames()).toHaveLength(1);
    if (!IS_WINDOWS) expect((await fs.stat(path.join(root, "leases"))).mode & 0o777).toBe(0o700);
    expect(() => createLease(path.join(root, "no-such-root"), "rt-1", "mcp")).toThrow();
    await expect(fs.access(path.join(root, "no-such-root"))).rejects.toThrow();
  });
});

describe("createLease: refresh after the file went missing", () => {
  it("creates the file again every time it is found missing, not only the first (L-14)", async () => {
    const lease = createLease(root, "rt-1", "mcp");
    const [name] = await leaseNames();
    const file = path.join(leaseDirectoryFor(root, "rt-1"), name as string);
    for (let round = 0; round < 3; round += 1) {
      await fs.rm(file);
      lease.refresh();
      expect(await leaseNames()).toEqual([name]);
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ action: "mcp" });
    }
  });

  it("also makes the runtime's lease folder again when a cleanup removed it", async () => {
    const lease = createLease(root, "rt-1", "serve");
    await fs.rm(leaseDirectoryFor(root, "rt-1"), { recursive: true });
    lease.refresh();
    expect(await leaseNames()).toHaveLength(1);
  });

  it("refuses to follow a leases folder that became a link", async () => {
    const lease = createLease(root, "rt-1", "mcp");
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.rm(path.join(root, "leases"), { recursive: true });
    if (IS_WINDOWS) return;
    await fs.symlink(outside, path.join(root, "leases"));
    expect(() => lease.refresh()).toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

describe("runLauncher: lease", () => {
  it("takes the lease before verifying and importing, even when the runtime turns out to be unusable", async () => {
    await flipFirstByte(path.join(runtimeDirectory, "app/mcp.js"));
    const recorded = recordingHost();
    await runLauncher({ runtimeDirectory, argv: ["mcp"] }, recorded.host);
    expect(recorded.events).toEqual(["lease"]);
    expect(await leaseNames()).toHaveLength(1);
  });

  it("removes the lease when the process exits", async () => {
    const recorded = recordingHost();
    await runLauncher({ runtimeDirectory, argv: ["codex-finalize-reminder"] }, recorded.host);
    expect(recorded.events).toEqual(["lease", "import"]);
    expect(await leaseNames()).toHaveLength(1);
    for (const handler of recorded.exitHandlers) handler();
    expect(await leaseNames()).toEqual([]);
  });

  it("refreshes the lease of a long-lived action every heartbeat, and a hook not at all", async () => {
    for (const action of ["mcp", "serve"]) {
      const recorded = recordingHost();
      await runLauncher({ runtimeDirectory, argv: [action] }, recorded.host);
      expect(recorded.heartbeats.map((beat) => beat.intervalMs)).toEqual([LEASE_HEARTBEAT_MS]);
    }
    for (const action of ["codex-finalize-reminder", "claude-finalize-reminder"]) {
      const recorded = recordingHost();
      await runLauncher({ runtimeDirectory, argv: [action] }, recorded.host);
      expect(recorded.heartbeats).toEqual([]);
    }
  });

  it("makes the heartbeat refresh the lease file", async () => {
    const mcp = recordingHost();
    await runLauncher({ runtimeDirectory, argv: ["mcp"] }, mcp.host);
    const [name] = await leaseNames();
    const file = path.join(leaseDirectoryFor(root, "rt-1"), name as string);
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(file, old, old);
    for (const { tick } of mcp.heartbeats) tick();
    expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it("takes no lease for a refused action or for the diagnostics flag", async () => {
    const refused = recordingHost();
    await runLauncher({ runtimeDirectory, argv: ["bash", "-c", "id"] }, refused.host);
    const diagnostics = recordingHost();
    await runLauncher({ runtimeDirectory, argv: [PRINT_RUNTIME_INFO_FLAG] }, diagnostics.host);
    expect(refused.events).toEqual([]);
    expect(diagnostics.events).toEqual([]);
    expect(diagnostics.stdout.join("")).toContain("rt-1");
    expect(await leaseNames()).toEqual([]);
  });

  it("starts the action without a word on stdout and with one path-free line on stderr when mcp cannot get a lease", async () => {
    const recorded = recordingHost(refusing("EROFS"));
    expect(await runLauncher({ runtimeDirectory, argv: ["mcp"] }, recorded.host)).toEqual({ kind: "handed-over" });
    expect(recorded.events).toEqual(["lease", "import"]);
    expect(recorded.stdout).toEqual([]);
    expect(recorded.stderr).toHaveLength(1);
    expect(recorded.stderr[0]).toContain("EROFS");
    expect(recorded.stderr.join("")).not.toContain(root);
    expect(recorded.heartbeats).toEqual([]);
  });

  it("stays silent for a hook that cannot get a lease, and still lets it run", async () => {
    for (const action of ["codex-finalize-reminder", "claude-finalize-reminder"]) {
      const recorded = recordingHost(refusing("EACCES"));
      expect(await runLauncher({ runtimeDirectory, argv: [action] }, recorded.host)).toEqual({ kind: "handed-over" });
      expect(recorded.events).toEqual(["lease", "import"]);
      expect(recorded.stderr).toEqual([]);
      expect(recorded.stdout).toEqual([]);
    }
  });

  it("works against a real file system that refuses the leases folder", async () => {
    await fs.rm(path.join(root, "leases"), { recursive: true });
    await fs.writeFile(path.join(root, "leases"), "not a directory");
    const mcp = recordingHost();
    expect(await runLauncher({ runtimeDirectory, argv: ["mcp"] }, mcp.host)).toEqual({ kind: "handed-over" });
    expect(mcp.stdout).toEqual([]);
    expect(mcp.stderr).toHaveLength(1);
    expect(mcp.stderr.join("")).not.toContain(root);
    const hook = recordingHost();
    expect(await runLauncher({ runtimeDirectory, argv: ["claude-finalize-reminder"] }, hook.host)).toEqual({
      kind: "handed-over",
    });
    expect(hook.stderr).toEqual([]);
  });

  it.skipIf(IS_WINDOWS)(
    "runs the action when the leases folder is a link, with one path-free line (none for a hook)",
    async () => {
      const outside = path.join(root, "outside");
      await fs.mkdir(outside);
      await fs.rm(path.join(root, "leases"), { recursive: true, force: true });
      await fs.symlink(outside, path.join(root, "leases"));
      const hook = recordingHost();
      // verifyRuntime rejects the link itself; the point is that no lease went through it first.
      await runLauncher({ runtimeDirectory, argv: ["claude-finalize-reminder"] }, hook.host);
      expect(hook.stderr.some((line) => line.includes("LEASE_DIRECTORY_UNSAFE"))).toBe(false);
      const mcp = recordingHost();
      await runLauncher({ runtimeDirectory, argv: ["mcp"] }, mcp.host);
      expect(mcp.stdout).toEqual([]);
      expect(mcp.stderr.join("")).toContain("LEASE_DIRECTORY_UNSAFE");
      expect(mcp.stderr[0]).not.toContain(root);
      expect(await fs.readdir(outside)).toEqual([]);
    },
  );

  it("says at most one thing about a lease that cannot be refreshed", async () => {
    let refusals = 0;
    const lease: LeaseHandle = {
      refresh: () => {
        refusals += 1;
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
      remove: () => undefined,
    };
    const recorded = recordingHost(() => lease);
    await runLauncher({ runtimeDirectory, argv: ["serve"] }, recorded.host);
    for (const { tick } of recorded.heartbeats) {
      tick();
      tick();
      tick();
    }
    expect(refusals).toBe(3);
    expect(recorded.stderr).toHaveLength(1);
    expect(recorded.stderr[0]).toContain("EPERM");
    expect(recorded.stdout).toEqual([]);
  });
});

describe("lease cost", () => {
  it("costs well under the hook budget: one create and one remove on the real file system", async () => {
    // Every Agent hook pays this once per run, so it is measured on each CI OS and printed there like `[hook cost]`.
    const coldStart = performance.now();
    createLease(root, "rt-1", "claude-finalize-reminder").remove();
    const coldMs = performance.now() - coldStart;
    const samples: number[] = [];
    for (let run = 0; run < 51; run += 1) {
      const started = performance.now();
      createLease(root, "rt-1", "claude-finalize-reminder").remove();
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const medianMs = samples[25] ?? Number.POSITIVE_INFINITY;
    console.log(
      `[lease cost] ${JSON.stringify({ platform: process.platform, coldMs: Number(coldMs.toFixed(3)), medianMs: Number(medianMs.toFixed(3)) })}`,
    );
    expect(medianMs).toBeLessThan(HOOK_BUDGET_MS);
  });
});
