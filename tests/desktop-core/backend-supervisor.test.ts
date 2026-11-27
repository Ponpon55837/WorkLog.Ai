import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackendSupervisor,
  RUNTIME_ERROR_CODES,
  RuntimeError,
  decideRuntimeRecovery,
  isDeterministicFailure,
  isRuntimeReinstallable,
  isSettledRepairFailure,
  type BackendExitEvent,
} from "../../packages/desktop-core/src/index.js";
import { INSTANCE_PROOF_HEADER } from "../../packages/shared/src/instance-proof.js";
import {
  DB_PATH,
  EXECUTABLE,
  genuineHealth,
  IDENTITY,
  makeHarness,
  PORT,
  RUN_ID,
  settle,
  startRequest,
  type ChildScript,
} from "./backend-helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function failedStart(script: ChildScript, request = startRequest()) {
  const harness = makeHarness({ scripts: [script] });
  const result = await harness.supervisor.start(request);
  if (result.status !== "failed") throw new Error(`expected a failure, got ${result.status}`);
  return { harness, result };
}

describe("a successful start", () => {
  it("spawns one child without a shell, with an allowlisted environment, and verifies it end to end", async () => {
    const harness = makeHarness({
      parentEnvironment: {
        HOME: "/synthetic/home",
        PATH: "/synthetic/evil-bin",
        NODE_OPTIONS: "--use-openssl-ca",
        ELECTRON_RUN_AS_NODE: "1",
        WORK_INTELLIGENCE_DB: "/synthetic/elsewhere.sqlite",
      },
    });
    const result = await harness.supervisor.start(startRequest({ backupDirectory: "/synthetic/backups" }));

    expect(result).toMatchObject({
      status: "started",
      info: { runId: RUN_ID, port: PORT, pid: 4242, appVersion: "9.9.9", schemaVersion: 33, execPath: EXECUTABLE },
    });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = harness.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe(EXECUTABLE);
    expect(args.slice(-2)).toEqual(["start", "--desktop-ipc"]);
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    expect(options.env).toEqual({ HOME: "/synthetic/home", PATH: "/usr/bin:/bin" });

    const [preflight, start] = harness.children[0]?.sent ?? [];
    expect(preflight).toEqual({ type: "preflight", path: DB_PATH });
    expect(start).toEqual({
      type: "start",
      runId: RUN_ID,
      port: PORT,
      database: { path: DB_PATH, identity: IDENTITY },
      backupDirectory: "/synthetic/backups",
    });
    expect(harness.supervisor.running).toBe((result as { info: unknown }).info);
  });

  it("asks HTTP readiness for the proof of a fresh challenge on the chosen port", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());

    const [url, headers] = harness.fetchHealth.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(url).toBe(`http://127.0.0.1:${PORT}/api/health`);
    expect(Object.keys(headers)).toEqual(["x-work-intelligence-challenge"]);
  });

  it("passes the runtime's own environment additions through the launch plan, not the parent's", async () => {
    const harness = makeHarness({ parentEnvironment: { HOME: "/synthetic/home", NODE_PATH: "/synthetic/modules" } });
    await harness.supervisor.start(startRequest({ environment: { WORK_INTELLIGENCE_BACKUP: "off" } }));

    expect(harness.planLaunch).toHaveBeenCalledWith(["--desktop-ipc"], {
      HOME: "/synthetic/home",
      PATH: "/usr/bin:/bin",
      WORK_INTELLIGENCE_BACKUP: "off",
    });
  });

  it("keeps the last output lines and masks the run id in them", async () => {
    const harness = makeHarness();
    const started = harness.supervisor.start(startRequest());
    await settle();
    harness.children[0]?.stderr.write(`listening for ${RUN_ID}\npartial`);
    harness.children[0]?.stderr.write(" line\n");
    await started;

    expect(harness.supervisor.recentOutput).toEqual(["listening for [redacted]", "partial line"]);
  });

  it("returns the same promise to concurrent callers and never spawns a second child", async () => {
    const harness = makeHarness();
    const first = harness.supervisor.start(startRequest());
    const second = harness.supervisor.start(startRequest());

    expect(second).toBe(first);
    await first;
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it("carries the project count of the ready message into the backend info, and omits it when absent", async () => {
    const counted = makeHarness({ scripts: [{ ready: { projectCount: 7 } }] });
    const withCount = await counted.supervisor.start(startRequest());
    expect((withCount as { info: { projectCount?: number } }).info.projectCount).toBe(7);

    const plain = makeHarness();
    const without = await plain.supervisor.start(startRequest());
    expect((without as { info: object }).info).not.toHaveProperty("projectCount");
  });

  it("answers already-running for a later start and leaves the child alone", async () => {
    const harness = makeHarness();
    const first = await harness.supervisor.start(startRequest());
    const again = await harness.supervisor.start(startRequest());

    expect(again.status).toBe("already-running");
    expect((again as { info: unknown }).info).toBe((first as { info: unknown }).info);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.children[0]?.sent.filter((message) => message.type === "start")).toHaveLength(1);
  });

  it("accepts a hello and ready executable that differ only by an 8.3 short name on Windows", async () => {
    const harness = makeHarness({
      platform: "win32",
      parentEnvironment: { SYSTEMROOT: "C:\\Windows" },
      scripts: [
        {
          hello: { execPath: "C:\\Users\\RUNNER~1\\runtime\\NODE.EXE" },
          ready: { execPath: "C:\\Users\\RUNNER~1\\runtime\\NODE.EXE" },
        },
      ],
      realpath: (path) => (path.includes("RUNNER~1") ? EXECUTABLE.toUpperCase() : path),
    });
    // The plan names the long path; the real path of the 8.3 name resolves to the same file (case differs on win32).
    harness.planLaunch.mockImplementationOnce(async (argv: readonly string[]) => ({
      command: EXECUTABLE,
      args: ["app.mjs", ...argv],
      env: {},
    }));

    expect((await harness.supervisor.start(startRequest())).status).toBe("started");
  });
});

