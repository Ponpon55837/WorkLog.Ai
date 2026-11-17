import { DatabaseInitializationError } from "@work-intelligence/storage";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopChild,
  runDesktopChild,
  type DesktopChildDependencies,
  type DesktopChildHost,
} from "../../apps/server/src/desktop-child.js";
import { StartApiError, type ApiListening, type StartedApi } from "../../apps/server/src/start-api.js";

// The child's decisions with a fake host and fake dependencies: no process, no socket, no SQLite.
// Fictional values only.
const RUN_ID = "synthetic-run-id-0123456789abcdef-child";
const IDENTITY = { realPath: "/synthetic/work.sqlite", fileId: { device: "1", inode: "2" }, lineageId: "b".repeat(64) };
const START = {
  type: "start",
  runId: RUN_ID,
  port: 43_210,
  database: { path: "/synthetic/work.sqlite", identity: IDENTITY },
};

interface Harness {
  child: DesktopChild;
  host: DesktopChildHost;
  sent: Record<string, unknown>[];
  logs: string[];
  exits: number[];
  startApi: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  handlers: { message?: (raw: unknown) => void; disconnect?: () => void; signal?: () => void };
}

function setup(overrides: Partial<DesktopChildDependencies> & { listening?: Promise<ApiListening> } = {}): Harness {
  const sent: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const handlers: Harness["handlers"] = {};
  const host: DesktopChildHost = {
    pid: 777,
    execPath: "/synthetic/node",
    send: (message, done) => {
      sent.push(message as unknown as Record<string, unknown>);
      done();
    },
    onMessage: (listener) => {
      handlers.message = listener;
    },
    onDisconnect: (listener) => {
      handlers.disconnect = listener;
    },
    onSignal: (listener) => {
      handlers.signal = listener;
    },
    exit: (code) => exits.push(code),
    log: (line) => logs.push(line),
  };
  const shutdown = vi.fn(async () => undefined);
  const startApi = vi.fn((): StartedApi => ({
    listening: overrides.listening ?? Promise.resolve({ port: START.port, databaseIdentity: IDENTITY }),
    shutdown,
  }));
  const dependencies: DesktopChildDependencies = {
    preflight: overrides.preflight ?? (async () => ({ status: "ok", identity: IDENTITY, schemaVersion: 33 })),
    probePort: overrides.probePort ?? (async () => ({ free: true })),
    startApi: overrides.startApi ?? (startApi as unknown as DesktopChildDependencies["startApi"]),
  };
  const child = new DesktopChild(host, dependencies);
  child.begin();
  return { child, host, sent, logs, exits, startApi, shutdown, handlers };
}

function failing(error: unknown): Pick<DesktopChildDependencies, "startApi"> {
  const listening = Promise.reject(error);
  listening.catch(() => undefined);
  return { startApi: () => ({ listening, shutdown: async () => undefined }) };
}

