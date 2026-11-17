import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKING_DIRECTORY_FAILURE } from "../../packages/desktop-core/src/index.js";
import { IDENTITY, makeHarness, settle, startRequest } from "./backend-helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the child's working directory", () => {
  it("is the fixed directory the shell chose, not the parent's", async () => {
    const harness = makeHarness({ workingDirectory: "/synthetic/app-data/backend-cwd" });
    await harness.supervisor.start(startRequest());
    const options = harness.spawn.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.cwd).toBe("/synthetic/app-data/backend-cwd");
  });

  it("is left to the platform default when none is given", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    expect(harness.spawn.mock.calls[0]?.[2]).not.toHaveProperty("cwd");
  });
});

describe("backup-completed from the child", () => {
  it("reaches every listener and never disturbs the start handshake", async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    const stop = harness.supervisor.onBackupCompleted((at, database) => seen.push(`${at}|${database.realPath}`));
    const started = await harness.supervisor.start(startRequest());
    expect(started.status).toBe("started");

    harness.children[0]?.say({ type: "backup-completed", at: "2026-03-01T12:00:00.000Z" });
    // The report is bound to the identity the preflight verified, so the shell can tell which database it belongs to.
    expect(seen).toEqual([`2026-03-01T12:00:00.000Z|${IDENTITY.realPath}`]);

    stop();
    harness.children[0]?.say({ type: "backup-completed", at: "2026-03-02T12:00:00.000Z" });
    expect(seen).toHaveLength(1);
    expect(harness.supervisor.running).toBeDefined();
  });

  it("ignores a report that arrives before any listener exists and a malformed one", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    harness.children[0]?.say({ type: "backup-completed", at: "2026-03-01T12:00:00.000Z" });
    const seen: string[] = [];
    harness.supervisor.onBackupCompleted((at) => seen.push(at));
    harness.children[0]?.say({ type: "backup-completed", at: "nope" });
    expect(seen).toEqual([]);
  });
});

describe("desktop facts and open-agent-setup", () => {
  it("sends the desktop facts inside start, and nothing when there are none", async () => {
    const legacyService = {
      running: "stopped",
      removeCommand: "synthetic remove",
      fallbackRemoveCommand: "synthetic fb",
    } as const;
    const withFacts = makeHarness();
    await withFacts.supervisor.start(startRequest({ desktop: { legacyService } }));
    expect(withFacts.children[0]?.sent.find((message) => message.type === "start")).toMatchObject({
      desktop: { legacyService },
    });

    const without = makeHarness();
    await without.supervisor.start(startRequest());
    expect(without.children[0]?.sent.find((message) => message.type === "start")).not.toHaveProperty("desktop");
  });

  it("reaches every listener until it unsubscribes, and never disturbs the running backend", async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.supervisor.onOpenAgentSetup(() => {
      throw new Error("first listener broke");
    });
    const stop = harness.supervisor.onOpenAgentSetup(() => seen.push("open"));
    await harness.supervisor.start(startRequest());

    expect(() => harness.children[0]?.say({ type: "open-agent-setup" })).not.toThrow();
    expect(seen).toEqual(["open"]);
    expect(harness.logs.filter((line) => line.includes("a listener failed"))).toHaveLength(1);

    stop();
    harness.children[0]?.say({ type: "open-agent-setup" });
    expect(seen).toEqual(["open"]);
    expect(harness.supervisor.running).toBeDefined();
  });

  it("ignores a request from a preview child and a malformed one", async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.supervisor.onOpenAgentSetup(() => seen.push("open"));
    await harness.supervisor.start(startRequest());
    await harness.supervisor.preview("/synthetic/other/candidate.sqlite");
    harness.children[1]?.say({ type: "open-agent-setup" });
    harness.children[0]?.say({ type: "open-agent-setup", extra: 1 });
    expect(seen).toEqual([]);
  });
});