describe("failures before the child exists", () => {
  it("does not spawn when the port is already in use", async () => {
    const harness = makeHarness({ isPortFree: async () => false });
    const result = await harness.supervisor.start(startRequest());

    expect(result).toMatchObject({ status: "failed", code: "PORT_OCCUPIED_BY_OTHER" });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it.each([0, 65_536, 1.5, Number.NaN, -1])("refuses the invalid port %s", async (port) => {
    const harness = makeHarness();
    const result = await harness.supervisor.start(startRequest({ port }));

    expect(result).toMatchObject({ status: "failed", code: "REPAIR_REQUIRED" });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it.each(RUNTIME_ERROR_CODES)("keeps the runtime's own refusal code %s when the launch plan fails", async (code) => {
    const harness = makeHarness();
    harness.planLaunch.mockRejectedValueOnce(new RuntimeError(code, "refused"));
    const result = await harness.supervisor.start(startRequest());

    expect(result).toMatchObject({ status: "failed", code });
    expect((result as { detail: string }).detail).toBe(`the runtime was refused (${code})`);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it.each(["RUNTIME_UNSAFE_PERMISSIONS", "RUNTIME_ACL_UNREADABLE"] as const)(
    "surfaces %s as the true reason: no automatic retry and no reinstall",
    async (code) => {
      const harness = makeHarness();
      harness.planLaunch.mockRejectedValueOnce(new RuntimeError(code, "refused"));
      const result = await harness.supervisor.start(startRequest());
      const failed = result as { code: string };

      expect(failed.code).toBe(code);
      expect(isDeterministicFailure(failed.code)).toBe(true);
      expect(isRuntimeReinstallable(failed.code)).toBe(false);
      expect(decideRuntimeRecovery({ canReinstall: true, failureCode: failed.code, alreadyAttempted: false })).toBe(
        "none",
      );
      expect(isSettledRepairFailure(failed.code)).toBe(true);
    },
  );

  it("treats a content refusal as reinstallable, so it is not settled yet", () => {
    expect(isRuntimeReinstallable("RUNTIME_FILE_TAMPERED")).toBe(true);
    expect(isSettledRepairFailure("RUNTIME_FILE_TAMPERED")).toBe(false);
    expect(isSettledRepairFailure("RUNTIME_MISSING")).toBe(false);
    expect(isSettledRepairFailure("CHILD_EXITED")).toBe(false);
  });

  it("reports RUNTIME_MISSING when the launch plan fails for a reason that is not a runtime refusal", async () => {
    const harness = makeHarness();
    harness.planLaunch.mockRejectedValueOnce(new Error("disk unplugged"));
    const result = await harness.supervisor.start(startRequest());

    expect(result).toMatchObject({
      status: "failed",
      code: "RUNTIME_MISSING",
      detail: "the runtime could not be verified",
    });
  });

  it("reports RUNTIME_MISSING when the executable cannot be spawned", async () => {
    const harness = makeHarness({ scripts: [{ hello: false }] });
    const started = harness.supervisor.start(startRequest());
    await settle();
    if (harness.children[0]) harness.children[0].pid = undefined;
    harness.children[0]?.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
    const result = await started;

    expect(result).toMatchObject({ status: "failed", code: "RUNTIME_MISSING" });
    expect((result as { detail: string }).detail).toContain("ENOENT");
  });

  it("reports RUNTIME_MISSING for a spawn error without an errno code", async () => {
    const harness = makeHarness({ scripts: [{ hello: false }] });
    const started = harness.supervisor.start(startRequest());
    await settle();
    if (harness.children[0]) harness.children[0].pid = undefined;
    harness.children[0]?.emit("error", new Error("spawn failed"));

    expect(await started).toMatchObject({ status: "failed", code: "RUNTIME_MISSING" });
  });
});

describe("a child 'error' event that is not a spawn failure", () => {
  it("does not mean the child exited: it stays running and is stopped by its own exit", async () => {
    const harness = makeHarness();
    const events: BackendExitEvent[] = [];
    harness.supervisor.onUnexpectedExit((event) => events.push(event));
    await harness.supervisor.start(startRequest());

    // kill() or send() failed on a live process: Node emits 'error' but the process runs on.
    harness.children[0]?.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
    await settle();

    expect(events).toEqual([]);
    expect(harness.supervisor.running).toBeDefined();
    expect(harness.logs.some((line) => line.includes("has not exited"))).toBe(true);
    expect(await harness.supervisor.stop()).toMatchObject({ graceful: true, exited: true });
  });

  it("reports exited false when the kill itself fails and no exit event follows", async () => {
    const harness = makeHarness({ scripts: [{ onShutdown: "ignore", onSigterm: "ignore" }] });
    await harness.supervisor.start(startRequest());
    const child = harness.children[0];
    if (!child) throw new Error("no child");
    child.kill = (signal) => {
      child.kills.push(signal);
      child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
      throw new Error("kill EPERM");
    };
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    const report = await stopping;

    expect(report).toMatchObject({ exited: false, forced: true, portReleased: false, wasRunning: true });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("the hello step", () => {
  it("times out when the child never says hello, then escalates the stop", async () => {
    const harness = makeHarness({ scripts: [{ hello: false, onShutdown: "ignore", onSigterm: "ignore" }] });
    const started = harness.supervisor.start(startRequest());
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await started;

    expect(result).toMatchObject({ status: "failed", code: "CHILD_START_TIMEOUT" });
    expect(harness.children[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect((result as { stopped: unknown }).stopped).toMatchObject({ forced: true, exited: true, wasRunning: true });
  });

  it("refuses a child that speaks another protocol version and stops it", async () => {
    const { harness, result } = await failedStart({ hello: { protocolVersion: 2 } });

    expect(result.code).toBe("REPAIR_REQUIRED");
    expect(result.detail).toContain("protocol version 2");
    expect(harness.children[0]?.sent.map((message) => message.type)).toEqual(["shutdown"]);
    expect(result.stopped).toMatchObject({ graceful: true, exited: true });
  });

  it("refuses a hello from a process id that is not the spawned child", async () => {
    const { result } = await failedStart({ hello: { pid: 999_999 } });
    expect(result).toMatchObject({ code: "SERVICE_IDENTITY_MISMATCH" });
  });

  it("refuses a hello from a different executable than the one planned", async () => {
    const { result } = await failedStart({ hello: { execPath: "/synthetic/another/node" } });
    expect(result).toMatchObject({ code: "SERVICE_IDENTITY_MISMATCH" });
  });

  it("compares the raw paths when the real path cannot be read", async () => {
    const harness = makeHarness({
      realpath: () => {
        throw new Error("gone");
      },
    });
    expect((await harness.supervisor.start(startRequest())).status).toBe("started");
  });

  it("drops a malformed child message, logs it and carries on", async () => {
    const harness = makeHarness({ scripts: [{ hello: false }] });
    const started = harness.supervisor.start(startRequest());
    await settle();
    harness.children[0]?.say({ type: "reboot-the-machine" });
    harness.children[0]?.say(harness.children[0].helloMessage());
    const result = await started;

    expect(result.status).toBe("started");
    expect(harness.logs.some((line) => line.includes("dropped a child message"))).toBe(true);
  });
});

describe("without a log sink", () => {
  it("runs silently and still drops a malformed child message", async () => {
    const harness = makeHarness({ scripts: [{ hello: false }] });
    const supervisor = new BackendSupervisor({ dependencies: harness.deps });
    const started = supervisor.start(startRequest());
    await settle();
    harness.children[0]?.say({ type: "reboot-the-machine" });
    harness.children[0]?.say(harness.children[0].helloMessage());

    expect((await started).status).toBe("started");
  });
});

describe("the database preflight", () => {
  it.each([
    ["missing", {}, "DB_MISSING"],
    ["offline", {}, "DB_OFFLINE"],
    ["denied", {}, "DB_PERMISSION"],
    ["unreadable", {}, "REPAIR_REQUIRED"],
    ["unsupported-schema", { compatibility: "newer-unsupported" }, "SCHEMA_TOO_NEW"],
    ["unsupported-schema", { detail: "not-work-intelligence" }, "REPAIR_REQUIRED"],
  ])("maps a %s preflight (%j) to %s and never sends start", async (status, extra, code) => {
    const { harness, result } = await failedStart({ preflight: { status, ...extra } });

    expect(result.code).toBe(code);
    expect(harness.children[0]?.sent.map((message) => message.type)).toEqual(["preflight", "shutdown"]);
  });

  it("refuses an ok preflight that carries no identity", async () => {
    const { result } = await failedStart({ preflight: { identity: undefined } });
    expect(result).toMatchObject({ code: "REPAIR_REQUIRED", detail: "the preflight returned no database identity" });
  });

  it("times out when the preflight never answers", async () => {
    const harness = makeHarness({ scripts: [{ preflight: false }] });
    const started = harness.supervisor.start(startRequest());
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await started).toMatchObject({ status: "failed", code: "CHILD_START_TIMEOUT" });
  });

  it("accepts the identity the caller confirmed", async () => {
    const harness = makeHarness();
    const result = await harness.supervisor.start(startRequest({ expectedIdentity: IDENTITY }));
    expect(result.status).toBe("started");
  });

  it("refuses a database that is not the confirmed one", async () => {
    const swapped = { ...IDENTITY, fileId: { device: "10", inode: "999" } };
    const harness = makeHarness({ scripts: [{ preflight: { identity: swapped } }] });
    const result = await harness.supervisor.start(startRequest({ expectedIdentity: IDENTITY }));

    expect(result).toMatchObject({ status: "failed", code: "DB_IDENTITY_CHANGED" });
    expect((result as { detail: string }).detail).toContain("file-replaced");
    expect(harness.children[0]?.sent.some((message) => message.type === "start")).toBe(false);
  });
});

describe("schema migration consent", () => {
  it.each(["older-needs-migration", "empty"])(
    "blocks a %s database that the user has not approved",
    async (compatibility) => {
      const beforeStart = vi.fn(async () => undefined);
      const { harness, result } = await failedStart({ preflight: { compatibility } }, startRequest({ beforeStart }));

      expect(result.code).toBe("SCHEMA_MIGRATION_BLOCKED");
      expect(beforeStart).not.toHaveBeenCalled();
      expect(harness.children[0]?.sent.some((message) => message.type === "start")).toBe(false);
    },
  );

  it("calls beforeStart with willMigrate before start is sent when migration is approved", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      scripts: [{ preflight: { compatibility: "older-needs-migration", schemaVersion: 20 } }],
    });
    const result = await harness.supervisor.start(
      startRequest({
        allowSchemaMigration: true,
        beforeStart: async (summary) => {
          order.push(`before:${summary.willMigrate}:${summary.schemaVersion}`);
          expect(harness.children[0]?.sent.some((message) => message.type === "start")).toBe(false);
        },
      }),
    );

    expect(result.status).toBe("started");
    expect(order).toEqual(["before:true:20"]);
  });

  it("reports willMigrate false for a current database", async () => {
    const beforeStart = vi.fn(async () => undefined);
    await makeHarness().supervisor.start(startRequest({ beforeStart }));

    expect(beforeStart).toHaveBeenCalledWith({ identity: IDENTITY, schemaVersion: 33, willMigrate: false });
  });

  it("fails, and stops the child, when beforeStart throws", async () => {
    const { harness, result } = await failedStart(
      {},
      startRequest({
        beforeStart: async () => {
          throw new Error("journal write failed");
        },
      }),
    );

    expect(result).toMatchObject({ code: "REPAIR_REQUIRED" });
    expect(harness.children[0]?.sent.some((message) => message.type === "start")).toBe(false);
    expect(harness.children[0]?.exitCode).toBe(0);
  });
});

describe("the ready step", () => {
  it.each([
    ["another run id", { runId: "another-run-id-0123456789abcdef-another" }],
    ["another port", { port: PORT + 1 }],
    ["another process id", { pid: 31_337 }],
    ["another executable", { execPath: "/synthetic/another/node" }],
  ])("refuses a ready message with %s", async (_name, change) => {
    const { result } = await failedStart({ ready: change });
    expect(result).toMatchObject({ code: "SERVICE_IDENTITY_MISMATCH" });
  });

  it("refuses a ready message with another protocol version", async () => {
    const { result } = await failedStart({ ready: { protocolVersion: 3 } });
    expect(result).toMatchObject({ code: "REPAIR_REQUIRED" });
  });

  it("refuses a child that opened another database", async () => {
    const { result } = await failedStart({
      ready: { databaseIdentity: { ...IDENTITY, fileId: { device: "1", inode: "2" } } },
    });
    expect(result).toMatchObject({ code: "DB_IDENTITY_CHANGED" });
  });

  it("accepts a lineage that appeared in the same file (the first migration wrote schema_migrations)", async () => {
    const before = { ...IDENTITY, lineageId: null };
    const harness = makeHarness({
      scripts: [{ preflight: { identity: before }, ready: { databaseIdentity: IDENTITY } }],
    });

    expect((await harness.supervisor.start(startRequest())).status).toBe("started");
  });

  it("passes the child's own failure code through and stops it", async () => {
    const harness = makeHarness({ scripts: [{ ready: false }] });
    const started = harness.supervisor.start(startRequest());
    await vi.waitFor(() => expect(harness.children[0]?.sent.some((message) => message.type === "start")).toBe(true));
    harness.children[0]?.say({ type: "failed", code: "PORT_OCCUPIED_BY_OTHER", detail: "listen failed (EADDRINUSE)" });
    const result = await started;

    expect(result).toMatchObject({
      status: "failed",
      code: "PORT_OCCUPIED_BY_OTHER",
      detail: "listen failed (EADDRINUSE)",
    });
    expect((result as { stopped: unknown }).stopped).toMatchObject({ exited: true, portReleased: true });
  });

  it("reports CHILD_EXITED when the child dies before ready", async () => {
    const harness = makeHarness({ scripts: [{ ready: false }] });
    const started = harness.supervisor.start(startRequest());
    await vi.waitFor(() => expect(harness.children[0]?.sent.some((message) => message.type === "start")).toBe(true));
    harness.children[0]?.exit(1);
    const result = await started;

    expect(result).toMatchObject({ status: "failed", code: "CHILD_EXITED", detail: "the backend exited with code 1" });
  });

  it("reports the signal when the child was killed before ready", async () => {
    const harness = makeHarness({ scripts: [{ ready: false }] });
    const started = harness.supervisor.start(startRequest());
    await vi.waitFor(() => expect(harness.children[0]?.sent.some((message) => message.type === "start")).toBe(true));
    harness.children[0]?.exit(null, "SIGSEGV");

    expect(await started).toMatchObject({ code: "CHILD_EXITED", detail: "the backend was ended by SIGSEGV" });
  });

  it("times out when ready never arrives", async () => {
    const harness = makeHarness({ scripts: [{ ready: false }] });
    const started = harness.supervisor.start(startRequest());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await started).toMatchObject({ status: "failed", code: "CHILD_START_TIMEOUT" });
  });
});

describe("the identity that ready reports after the store opened", () => {
  const EMPTY_FILE = { ...IDENTITY, lineageId: null };
  const migrating = { allowSchemaMigration: true };

  it("accepts the new lineage of an empty file and keeps the re-read identity", async () => {
    const harness = makeHarness({
      scripts: [{ preflight: { identity: EMPTY_FILE, compatibility: "empty" }, ready: { databaseIdentity: IDENTITY } }],
    });
    const result = await harness.supervisor.start(startRequest(migrating));

    expect(result.status).toBe("started");
    if (result.status === "started") expect(result.info.databaseIdentity).toEqual(IDENTITY);
  });

  it("refuses a different lineage when the preflight already had one", async () => {
    const harness = makeHarness({
      scripts: [{ ready: { databaseIdentity: { ...IDENTITY, lineageId: "b".repeat(64) } } }],
    });

    expect(await harness.supervisor.start(startRequest())).toMatchObject({
      status: "failed",
      code: "DB_IDENTITY_CHANGED",
    });
  });

  it("refuses a lineage that vanished", async () => {
    const harness = makeHarness({ scripts: [{ ready: { databaseIdentity: EMPTY_FILE } }] });

    expect(await harness.supervisor.start(startRequest())).toMatchObject({ code: "DB_IDENTITY_CHANGED" });
  });

  it.each([
    ["another file id", { ...IDENTITY, fileId: { device: "10", inode: "999" } }],
    ["another real path", { ...IDENTITY, realPath: "/synthetic/data/other.sqlite", fileId: null }],
  ])("refuses an empty file that turned into %s", async (_name, readyIdentity) => {
    const harness = makeHarness({
      scripts: [
        { preflight: { identity: EMPTY_FILE, compatibility: "empty" }, ready: { databaseIdentity: readyIdentity } },
      ],
    });

    expect(await harness.supervisor.start(startRequest(migrating))).toMatchObject({
      status: "failed",
      code: "DB_IDENTITY_CHANGED",
    });
  });
});

describe("HTTP readiness when the child ends", () => {
  it("reports CHILD_EXITED, not a timeout, when the child exits during the health request", async () => {
    const harness = makeHarness({
      health: async () => {
        harness.children[0]?.exit(1);
        throw new Error("connection refused");
      },
    });

    expect(await harness.supervisor.start(startRequest())).toMatchObject({ status: "failed", code: "CHILD_EXITED" });
    expect(harness.fetchHealth).toHaveBeenCalledTimes(1);
  });

  it("uses the code of the failed message the child sent before it ended", async () => {
    const harness = makeHarness({
      scripts: [
        {
          afterReady: { exit: 1, failed: { code: "SCHEMA_MIGRATION_BLOCKED", detail: "the schema migration failed" } },
        },
      ],
    });

    expect(await harness.supervisor.start(startRequest())).toMatchObject({
      status: "failed",
      code: "SCHEMA_MIGRATION_BLOCKED",
    });
    expect(harness.fetchHealth).not.toHaveBeenCalled();
  });

  it("does not ask a child that already ended for a proof", async () => {
    const harness = makeHarness({ scripts: [{ afterReady: { exit: 1 } }] });

    expect(await harness.supervisor.start(startRequest())).toMatchObject({ status: "failed", code: "CHILD_EXITED" });
    expect(harness.fetchHealth).not.toHaveBeenCalled();
  });
});

describe("HTTP readiness", () => {
  it("refuses a port that answers without the proof (another program on the port) and stops the child", async () => {
    const harness = makeHarness({ health: async () => ({ status: 200, header: () => undefined }) });
    const result = await harness.supervisor.start(startRequest());

    expect(result).toMatchObject({ status: "failed", code: "SERVICE_IDENTITY_MISMATCH" });
    expect(harness.children[0]?.exitCode).toBe(0);
    expect(harness.supervisor.running).toBeUndefined();
  });

  it("refuses a proof made with another run id", async () => {
    const harness = makeHarness({
      health: async (_url, headers) => genuineHealth("another-run-id-0123456789abcdef-x", headers),
    });
    expect(await harness.supervisor.start(startRequest())).toMatchObject({ code: "SERVICE_IDENTITY_MISMATCH" });
  });

  it("refuses a malformed proof header", async () => {
    const harness = makeHarness({
      health: async () => ({
        status: 200,
        header: (name) => (name === INSTANCE_PROOF_HEADER ? "not-a-proof" : undefined),
      }),
    });
    expect(await harness.supervisor.start(startRequest())).toMatchObject({ code: "SERVICE_IDENTITY_MISMATCH" });
  });

  it("asks for repair when the proven backend reports an unhealthy database", async () => {
    const harness = makeHarness({ health: async (_url, headers, runId) => genuineHealth(runId, headers, 503) });
    expect(await harness.supervisor.start(startRequest())).toMatchObject({
      code: "REPAIR_REQUIRED",
      detail: "the health endpoint answered 503",
    });
  });

  it("retries a connection error and succeeds on the next attempt", async () => {
    let calls = 0;
    const harness = makeHarness({
      health: async (_url, headers, runId) => {
        calls += 1;
        if (calls < 3) throw new Error("ECONNREFUSED");
        return genuineHealth(runId, headers);
      },
    });
    const started = harness.supervisor.start(startRequest());
    await vi.advanceTimersByTimeAsync(300);

    expect((await started).status).toBe("started");
    expect(calls).toBe(3);
  });

  it("gives up after three connection errors", async () => {
    const harness = makeHarness({
      health: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const started = harness.supervisor.start(startRequest());
    await vi.advanceTimersByTimeAsync(300);

    expect(await started).toMatchObject({ status: "failed", code: "CHILD_START_TIMEOUT" });
    expect(harness.fetchHealth).toHaveBeenCalledTimes(3);
  });
});

describe("stop", () => {
  it("is graceful when the child exits on the IPC shutdown, and waits for the port", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    let polls = 0;
    harness.isPortFree.mockImplementation(async () => (polls += 1) >= 3);
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(500);

    expect(await stopping).toEqual({
      graceful: true,
      forced: false,
      exitCode: 0,
      signal: null,
      exited: true,
      portReleased: true,
      wasRunning: true,
    });
    expect(harness.children[0]?.kills).toEqual([]);
    expect(polls).toBe(3);
    expect(harness.supervisor.running).toBeUndefined();
  });

  it("escalates to SIGTERM on POSIX when the IPC shutdown is ignored", async () => {
    const harness = makeHarness({ scripts: [{ onShutdown: "ignore", onSigterm: { exit: 0 } }] });
    await harness.supervisor.start(startRequest());
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await stopping;

    expect(harness.children[0]?.kills).toEqual(["SIGTERM"]);
    expect(report).toMatchObject({ graceful: false, forced: false, exitCode: 0, exited: true });
  });

  it("kills with SIGKILL as the last resort on POSIX", async () => {
    const harness = makeHarness({ scripts: [{ onShutdown: "ignore", onSigterm: "ignore" }] });
    await harness.supervisor.start(startRequest());
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(13_000);
    const report = await stopping;

    expect(harness.children[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(report).toMatchObject({ graceful: false, forced: true, signal: "SIGKILL", exited: true });
  });

  it("never sends SIGTERM on Windows: the escalation after the IPC shutdown is one kill()", async () => {
    const harness = makeHarness({ platform: "win32", scripts: [{ onShutdown: "ignore" }] });
    await harness.supervisor.start(startRequest());
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await stopping;

    expect(harness.children[0]?.kills).toEqual([undefined]);
    expect(report).toMatchObject({ graceful: false, forced: true, exitCode: 1, exited: true });
  });

  it("ends the whole process tree before the Windows kill, so the import worker is not left running", async () => {
    const harness = makeHarness({ platform: "win32", scripts: [{ onShutdown: "ignore" }] });
    await harness.supervisor.start(startRequest());
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;

    expect(harness.killTree).toHaveBeenCalledExactlyOnceWith(harness.children[0]?.pid);
  });

  it("waits for the tree kill to finish before the plain Windows kill, so the root is still there to walk from", async () => {
    let finishTree: () => void = () => undefined;
    const events: string[] = [];
    const harness = makeHarness({
      platform: "win32",
      scripts: [{ onShutdown: "ignore" }],
      killTree: () => {
        events.push("tree-start");
        return new Promise<void>((resolve) => {
          finishTree = () => {
            events.push("tree-done");
            resolve();
          };
        });
      },
    });
    await harness.supervisor.start(startRequest());
    const child = harness.children[0];
    const originalKill = child?.kill.bind(child);
    if (child) child.kill = ((signal?: NodeJS.Signals) => (events.push("kill"), originalKill?.(signal))) as never;
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual(["tree-start"]);
    finishTree();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    expect(events).toEqual(["tree-start", "tree-done", "kill"]);
  });

  it("never ends a process tree on POSIX, and not after a graceful stop on Windows", async () => {
    const posix = makeHarness({ scripts: [{ onShutdown: "ignore", onSigterm: "ignore" }] });
    await posix.supervisor.start(startRequest());
    const stoppingPosix = posix.supervisor.stop();
    await vi.advanceTimersByTimeAsync(13_000);
    await stoppingPosix;
    expect(posix.killTree).not.toHaveBeenCalled();

    const windows = makeHarness({ platform: "win32" });
    await windows.supervisor.start(startRequest());
    const stoppingWindows = windows.supervisor.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stoppingWindows;
    expect(windows.killTree).not.toHaveBeenCalled();
  });

  it("does not claim the child exited when no exit event arrives after the final kill", async () => {
    const harness = makeHarness({ scripts: [{ onShutdown: "ignore", onSigterm: "ignore", onSigkill: "ignore" }] });
    await harness.supervisor.start(startRequest());
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(16_000);
    const report = await stopping;

    expect(report).toMatchObject({ exited: false, forced: true, portReleased: false, exitCode: null });
  });

  it("reports portReleased false when the port stays in use after the child exited", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    harness.isPortFree.mockImplementation(async () => false);
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(6_000);
    const report = await stopping;

    expect(report).toMatchObject({ graceful: true, exited: true, portReleased: false });
  });

  it("shares one stop between callers and reports nothing to stop afterwards", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    const first = harness.supervisor.stop();
    const second = harness.supervisor.stop();

    expect(second).toBe(first);
    await first;
    expect(await harness.supervisor.stop()).toMatchObject({ wasRunning: false, graceful: true });
    expect(harness.children[0]?.sent.filter((message) => message.type === "shutdown")).toHaveLength(1);
  });

  it("copes with a channel that is already closed when the shutdown is sent", async () => {
    const harness = makeHarness({ scripts: [{ onShutdown: "ignore", onSigterm: { exit: 0 } }] });
    await harness.supervisor.start(startRequest());
    const child = harness.children[0];
    if (!child) throw new Error("no child");
    child.send = () => {
      throw new Error("ERR_IPC_CHANNEL_CLOSED");
    };
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await stopping).toMatchObject({ exited: true });
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("copes with a send callback that reports an error", async () => {
    const harness = makeHarness({ scripts: [{ onSigterm: { exit: 0 }, onShutdown: "ignore" }] });
    await harness.supervisor.start(startRequest());
    const child = harness.children[0];
    if (!child) throw new Error("no child");
    child.send = (_message, callback) => {
      callback?.(new Error("closed"));
      return false;
    };
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await stopping).toMatchObject({ exited: true });
  });

  it("only touches the child it spawned, through its handle, with no process-id based kill", async () => {
    const harness = makeHarness({ scripts: [{ onShutdown: "ignore", onSigterm: "ignore" }] });
    const killSpy = vi.spyOn(process, "kill");
    await harness.supervisor.start(startRequest());
    const stopping = harness.supervisor.stop();
    await vi.advanceTimersByTimeAsync(13_000);
    await stopping;

    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("waits for a start that is still before its spawn, then stops what it produced", async () => {
    const harness = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.isPortFree.mockImplementationOnce(async () => {
      await gate;
      return true;
    });
    const starting = harness.supervisor.start(startRequest());
    const stopping = harness.supervisor.stop();
    release();

    expect((await starting).status).toBe("started");
    expect(await stopping).toMatchObject({ wasRunning: true, exited: true });
    expect(harness.supervisor.running).toBeUndefined();
  });

  it("ends a start in progress by stopping its child", async () => {
    const harness = makeHarness({ scripts: [{ preflight: false }] });
    const starting = harness.supervisor.start(startRequest());
    await settle();
    const stopping = harness.supervisor.stop();

    expect(await starting).toMatchObject({ status: "failed", code: "CHILD_EXITED" });
    expect(await stopping).toMatchObject({ exited: true });
  });

  it("lets a start that arrives during a stop wait for it and then spawn a fresh child", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    const stopping = harness.supervisor.stop();
    const restarted = harness.supervisor.start(startRequest());
    await stopping;
    const result = await restarted;

    expect(result.status).toBe("started");
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.children[0]?.exitCode).toBe(0);
  });
});

describe("an unexpected exit", () => {
  it("is reported once with the code, the recent output and the old info, and nothing restarts", async () => {
    const harness = makeHarness();
    const events: BackendExitEvent[] = [];
    harness.supervisor.onUnexpectedExit((event) => events.push(event));
    const started = await harness.supervisor.start(startRequest());
    harness.children[0]?.stderr.write("fatal: out of memory\n");
    harness.children[0]?.exit(134);
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: "CHILD_EXITED",
      exitCode: 134,
      signal: null,
      recentOutput: ["fatal: out of memory"],
    });
    expect(events[0]?.info).toBe((started as { info: unknown }).info);
    expect(harness.supervisor.running).toBeUndefined();
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it("carries the last error code the child reported before it exited", async () => {
    const harness = makeHarness();
    const events: BackendExitEvent[] = [];
    harness.supervisor.onUnexpectedExit((event) => events.push(event));
    await harness.supervisor.start(startRequest());
    harness.children[0]?.say({ type: "failed", code: "DB_OFFLINE", detail: "the database storage is offline" });
    harness.children[0]?.exit(1);
    await settle();

    expect(events[0]).toMatchObject({ code: "DB_OFFLINE", detail: "the database storage is offline" });
  });

  it("is not reported after unsubscribe, nor when the exit is a requested stop", async () => {
    const harness = makeHarness();
    const listener = vi.fn();
    const unsubscribe = harness.supervisor.onUnexpectedExit(listener);
    await harness.supervisor.start(startRequest());
    await harness.supervisor.stop();
    await settle();
    expect(listener).not.toHaveBeenCalled();

    await harness.supervisor.start(startRequest());
    unsubscribe();
    harness.children[1]?.exit(1);
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });

  it("lets the next start spawn a new child after a crash", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    harness.children[0]?.exit(1);
    await settle();
    const again = await harness.supervisor.start(startRequest());

    expect(again.status).toBe("started");
    expect(harness.spawn).toHaveBeenCalledTimes(2);
  });

  it("starts a new child even when the crash was not noticed yet", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    const child = harness.children[0];
    if (!child) throw new Error("no child");
    child.exitCode = 1;
    const again = await harness.supervisor.start(startRequest());

    expect(again.status).toBe("started");
    expect(harness.spawn).toHaveBeenCalledTimes(2);
  });
});

describe("output capture", () => {
  it("keeps only the newest lines and decodes characters split across chunks", async () => {
    const harness = makeHarness({ scripts: [{ hello: false }] });
    const started = harness.supervisor.start(startRequest());
    await settle();
    const stream = harness.children[0]?.stdout;
    const bytes = Buffer.from("日誌一行\n");
    stream?.write(bytes.subarray(0, 4));
    stream?.write(bytes.subarray(4));
    harness.children[0]?.say(harness.children[0].helloMessage());
    await started;

    expect(harness.supervisor.recentOutput).toEqual(["日誌一行"]);
  });

  it("flushes an unfinished last line when the stream ends", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    harness.children[0]?.stdout.write("no newline");
    harness.children[0]?.stdout.end();
    await settle();

    expect(harness.supervisor.recentOutput).toEqual(["no newline"]);
  });

  it("keeps the output of the last child after it stopped", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    harness.children[0]?.stdout.write("bye\n");
    await harness.supervisor.stop();

    expect(harness.supervisor.recentOutput).toEqual(["bye"]);
  });
});

describe("masking of captured output", () => {
  const HOME = "/synthetic/home/someone";
  const BACKUPS = "/synthetic/backups/dir";

  async function startedWithOutput(lines: string[], options: Parameters<typeof makeHarness>[0] = {}, request = {}) {
    const harness = makeHarness({ parentEnvironment: { HOME }, ...options });
    await harness.supervisor.start(startRequest({ backupDirectory: BACKUPS, ...request }));
    harness.children[0]?.stdout.write(`${lines.join("\n")}\n`);
    await settle();
    return harness;
  }

  it("masks the database path, its real path, the backup directory, the home, the run id and the challenge", async () => {
    const harness = await startedWithOutput(
      [
        `SQLite database: ${DB_PATH}`,
        `backup in ${BACKUPS}/2026.sqlite`,
        `cache ${HOME}/.cache/x`,
        `run ${RUN_ID} challenge synthetic-challenge-0123456789`,
        "plain line",
      ],
      { realpath: (path) => (path === DB_PATH ? "/synthetic/real/work.sqlite" : path) },
    );
    harness.children[0]?.stderr.write("opened /synthetic/real/work.sqlite\n");
    await settle();

    const output = harness.supervisor.recentOutput.join("\n");
    for (const secret of [
      DB_PATH,
      BACKUPS,
      HOME,
      RUN_ID,
      "synthetic-challenge-0123456789",
      "/synthetic/real/work.sqlite",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("SQLite database: [redacted]");
    expect(output).toContain("plain line");
  });

  it("masks the real path the preflight reported", async () => {
    const harness = makeHarness({
      scripts: [
        {
          preflight: { identity: { ...IDENTITY, realPath: "/synthetic/volume/real-name.sqlite" } },
          ready: { databaseIdentity: { ...IDENTITY, realPath: "/synthetic/volume/real-name.sqlite" } },
        },
      ],
    });
    await harness.supervisor.start(startRequest());
    harness.children[0]?.stdout.write("using /synthetic/volume/real-name.sqlite\n");
    await settle();

    expect(harness.supervisor.recentOutput.join("\n")).not.toContain("real-name.sqlite");
  });

  it("masks a Windows path regardless of case and slash direction, with regex metacharacters in it", async () => {
    const home = "C:\\Users\\a.b (x86)";
    const harness = await startedWithOutput(
      [`c:\\users\\A.B (X86)\\AppData and c:/users/a.b (x86)/data and C:\\Users\\aXb (x86)`],
      { platform: "win32", parentEnvironment: { USERPROFILE: home } },
      { databasePath: "C:\\Data\\work.sqlite" },
    );

    const output = harness.supervisor.recentOutput.join("\n");
    expect(output).toBe("[redacted]\\AppData and [redacted]/data and C:\\Users\\aXb (x86)");
  });

  it("masks a secret that arrives split over two chunks and one that sits at the cut of a very long line", async () => {
    const harness = makeHarness({ parentEnvironment: { HOME } });
    await harness.supervisor.start(startRequest());
    const stdout = harness.children[0]?.stdout;
    stdout?.write(`first ${RUN_ID.slice(0, 10)}`);
    stdout?.write(`${RUN_ID.slice(10)} end\n`);
    stdout?.write(`${"x".repeat(8190)}${DB_PATH} and more ${"y".repeat(100)}`);
    stdout?.write(`${DB_PATH}\nnext line\n`);
    await settle();

    const lines = harness.supervisor.recentOutput;
    expect(lines.join("\n")).not.toContain(RUN_ID);
    expect(lines.join("\n")).not.toContain("/synthetic/data");
    expect(lines.join("\n")).not.toContain("synthetic/data");
    expect(lines.at(-1)).toBe("next line");
    expect(lines.some((line) => line.startsWith("first [redacted] end"))).toBe(true);
  });
});

describe("health checks of a running backend (L-09)", () => {
  const EVERY = 1000;

  function stuckHarness(monitorMs = EVERY) {
    const stuck = { on: false };
    const harness = makeHarness({
      timeouts: { monitorMs },
      health: async (_url, headers, runId) => {
        if (stuck.on) throw new Error("timeout");
        return genuineHealth(runId, headers);
      },
    });
    return { harness, stuck };
  }

  it("ends a backend that stays alive but stops answering, and reports it like an unexpected exit", async () => {
    const { harness, stuck } = stuckHarness();
    const events: BackendExitEvent[] = [];
    harness.supervisor.onUnexpectedExit((event) => events.push(event));
    const started = await harness.supervisor.start(startRequest());
    stuck.on = true;

    await vi.advanceTimersByTimeAsync(EVERY * 2);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(EVERY * 12);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ code: "CHILD_EXITED", detail: "the backend stopped answering health checks" });
    expect(events[0]?.info).toBe((started as { info: unknown }).info);
    expect(harness.supervisor.running).toBeUndefined();
  });

  it("does not end a backend after one or two slow checks that are followed by an answer", async () => {
    const { harness, stuck } = stuckHarness();
    const events: BackendExitEvent[] = [];
    harness.supervisor.onUnexpectedExit((event) => events.push(event));
    await harness.supervisor.start(startRequest());
    const callsAfterStart = harness.fetchHealth.mock.calls.length;

    stuck.on = true;
    await vi.advanceTimersByTimeAsync(EVERY * 2);
    stuck.on = false;
    await vi.advanceTimersByTimeAsync(EVERY * 10);

    expect(harness.fetchHealth.mock.calls.length).toBeGreaterThan(callsAfterStart + 2);
    expect(events).toEqual([]);
    expect(harness.supervisor.running).toBeDefined();
  });

  it("checks nothing once the backend is stopped, and nothing at all when turned off", async () => {
    const { harness } = stuckHarness();
    await harness.supervisor.start(startRequest());
    await harness.supervisor.stop();
    const calls = harness.fetchHealth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(EVERY * 10);
    expect(harness.fetchHealth.mock.calls.length).toBe(calls);

    const off = stuckHarness(0);
    await off.harness.supervisor.start(startRequest());
    const before = off.harness.fetchHealth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(EVERY * 10);
    expect(off.harness.fetchHealth.mock.calls.length).toBe(before);
  });

  it("treats an answer without the right proof as no answer", async () => {
    const harness = makeHarness({ timeouts: { monitorMs: EVERY } });
    const events: BackendExitEvent[] = [];
    harness.supervisor.onUnexpectedExit((event) => events.push(event));
    await harness.supervisor.start(startRequest());
    harness.fetchHealth.mockImplementation(async () => ({ status: 200, header: () => "not-the-proof" }));
    await vi.advanceTimersByTimeAsync(EVERY * 14);
    expect(events).toHaveLength(1);
  });
});