describe("DesktopChild", () => {
  it("says hello first, then preflights, starts once and reports ready with the committed identity", async () => {
    const { child, sent, startApi } = setup();

    await child.handle({ type: "preflight", path: "/synthetic/work.sqlite" });
    await child.handle(START);

    expect(sent.map((message) => message.type)).toEqual(["hello", "preflight-result", "ready"]);
    expect(sent[0]).toEqual({ type: "hello", protocolVersion: 1, pid: 777, execPath: "/synthetic/node" });
    expect(sent[1]).toMatchObject({ status: "ok", identity: IDENTITY, schemaVersion: 33 });
    expect(sent[2]).toMatchObject({
      runId: RUN_ID,
      port: START.port,
      pid: 777,
      execPath: "/synthetic/node",
      databaseIdentity: IDENTITY,
    });
    expect(startApi).toHaveBeenCalledWith({
      database: { path: "/synthetic/work.sqlite", identity: IDENTITY },
      port: START.port,
      instanceRunId: RUN_ID,
      onBackupCompleted: expect.any(Function),
      onBackupsChanged: expect.any(Function),
    });
  });

  it("tells the parent when the running API completes a backup", async () => {
    const { child, sent, startApi } = setup();
    await child.handle({ type: "preflight", path: "/synthetic/work.sqlite" });
    await child.handle(START);

    const options = startApi.mock.calls[0]?.[0] as { onBackupCompleted: (at: string) => void };
    options.onBackupCompleted("2026-03-01T12:00:00.000Z");

    expect(sent.at(-1)).toEqual({ type: "backup-completed", at: "2026-03-01T12:00:00.000Z" });
  });

  it("tells the parent when an API call may have changed the backups", async () => {
    const { child, sent, startApi } = setup();
    await child.handle({ type: "preflight", path: "/synthetic/work.sqlite" });
    await child.handle(START);

    const options = startApi.mock.calls[0]?.[0] as { onBackupsChanged: () => void };
    options.onBackupsChanged();

    expect(sent.at(-1)).toEqual({ type: "backups-changed" });
  });

  it("adds the project count to ready when the API reports one, and leaves it out otherwise", async () => {
    const withCount = setup({ listening: Promise.resolve({ port: START.port, projectCount: 5 }) });
    await withCount.child.handle(START);
    expect(withCount.sent[1]).toMatchObject({ type: "ready", projectCount: 5 });

    const without = setup();
    await without.child.handle(START);
    expect(without.sent[1]).toMatchObject({ type: "ready" });
    expect(without.sent[1]).not.toHaveProperty("projectCount");
  });

  it("passes the backup directory and falls back to the requested identity when the API reports none", async () => {
    const { child, sent, startApi } = setup({ listening: Promise.resolve({ port: START.port }) });

    await child.handle({ ...START, backupDirectory: "/synthetic/backups" });

    expect(startApi).toHaveBeenCalledWith(
      expect.objectContaining({ database: expect.objectContaining({ backupDirectory: "/synthetic/backups" }) }),
    );
    expect(sent[1]).toMatchObject({ type: "ready", databaseIdentity: IDENTITY });
  });

  it("forwards every optional preflight field", async () => {
    const sidecars = {
      before: { wal: { exists: false, size: 0 }, shm: { exists: false, size: 0 } },
      after: { wal: { exists: true, size: 4 }, shm: { exists: false, size: 0 } },
    };
    const { child, sent } = setup({
      preflight: async () => ({
        status: "ok",
        identity: IDENTITY,
        schemaVersion: 20,
        compatibility: "older-needs-migration",
        projectCount: 3,
        sidecars,
      }),
    });

    await child.handle({ type: "preflight", path: "/synthetic/work.sqlite" });

    expect(sent[1]).toMatchObject({ compatibility: "older-needs-migration", projectCount: 3, sidecars });
    expect(sent[1]).not.toHaveProperty("detail");
  });

  it.each([
    ["missing", "the database file is missing"],
    ["offline", "the database storage is offline"],
    ["denied", "the database file cannot be read"],
    ["unreadable", "the database file cannot be read"],
    ["unsupported-schema", "the database schema is not supported by this build"],
  ] as const)(
    "replaces the raw %s detail, which may hold a path, with a fixed classification",
    async (status, text) => {
      const rawDetail = "SQLITE_CANTOPEN: unable to open /synthetic/secret/home/work.sqlite";
      const { child, sent } = setup({ preflight: async () => ({ status, detail: rawDetail }) });

      await child.handle({ type: "preflight", path: "/synthetic/work.sqlite" });

      expect(sent[1]).toMatchObject({ status, detail: text });
      expect(JSON.stringify(sent[1])).not.toContain("/synthetic/secret");
    },
  );

  it("answers an unexpected preflight failure as unreadable, with a path-free detail, instead of dying", async () => {
    const { child, sent } = setup({
      preflight: async () => {
        throw new Error("boom at /synthetic/secret/path");
      },
    });

    await child.handle({ type: "preflight", path: "/synthetic/work.sqlite" });

    expect(sent[1]).toEqual({
      type: "preflight-result",
      status: "unreadable",
      detail: "the database file cannot be read",
    });
  });

  it("drops a malformed message and logs only the field names", async () => {
    const { child, sent, logs } = setup();

    await child.handle({ type: "preflight", path: "", token: "hunter2" });
    await child.handle("not an object");

    expect(sent).toHaveLength(1);
    expect(logs).toHaveLength(2);
    expect(logs.join("\n")).not.toContain("hunter2");
  });

  it("ignores a second start and a preflight after the start", async () => {
    const { child, sent, startApi, logs } = setup();

    await child.handle(START);
    await child.handle({ ...START, port: 43_211 });
    await child.handle({ type: "preflight", path: "/synthetic/work.sqlite" });

    expect(startApi).toHaveBeenCalledTimes(1);
    expect(sent.map((message) => message.type)).toEqual(["hello", "ready"]);
    expect(logs).toEqual([
      "[desktop-child] dropped a second start request",
      "[desktop-child] dropped a preflight request: already started",
    ]);
  });

  it("reports PORT_OCCUPIED_BY_OTHER and exits before startApi when the port probe fails", async () => {
    const { child, sent, exits, startApi } = setup({ probePort: async () => ({ free: false, code: "EADDRINUSE" }) });

    await child.handle(START);

    expect(sent[1]).toEqual({ type: "failed", code: "PORT_OCCUPIED_BY_OTHER", detail: "listen failed (EADDRINUSE)" });
    expect(exits).toEqual([1]);
    expect(startApi).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "DB_MISSING"],
    ["offline", "DB_OFFLINE"],
    ["denied", "DB_PERMISSION"],
    ["unreadable", "REPAIR_REQUIRED"],
    ["path-replaced", "DB_IDENTITY_CHANGED"],
    ["file-replaced", "DB_IDENTITY_CHANGED"],
    ["lineage-changed", "DB_IDENTITY_CHANGED"],
  ] as const)("maps the revalidation failure %s to %s", async (reason, code) => {
    const { child, sent, exits } = setup(failing(new StartApiError("revalidation", "d", { revalidation: reason })));

    await child.handle(START);

    expect(sent[1]).toMatchObject({ type: "failed", code });
    expect(exits).toEqual([1]);
  });

  it.each([
    ["DATABASE_SCHEMA_VERSION_TOO_NEW", "SCHEMA_TOO_NEW"],
    ["DATABASE_MIGRATION_BACKUP_FAILED", "SCHEMA_MIGRATION_BLOCKED"],
    ["DATABASE_MIGRATION_FAILED", "SCHEMA_MIGRATION_BLOCKED"],
    ["DATABASE_FILE_MISSING", "DB_MISSING"],
    ["DATABASE_READ_ONLY", "DB_PERMISSION"],
    ["DATABASE_BUSY", "REPAIR_REQUIRED"],
  ] as const)("maps the store error %s to %s", async (storeCode, code) => {
    const storeError = new DatabaseInitializationError(storeCode, "synthetic");
    const { child, sent } = setup(failing(new StartApiError("store-open", "d", { storeError })));

    await child.handle(START);

    expect(sent[1]).toMatchObject({ type: "failed", code });
  });

  it("maps a store failure without a classification, a replaced file, listen codes and unknown errors", async () => {
    const cases: Array<[unknown, string]> = [
      [new StartApiError("store-open", "d"), "REPAIR_REQUIRED"],
      [new StartApiError("file-replaced", "d"), "DB_IDENTITY_CHANGED"],
      [new StartApiError("listen", "d", { listenCode: "EADDRINUSE" }), "PORT_OCCUPIED_BY_OTHER"],
      [new StartApiError("listen", "d", { listenCode: "EACCES" }), "PORT_OCCUPIED_BY_OTHER"],
      [new StartApiError("listen", "d", { listenCode: "EMFILE" }), "REPAIR_REQUIRED"],
      [new StartApiError("listen", "d"), "REPAIR_REQUIRED"],
      [new Error("anything"), "REPAIR_REQUIRED"],
    ];
    for (const [error, code] of cases) {
      const { child, sent } = setup(failing(error));
      await child.handle(START);
      expect(sent[1]).toMatchObject({ type: "failed", code });
    }
  });

  it("never puts a path or a message of the underlying error into the failure detail", async () => {
    const { child, sent } = setup(
      failing(new StartApiError("revalidation", "/synthetic/secret/path.sqlite is gone", { revalidation: "missing" })),
    );

    await child.handle(START);

    expect(JSON.stringify(sent[1])).not.toContain("/synthetic");
  });

  it("shuts down on request: drains the API, tells the parent, then exits 0", async () => {
    const { child, sent, exits, shutdown } = setup();
    await child.handle(START);

    await child.handle({ type: "shutdown" });

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toEqual({ type: "stopped" });
    expect(exits).toEqual([0]);
  });

  it("stops without a started API when shutdown comes first", async () => {
    const { child, sent, exits, shutdown } = setup();

    await child.handle({ type: "shutdown" });

    expect(shutdown).not.toHaveBeenCalled();
    expect(sent.map((message) => message.type)).toEqual(["hello", "stopped"]);
    expect(exits).toEqual([0]);
  });

  it("stops quietly, with no message, when the parent disconnects", async () => {
    const { handlers, sent, exits, child, shutdown } = setup();
    await child.handle(START);

    handlers.disconnect?.();
    await vi.waitFor(() => expect(exits).toEqual([0]));

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(sent.map((message) => message.type)).toEqual(["hello", "ready"]);
  });

  it("stops on a signal and shares one shutdown with a later request", async () => {
    const { handlers, child, exits, shutdown } = setup();
    await child.handle(START);

    handlers.signal?.();
    await child.handle({ type: "shutdown" });

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0, 0].slice(0, exits.length));
    expect(exits.length).toBeGreaterThanOrEqual(1);
  });

  it("lets a start that is waiting for its listener finish before it shuts down", async () => {
    let listen!: (value: ApiListening) => void;
    const listening = new Promise<ApiListening>((resolve) => {
      listen = resolve;
    });
    const { child, sent, shutdown, exits } = setup({ listening });
    const starting = child.handle(START);
    await Promise.resolve();
    const stopping = child.handle({ type: "shutdown" });
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();

    listen({ port: START.port, databaseIdentity: IDENTITY });
    await Promise.all([starting, stopping]);

    expect(sent.map((message) => message.type)).toEqual(["hello", "stopped"]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
  });

  it("exits with the process exit code a failed close left behind", async () => {
    const { child, exits } = setup();
    await child.handle(START);
    const previous = process.exitCode;
    process.exitCode = 1;
    try {
      await child.handle({ type: "shutdown" });
    } finally {
      process.exitCode = previous;
    }

    expect(exits).toEqual([1]);
  });
});