describe("preview of a candidate database", () => {
  it("asks only hello and preflight, never start, and shuts the child down without a port", async () => {
    const harness = makeHarness();
    const result = await harness.supervisor.preview("/synthetic/other/candidate.sqlite");
    expect(result).toMatchObject({ outcome: "checked", willMigrate: false, preflight: { status: "ok" } });
    const sent = harness.children[0]?.sent.map((message) => message.type);
    expect(sent).toEqual(["preflight", "shutdown"]);
    expect(harness.isPortFree).not.toHaveBeenCalled();
    expect(harness.fetchHealth).not.toHaveBeenCalled();
    expect(harness.children[0]?.exitCode).toBe(0);
    expect(harness.supervisor.running).toBeUndefined();
  });

  it("works while a backend runs, leaves it alone and is not the registered child", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    const result = await harness.supervisor.preview("/synthetic/other/candidate.sqlite");
    expect(result.outcome).toBe("checked");
    expect(harness.children).toHaveLength(2);
    expect(harness.children[0]?.exitCode).toBeNull();
    expect(harness.children[0]?.sent.map((message) => message.type)).not.toContain("shutdown");
    expect(harness.supervisor.running).toBeDefined();
    // A backup report from the preview child is never attributed to the running database.
    const seen: string[] = [];
    harness.supervisor.onBackupCompleted((at) => seen.push(at));
    harness.children[1]?.say({ type: "backup-completed", at: "2026-03-01T12:00:00.000Z" });
    expect(seen).toEqual([]);
  });

  it("reports willMigrate for an empty or older database and not for a current one", async () => {
    for (const [compatibility, expected] of [
      ["empty", true],
      ["older-needs-migration", true],
      ["current", false],
    ] as const) {
      const harness = makeHarness({ scripts: [{ preflight: { compatibility } }] });
      const result = await harness.supervisor.preview("/synthetic/other/candidate.sqlite");
      expect(result).toMatchObject({ outcome: "checked", willMigrate: expected });
    }
  });

  it.each(["missing", "denied", "unsupported-schema"])("passes the preflight verdict %s through", async (status) => {
    const harness = makeHarness({ scripts: [{ preflight: { status } }] });
    const result = await harness.supervisor.preview("/synthetic/other/candidate.sqlite");
    expect(result).toMatchObject({ outcome: "checked", willMigrate: false, preflight: { status } });
  });

  it("answers failed when the child never speaks, and still ends the child", async () => {
    const harness = makeHarness({ scripts: [{ hello: false }], timeouts: { helloMs: 50 } });
    const pending = harness.supervisor.preview("/synthetic/other/candidate.sqlite");
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.outcome).toBe("failed");
    expect(harness.children[0]?.exitCode !== null || harness.children[0]?.signalCode !== null).toBe(true);
  });

  it("previews several databases with one child, in order, and ends it once", async () => {
    const harness = makeHarness();
    const paths = ["/synthetic/a.sqlite", "/synthetic/b.sqlite", "/synthetic/c.sqlite"];
    const results = await harness.supervisor.previewMany(paths);
    expect(results.map((entry) => entry.outcome)).toEqual(["checked", "checked", "checked"]);
    expect(harness.children).toHaveLength(1);
    expect(harness.children[0]?.sent.map((message) => message.type)).toEqual([
      "preflight",
      "preflight",
      "preflight",
      "shutdown",
    ]);
    expect(harness.children[0]?.sent.slice(0, 3).map((message) => (message as { path?: string }).path)).toEqual(paths);
    expect(await harness.supervisor.previewMany([])).toEqual([]);
  });

  it("fails only the paths a silent child had not answered", async () => {
    const harness = makeHarness({ scripts: [{ preflight: false }], timeouts: { preflightMs: 50 } });
    const pending = harness.supervisor.previewMany(["/synthetic/a.sqlite", "/synthetic/b.sqlite"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).map((entry) => entry.outcome)).toEqual(["failed", "failed"]);
  });

  it("fails one path whose ok verdict carries no identity and answers the next", async () => {
    const harness = makeHarness({ scripts: [{ preflight: { identity: undefined } }] });
    const results = await harness.supervisor.previewMany(["/synthetic/a.sqlite", "/synthetic/b.sqlite"]);
    expect(results.map((entry) => entry.outcome)).toEqual(["failed", "failed"]);
    expect(harness.children).toHaveLength(1);
    expect(harness.children[0]?.sent.map((message) => message.type)).toEqual(["preflight", "preflight", "shutdown"]);
  });

  it("serializes previews: the second child is not spawned until the first has ended", async () => {
    const harness = makeHarness();
    const first = harness.supervisor.preview("/synthetic/a.sqlite");
    const second = harness.supervisor.preview("/synthetic/b.sqlite");
    await settle();
    expect(harness.children.length).toBeLessThanOrEqual(2);
    const results = await Promise.all([first, second]);
    expect(results.map((entry) => entry.outcome)).toEqual(["checked", "checked"]);
    expect(harness.children).toHaveLength(2);
    expect(harness.children[0]?.exitCode).toBe(0);
  });

  it("createDatabase asks one preflight with createIfMissing, never start, and answers like a preview", async () => {
    const harness = makeHarness({ scripts: [{ preflight: { compatibility: "current" } }] });
    const result = await harness.supervisor.createDatabase("/synthetic/new/work.sqlite");
    expect(result).toMatchObject({ outcome: "checked", willMigrate: false, preflight: { status: "ok" } });
    expect(harness.children).toHaveLength(1);
    expect(harness.children[0]?.sent).toEqual([
      { type: "preflight", path: "/synthetic/new/work.sqlite", createIfMissing: true },
      { type: "shutdown" },
    ]);
    expect(harness.isPortFree).not.toHaveBeenCalled();
    expect(harness.children[0]?.exitCode).toBe(0);
  });

  it("a plain preview never sends createIfMissing", async () => {
    const harness = makeHarness();
    await harness.supervisor.preview("/synthetic/a.sqlite");
    expect(harness.children[0]?.sent[0]).toEqual({ type: "preflight", path: "/synthetic/a.sqlite" });
  });

  it("createDatabase answers failed on a silent child and is serialized with other previews", async () => {
    const harness = makeHarness({ scripts: [{}, { preflight: false }], timeouts: { preflightMs: 50 } });
    const first = harness.supervisor.preview("/synthetic/a.sqlite");
    const created = harness.supervisor.createDatabase("/synthetic/b.sqlite");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await first).outcome).toBe("checked");
    expect((await created).outcome).toBe("failed");
    expect(harness.children).toHaveLength(2);
    expect(harness.children[0]?.exitCode).toBe(0);
  });

  it("keeps working after a failed preview", async () => {
    const harness = makeHarness({ scripts: [{ preflight: false }, {}], timeouts: { preflightMs: 50 } });
    const failed = harness.supervisor.preview("/synthetic/a.sqlite");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await failed).outcome).toBe("failed");
    expect((await harness.supervisor.preview("/synthetic/b.sqlite")).outcome).toBe("checked");
  });

  it("logs a preview child that cannot be ended, and still answers", async () => {
    const harness = makeHarness({
      scripts: [{ onShutdown: "ignore", onSigterm: "ignore", onSigkill: "ignore" }],
      timeouts: { gracefulMs: 10, terminateMs: 10, killMs: 10 },
    });
    const pending = harness.supervisor.preview("/synthetic/a.sqlite");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).outcome).toBe("checked");
    expect(harness.logs.some((line) => line.includes("preview child did not exit"))).toBe(true);
  });
});

