import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryOperationJournalStore,
  ManagedBackendService,
  OperationCoordinator,
  OperationJournal,
  type ManagedStartRequest,
} from "../../packages/desktop-core/src/index.js";
import {
  DB_PATH,
  genuineHealth,
  IDENTITY,
  makeHarness,
  PORT,
  RUN_ID,
  settle,
  type ChildScript,
} from "./backend-helpers.js";
import { makeClock } from "./operations-helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(scripts: ChildScript[] = [{}], overrides: Parameters<typeof makeHarness>[0] = {}) {
  const harness = makeHarness({ scripts, ...overrides });
  const journal = new OperationJournal(new InMemoryOperationJournalStore(), makeClock());
  const coordinator = new OperationCoordinator(journal);
  const service = new ManagedBackendService(coordinator, harness.supervisor);
  return { harness, journal, coordinator, service };
}

function request(overrides: Partial<ManagedStartRequest> = {}): ManagedStartRequest {
  return {
    operationId: "op-start-1",
    kind: "takeover",
    previousOwner: "UNCONFIGURED",
    backend: { port: PORT, databasePath: DB_PATH },
    ...overrides,
  };
}

describe("starting through the coordinator", () => {
  it("moves PREPARING -> STARTING -> MANAGED and returns the verified backend", async () => {
    const { service, journal } = setup();
    const result = await service.start(request());

    expect(result.operation).toMatchObject({ status: "completed" });
    expect(result.backend).toMatchObject({ port: PORT, pid: 4242 });
    const record = await journal.get("op-start-1");
    expect(record).toMatchObject({
      status: "completed",
      phase: "MANAGED",
      completedSteps: ["prepare", "start-backend", "commit"],
      migrationStarted: false,
    });
  });

  it("keeps the run id and every path out of the journal", async () => {
    const { service, journal } = setup();
    await service.start(request());

    const text = JSON.stringify(await journal.get("op-start-1"));
    expect(text).not.toContain(RUN_ID);
    expect(text).not.toContain(DB_PATH);
    expect(text).toContain('"port":41234');
  });

  it("returns the same result for the same operation id without a second child", async () => {
    const { service, harness } = setup();
    const [first, second] = await Promise.all([service.start(request()), service.start(request())]);
    const third = await service.start(request());

    expect(second.operation).toBe(first.operation);
    expect(third.operation).toEqual(first.operation);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it("answers busy to a different operation id while one runs", async () => {
    const { service, harness } = setup([{ preflight: false }]);
    const first = service.start(request());
    await settle();
    const second = await service.start(request({ operationId: "op-start-2" }));

    expect(second.operation).toMatchObject({
      status: "busy",
      current: { operationId: "op-start-1", phase: "STARTING" },
    });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    await service.stop().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
  });

  it("keeps a running backend for a new operation: already-running, no second listener", async () => {
    const { service, harness, journal } = setup();
    await service.start(request());
    const again = await service.start(
      request({ operationId: "op-start-2", kind: "restart", previousOwner: "MANAGED" }),
    );

    expect(again.operation.status).toBe("completed");
    expect((await journal.get("op-start-2"))?.stepResults["start-backend"]).toMatchObject({
      outcome: "already-running",
    });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(await journal.get("op-start-2")).toMatchObject({ phase: "MANAGED", status: "completed" });
  });

  it("stops the running backend first when asked to restart it", async () => {
    const { service, harness, journal } = setup();
    await service.start(request());
    const restarted = await service.start(
      request({ operationId: "op-restart", kind: "restart", previousOwner: "MANAGED", stopRunning: true }),
    );

    expect(restarted.operation.status).toBe("completed");
    expect((await journal.get("op-restart"))?.stepResults).toMatchObject({
      prepare: { stoppedPrevious: true },
      "start-backend": { outcome: "started" },
    });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.children[0]?.exitCode).toBe(0);
    expect(harness.children[1]?.exitCode).toBeNull();
  });

  it("restarts cleanly when nothing was running", async () => {
    const { service } = setup();
    const result = await service.start(request({ stopRunning: true }));
    expect(result.operation).toMatchObject({ status: "completed" });
  });

  it("fails closed when the previous backend cannot be proven stopped", async () => {
    const { service, harness, journal } = setup([{}, {}]);
    await service.start(request());
    harness.isPortFree.mockImplementation(async () => false);
    const restarting = service.start(
      request({ operationId: "op-restart", kind: "restart", previousOwner: "MANAGED", stopRunning: true }),
    );
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await restarting;

    expect(result).toMatchObject({ operation: { status: "failed" }, errorCode: "PORT_NOT_RELEASED" });
    expect(await journal.get("op-restart")).toMatchObject({ phase: "NEEDS_REPAIR", status: "failed" });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("failures", () => {
  it("ends in NEEDS_REPAIR with the code and no child left when the port is taken", async () => {
    const { service, harness, journal } = setup([{}], { isPortFree: async () => false });
    const result = await service.start(request());

    expect(result).toMatchObject({ operation: { status: "failed" }, errorCode: "PORT_OCCUPIED_BY_OTHER" });
    expect(result.backend).toBeUndefined();
    expect(await journal.get("op-start-1")).toMatchObject({ phase: "NEEDS_REPAIR", status: "failed" });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("stops the child and ends in NEEDS_REPAIR when its identity cannot be proven", async () => {
    const { service, harness } = setup([{}], { health: async () => ({ status: 200, header: () => undefined }) });
    const result = await service.start(request());

    expect(result).toMatchObject({ operation: { status: "failed" }, errorCode: "SERVICE_IDENTITY_MISMATCH" });
    expect(harness.children[0]?.exitCode).toBe(0);
  });

  it("fails the commit when the backend died right after it was verified", async () => {
    const holder: { exit?: () => void } = {};
    const { service, harness, journal } = setup([{}], {
      health: async (_url, headers, runId) => {
        holder.exit?.();
        return genuineHealth(runId, headers);
      },
    });
    holder.exit = () => harness.children[0]?.exit(1);
    const result = await service.start(request());

    expect(result).toMatchObject({ operation: { status: "failed" }, errorCode: "CHILD_EXITED" });
    expect(await journal.get("op-start-1")).toMatchObject({ phase: "NEEDS_REPAIR" });
  });

  it("does not attach an error code to a failure that is not a backend failure", async () => {
    const { service, journal } = setup();
    vi.spyOn(journal, "enterPhase").mockRejectedValueOnce(new Error("journal offline"));
    const result = await service.start(request());

    expect(result.operation).toMatchObject({ status: "failed", error: "journal offline" });
    expect(result.errorCode).toBeUndefined();
  });
});

describe("schema migration", () => {
  it("marks the migration started before the child may write, when it is approved", async () => {
    const { service, journal, harness } = setup([{ preflight: { compatibility: "older-needs-migration" } }]);
    const result = await service.start(
      request({ backend: { port: PORT, databasePath: DB_PATH, allowSchemaMigration: true } }),
    );

    expect(result.operation.status).toBe("completed");
    expect(await journal.get("op-start-1")).toMatchObject({ migrationStarted: true, recoveryPolicy: "repair-only" });
    expect(harness.children[0]?.sent.some((message) => message.type === "start")).toBe(true);
  });

  it("does not mark it for a current database", async () => {
    const { service, journal } = setup();
    await service.start(request());
    expect(await journal.get("op-start-1")).toMatchObject({ migrationStarted: false });
  });

  it("refuses an unapproved migration without marking it", async () => {
    const { service, journal } = setup([{ preflight: { compatibility: "older-needs-migration" } }]);
    const result = await service.start(request());

    expect(result).toMatchObject({ errorCode: "SCHEMA_MIGRATION_BLOCKED" });
    expect(await journal.get("op-start-1")).toMatchObject({ migrationStarted: false, phase: "NEEDS_REPAIR" });
  });
});

describe("stop", () => {
  it("stops the backend without touching the journal: quitting the App keeps the owner MANAGED", async () => {
    const { service, journal, harness } = setup();
    await service.start(request());
    const before = JSON.stringify(await journal.get("op-start-1"));
    const stopped = await service.stop();

    expect(stopped).toMatchObject({ status: "stopped", report: { graceful: true, exited: true, portReleased: true } });
    expect(harness.supervisor.running).toBeUndefined();
    expect(JSON.stringify(await journal.get("op-start-1"))).toBe(before);
  });

  it("reports busy while a start operation holds the lock", async () => {
    const { service } = setup([{ preflight: false }]);
    const starting = service.start(request());
    await settle();

    expect(await service.stop()).toMatchObject({ status: "busy", current: { operationId: "op-start-1" } });
    await vi.advanceTimersByTimeAsync(15_000);
    await starting;
  });
});

describe("an unexpected exit", () => {
  it("is forwarded unchanged by the supervisor so the shell can move to NEEDS_REPAIR", async () => {
    const { service, harness } = setup();
    const events: string[] = [];
    harness.supervisor.onUnexpectedExit((event) => events.push(event.code));
    await service.start(request());
    harness.children[0]?.exit(2);
    await settle();

    expect(events).toEqual(["CHILD_EXITED"]);
    expect(IDENTITY.realPath).toBe(DB_PATH);
  });
});