describe("DesktopChild stop and failure races", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("does not call startApi, and ends with stopped, when a shutdown arrives during the port probe", async () => {
    const probe = deferred<{ free: true }>();
    const { child, sent, exits, startApi } = setup({ probePort: () => probe.promise });
    const starting = child.handle(START);
    await Promise.resolve();
    const stopping = child.handle({ type: "shutdown" });
    probe.resolve({ free: true });
    await Promise.all([starting, stopping]);

    expect(startApi).not.toHaveBeenCalled();
    expect(sent.map((message) => message.type)).toEqual(["hello", "stopped"]);
    expect(exits).toEqual([0]);
  });

  it.each([
    ["a parent disconnect", (h: ReturnType<typeof setup>) => h.handlers.disconnect?.()],
    ["a signal", (h: ReturnType<typeof setup>) => h.handlers.signal?.()],
  ])("does not call startApi when %s arrives during the port probe", async (_name, interrupt) => {
    const probe = deferred<{ free: true }>();
    const harness = setup({ probePort: () => probe.promise });
    const starting = harness.child.handle(START);
    await Promise.resolve();
    interrupt(harness);
    probe.resolve({ free: true });
    await starting;
    await vi.waitFor(() => expect(harness.exits).toEqual([0]));

    expect(harness.startApi).not.toHaveBeenCalled();
    expect(harness.sent.map((message) => message.type)).toEqual(["hello"]);
  });

  it("shuts down normally, not with a failed message, when the port turns out to be taken while stopping", async () => {
    const probe = deferred<{ free: false; code: string }>();
    const { child, sent, exits, startApi } = setup({ probePort: () => probe.promise });
    const starting = child.handle(START);
    await Promise.resolve();
    const stopping = child.handle({ type: "shutdown" });
    probe.resolve({ free: false, code: "EADDRINUSE" });
    await Promise.all([starting, stopping]);

    expect(startApi).not.toHaveBeenCalled();
    expect(sent.map((message) => message.type)).toEqual(["hello", "stopped"]);
    expect(exits).toEqual([0]);
  });

  it("reports a failed port probe instead of leaving the start hanging", async () => {
    const { child, sent, exits } = setup({
      probePort: async () => {
        throw new Error("boom");
      },
    });
    await child.handle(START);

    expect(sent[1]).toMatchObject({ type: "failed", code: "REPAIR_REQUIRED" });
    expect(exits).toEqual([1]);
  });

  it("catches a startApi that throws synchronously, reports it and lets a later shutdown finish", async () => {
    const { child, sent, exits } = setup({
      startApi: () => {
        throw new Error("createServer exploded at /synthetic/secret");
      },
    });

    await child.handle(START);
    await child.handle({ type: "shutdown" });

    expect(sent.map((message) => message.type)).toEqual(["hello", "failed"]);
    expect(sent[1]).toEqual({ type: "failed", code: "REPAIR_REQUIRED", detail: "unexpected start failure" });
    expect(exits).toEqual([1]);
  });

  it("maps a setup failure of the API and closes what it had opened", async () => {
    const shutdown = vi.fn(async () => undefined);
    const listening = Promise.reject(new StartApiError("setup", "x"));
    listening.catch(() => undefined);
    const { child, sent } = setup({ startApi: () => ({ listening, shutdown }) });

    await child.handle(START);

    expect(sent[1]).toEqual({ type: "failed", code: "REPAIR_REQUIRED", detail: "the API could not be set up" });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("sends failed, never stopped, and exits exactly once when a listen failure and a shutdown race", async () => {
    let reject!: (error: unknown) => void;
    const listening = new Promise<ApiListening>((_resolve, fail) => {
      reject = fail;
    });
    listening.catch(() => undefined);
    const { child, sent, exits } = setup({ listening });
    const starting = child.handle(START);
    await Promise.resolve();
    const stopping = child.handle({ type: "shutdown" });
    reject(new StartApiError("listen", "x", { listenCode: "EADDRINUSE" }));
    await Promise.all([starting, stopping]);

    expect(sent.map((message) => message.type)).toEqual(["hello", "failed"]);
    expect(exits).toEqual([1]);
  });

  it("does not send stopped after a failed start when shutdown comes later", async () => {
    const { child, sent, exits } = setup(failing(new StartApiError("listen", "x", { listenCode: "EADDRINUSE" })));
    await child.handle(START);
    await child.handle({ type: "shutdown" });

    expect(sent.map((message) => message.type)).toEqual(["hello", "failed"]);
    expect(exits).toEqual([1]);
  });

  it("catches a handler that rejects (a channel that throws) and logs it instead of an unhandled rejection", async () => {
    const harness = setup();
    harness.host.send = () => {
      throw new Error("channel closed");
    };
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);

    harness.handlers.message?.({ type: "preflight", path: "/synthetic/work.sqlite" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(harness.logs).toContain("[desktop-child] a message handler failed");
  });

  it("closes the API only once even when the API's own shutdown rejects", async () => {
    const { child, sent, exits, shutdown } = setup();
    shutdown.mockRejectedValueOnce(new Error("close failed"));
    await child.handle(START);
    await child.handle({ type: "shutdown" });

    expect(sent.at(-1)).toEqual({ type: "stopped" });
    expect(exits).toEqual([0]);
  });
});

describe("runDesktopChild", () => {
  it("returns 2 and explains itself when there is no IPC channel", async () => {
    const send = process.send;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    Object.defineProperty(process, "send", { value: undefined, configurable: true });
    try {
      expect(await runDesktopChild()).toBe(2);
      expect(error.mock.calls[0]?.[0]).toContain("桌面 App");
    } finally {
      Object.defineProperty(process, "send", { value: send, configurable: true });
      error.mockRestore();
    }
  });

  it("starts listening for the parent and returns 0 with an injected host", async () => {
    const { host } = setup();
    const sent: unknown[] = [];
    const quiet: DesktopChildHost = { ...host, send: (message, done) => (sent.push(message), done()) };

    expect(await runDesktopChild(quiet)).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