describe("listeners that throw", () => {
  it("never stop the other listeners or escape into the caller, for backups and for exits", async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.supervisor.onBackupCompleted(() => {
      throw new Error("first listener broke");
    });
    harness.supervisor.onBackupCompleted((at) => seen.push(`backup:${at}`));
    harness.supervisor.onBackupsChanged(() => {
      throw new Error("changed listener broke");
    });
    harness.supervisor.onBackupsChanged((database) => seen.push(`changed:${database.realPath}`));
    harness.supervisor.onUnexpectedExit(() => {
      throw new Error("exit listener broke");
    });
    harness.supervisor.onUnexpectedExit((event) => seen.push(`exit:${event.code}`));
    await harness.supervisor.start(startRequest());

    expect(() => harness.children[0]?.say({ type: "backup-completed", at: "2026-03-01T12:00:00.000Z" })).not.toThrow();
    expect(() => harness.children[0]?.say({ type: "backups-changed" })).not.toThrow();
    harness.children[0]?.exit(1);
    await settle();

    expect(seen).toEqual(["backup:2026-03-01T12:00:00.000Z", `changed:${IDENTITY.realPath}`, "exit:CHILD_EXITED"]);
    expect(harness.logs.filter((line) => line.includes("a listener failed"))).toHaveLength(3);
  });

  it("stops delivering backups-changed after the listener unsubscribes", async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    const unsubscribe = harness.supervisor.onBackupsChanged(() => seen.push("changed"));
    await harness.supervisor.start(startRequest());
    unsubscribe();
    harness.children[0]?.say({ type: "backups-changed" });
    expect(seen).toEqual([]);
  });

  it("ignores backups-changed from a preview child (its database is not the one being served)", async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.supervisor.onBackupsChanged(() => seen.push("changed"));
    await harness.supervisor.start(startRequest());
    await harness.supervisor.preview("/synthetic/other/candidate.sqlite");
    harness.children[1]?.say({ type: "backups-changed" });
    expect(seen).toEqual([]);
    harness.children[0]?.say({ type: "backups-changed" });
    expect(seen).toEqual(["changed"]);
  });
});

describe("preview verification and tracking", () => {
  it("treats an ok verdict without an identity as a failed preview (nothing could be confirmed against it)", async () => {
    const harness = makeHarness({ scripts: [{ preflight: { identity: undefined } }] });
    const result = await harness.supervisor.preview("/synthetic/other/candidate.sqlite");
    expect(result).toMatchObject({ outcome: "failed", code: "REPAIR_REQUIRED" });
  });

  it("stop() ends a preview that is in flight, proves it exited, and cancels previews still queued", async () => {
    const harness = makeHarness({ scripts: [{ preflight: false }, {}] });
    const first = harness.supervisor.preview("/synthetic/a.sqlite");
    const queued = harness.supervisor.preview("/synthetic/b.sqlite");
    await settle();
    expect(harness.children).toHaveLength(1);

    const report = await harness.supervisor.stop();
    expect(report.exited).toBe(true);
    expect(harness.children[0]?.sent.map((message) => message.type)).toContain("shutdown");
    expect(harness.children[0]?.exitCode).not.toBeNull();
    expect((await first).outcome).toBe("failed");
    expect(await queued).toMatchObject({ outcome: "failed", code: "REPAIR_REQUIRED" });
    expect(harness.children).toHaveLength(1);
  });

  it("reports exited: false and logs when a preview child cannot be ended", async () => {
    const harness = makeHarness({
      scripts: [{ preflight: false, onShutdown: "ignore", onSigterm: "ignore", onSigkill: "ignore" }],
      timeouts: { gracefulMs: 10, terminateMs: 10, killMs: 10 },
    });
    void harness.supervisor.preview("/synthetic/a.sqlite");
    await settle();
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await stopping).exited).toBe(false);
    expect(harness.logs.some((line) => line.includes("preview child did not exit"))).toBe(true);
  });

  it("a failing preview leaves no unhandled rejection and does not block the next one", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const harness = makeHarness();
    harness.spawn.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    expect((await harness.supervisor.preview("/synthetic/a.sqlite")).outcome).toBe("failed");
    expect((await harness.supervisor.preview("/synthetic/b.sqlite")).outcome).toBe("checked");
    await settle();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("the working directory before every spawn", () => {
  it("is created before a start and before a preview", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      workingDirectory: "/synthetic/app-data/backend-cwd",
      ensureDirectory: async (path) => void order.push(`ensure:${path}`),
    });
    harness.spawn.mockImplementation((() => {
      order.push("spawn");
      throw new Error("stop here");
    }) as never);
    await harness.supervisor.start(startRequest());
    await harness.supervisor.preview("/synthetic/other/candidate.sqlite");
    // Each spawn is preceded by its own creation of the directory.
    expect(order).toEqual([
      "ensure:/synthetic/app-data/backend-cwd",
      "spawn",
      "ensure:/synthetic/app-data/backend-cwd",
      "spawn",
    ]);
  });

  it("fails with its own fixed message, not RUNTIME_MISSING, and spawns nothing when it cannot be created", async () => {
    const harness = makeHarness({
      workingDirectory: "/synthetic/app-data/backend-cwd",
      ensureDirectory: async () => {
        throw new Error("EACCES: /synthetic/app-data/backend-cwd");
      },
    });
    const started = await harness.supervisor.start(startRequest());
    expect(started).toMatchObject({ status: "failed", code: "REPAIR_REQUIRED", detail: WORKING_DIRECTORY_FAILURE });
    expect(JSON.stringify(started)).not.toContain("EACCES");
    expect(harness.planLaunch).not.toHaveBeenCalled();
    expect(harness.spawn).not.toHaveBeenCalled();

    expect(await harness.supervisor.preview("/synthetic/other/candidate.sqlite")).toMatchObject({
      outcome: "failed",
      code: "REPAIR_REQUIRED",
      detail: WORKING_DIRECTORY_FAILURE,
    });
  });

  it("creates nothing when no working directory was chosen", async () => {
    const ensure = vi.fn(async () => undefined);
    const harness = makeHarness({ ensureDirectory: ensure });
    await harness.supervisor.start(startRequest());
    expect(ensure).not.toHaveBeenCalled();
  });
});
