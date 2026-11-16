import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileOperationJournalStore,
  InMemoryOperationJournalStore,
  OperationCoordinator,
  OperationJournal,
  type JournalJson,
  type OperationJournalStore,
  type OperationStep,
} from "../../packages/desktop-core/src/index.js";
import { makeClock, newInput } from "./operations-helpers.js";

const dirs: string[] = [];

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function setup(store: OperationJournalStore = new InMemoryOperationJournalStore()): {
  journal: OperationJournal;
  coordinator: OperationCoordinator;
  store: OperationJournalStore;
} {
  const journal = new OperationJournal(store, makeClock());
  return { journal, coordinator: new OperationCoordinator(journal), store };
}

function step(name: string, run: OperationStep["run"], extra: Partial<OperationStep> = {}): OperationStep {
  return { name, cancellable: true, run, ...extra };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OperationCoordinator", () => {
  it("runs steps in order, walks the phases and stores the last step result", async () => {
    const { coordinator, journal } = setup();
    const calls: string[] = [];
    const result = await coordinator.run(newInput(), [
      step("preflight", async () => void calls.push("preflight"), { phase: "PREPARING" }),
      step("stop", async () => void calls.push("stop"), { phase: "QUIESCING" }),
      step("start", async () => ({ port: 3210 }) as JournalJson, { phase: "STARTING", cancellable: false }),
    ]);
    expect(result).toEqual({ status: "completed", result: { port: 3210 } });
    expect(calls).toEqual(["preflight", "stop"]);
    expect(await journal.get("op-1")).toMatchObject({
      phase: "STARTING",
      status: "completed",
      completedSteps: ["preflight", "stop", "start"],
    });
    expect(coordinator.current()).toBeNull();
  });

  it("completes an empty step list with a null result", async () => {
    expect(await setup().coordinator.run(newInput(), [])).toEqual({ status: "completed", result: null });
  });

  it("returns busy with current info for a different operation, then accepts it once idle", async () => {
    const { coordinator } = setup();
    const hold = gate();
    const first = coordinator.run(newInput(), [
      step("wait", () => hold.promise, { phase: "PREPARING", cancellable: false }),
    ]);
    await flush();
    const busy = await coordinator.run(newInput({ operationId: "op-2", kind: "restart" }), []);
    expect(busy).toEqual({
      status: "busy",
      current: { operationId: "op-1", kind: "takeover", phase: "PREPARING", cancellable: false },
    });
    expect(coordinator.current()?.operationId).toBe("op-1");
    hold.open();
    await first;
    expect((await coordinator.run(newInput({ operationId: "op-2" }), [])).status).toBe("completed");
  });

  it("returns the same in-flight promise for the same id and runs the steps once", async () => {
    const { coordinator } = setup();
    const hold = gate();
    let runs = 0;
    const steps = [
      step("s", async () => {
        runs += 1;
        await hold.promise;
        return 7;
      }),
    ];
    const a = coordinator.run(newInput(), steps);
    const b = coordinator.run(newInput(), steps);
    expect(b).toBe(a);
    hold.open();
    expect(await a).toEqual({ status: "completed", result: 7 });
    expect(runs).toBe(1);
  });

  it("returns the stored result after completion, even from a re-created coordinator on the same journal file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wi-coord-"));
    dirs.push(dir);
    const file = path.join(dir, "journal.json");
    const first = setup(new FileOperationJournalStore(file));
    expect(await first.coordinator.run(newInput(), [step("s", async () => ({ done: true }))])).toEqual({
      status: "completed",
      result: { done: true },
    });
    const second = setup(new FileOperationJournalStore(file));
    let ran = false;
    expect(
      await second.coordinator.run(newInput(), [
        step("s", async () => {
          ran = true;
        }),
      ]),
    ).toEqual({ status: "completed", result: { done: true } });
    expect(ran).toBe(false);
  });

  it("answers a finished id from the journal while another operation is busy", async () => {
    const { coordinator } = setup();
    await coordinator.run(newInput(), [step("s", async () => 1)]);
    const hold = gate();
    const running = coordinator.run(newInput({ operationId: "op-2" }), [step("w", () => hold.promise)]);
    await flush();
    expect(await coordinator.run(newInput(), [])).toEqual({ status: "completed", result: 1 });
    hold.open();
    await running;
  });

  it("runs a waiting request when the lock is released during its journal lookup", async () => {
    const lookup = gate();
    class SlowLookupJournal extends OperationJournal {
      override async get(operationId: string) {
        if (operationId === "op-3") await lookup.promise;
        return super.get(operationId);
      }
    }
    const journal = new SlowLookupJournal(new InMemoryOperationJournalStore(), makeClock());
    const coordinator = new OperationCoordinator(journal);
    const hold = gate();
    const running = coordinator.run(newInput({ operationId: "op-2" }), [step("w", () => hold.promise)]);
    await flush();
    const waiting = coordinator.run(newInput({ operationId: "op-3" }), [step("x", async () => "x")]);
    hold.open();
    await running;
    lookup.open();
    expect(await waiting).toEqual({ status: "completed", result: "x" });
  });

  it("uses the system clock by default", async () => {
    const journal = new OperationJournal(new InMemoryOperationJournalStore());
    const record = await journal.begin(newInput());
    expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);
  });

  it("resumes an in-progress operation after a restart and skips journaled steps", async () => {
    const store = new InMemoryOperationJournalStore();
    const crashing = setup(store);
    await crashing.coordinator.run(newInput(), [
      step("a", async () => "A", { phase: "PREPARING" }),
      step(
        "b",
        async () => {
          throw new Error("boom");
        },
        { phase: "QUIESCING" },
      ),
    ]);
    // Simulate a crash instead of a clean failure: reopen the record as in-progress with step "a" done.
    const raw = await store.load();
    if (!raw) throw new Error("missing journal");
    await store.save({
      ...raw,
      records: raw.records.map((r) => ({
        ...r,
        status: "in-progress" as const,
        error: null,
        phase: "PREPARING" as const,
      })),
    });
    const calls: string[] = [];
    const resumed = setup(store);
    const result = await resumed.coordinator.run(newInput(), [
      step(
        "a",
        async () => {
          calls.push("a");
          return "again";
        },
        { phase: "PREPARING" },
      ),
      step(
        "b",
        async () => {
          calls.push("b");
          return "B";
        },
        { phase: "QUIESCING" },
      ),
    ]);
    expect(result).toEqual({ status: "completed", result: "B" });
    expect(calls).toEqual(["b"]);
  });

  it("reports a stored last-step result when every step was already journaled", async () => {
    const store = new InMemoryOperationJournalStore();
    const { journal } = setup(store);
    await journal.begin(newInput());
    await journal.completeStep("op-1", "only", "R");
    expect(await setup(store).coordinator.run(newInput(), [step("only", async () => "other")])).toEqual({
      status: "completed",
      result: "R",
    });
  });

  it("cancel during a cancellable phase aborts the signal and stops at the next boundary", async () => {
    const { coordinator, journal } = setup();
    const hold = gate();
    let secondRan = false;
    let sawAbort = false;
    const running = coordinator.run(newInput(), [
      step(
        "a",
        async (ctx) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
          });
          await hold.promise;
        },
        { phase: "PREPARING" },
      ),
      step(
        "b",
        async () => {
          secondRan = true;
        },
        { phase: "QUIESCING" },
      ),
    ]);
    await flush();
    expect(coordinator.cancel("op-1")).toEqual({ accepted: true });
    hold.open();
    // Phase PREPARING was already entered, so the cancel must not finalize: recovery decides.
    expect(await running).toEqual({ status: "cancelled", recoveryRequired: true });
    expect(sawAbort).toBe(true);
    expect(secondRan).toBe(false);
    expect(await journal.get("op-1")).toMatchObject({ status: "in-progress", cancelRequested: true });
    // A resubmitted id must not silently resume steps.
    expect(await coordinator.run(newInput(), [step("b", async () => (secondRan = true) as never)])).toEqual({
      status: "cancelled",
      recoveryRequired: true,
    });
    expect(secondRan).toBe(false);
    expect(await journal.findInProgress()).toMatchObject({ operationId: "op-1", cancelRequested: true });
  });

  it("finalizes a cancel as cancelled when no phase changed and no step completed", async () => {
    const { coordinator, journal } = setup();
    const running = coordinator.run(newInput(), [
      step(
        "a",
        (ctx) => new Promise<void>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("x")))),
      ),
    ]);
    await flush();
    coordinator.cancel("op-1");
    expect(await running).toEqual({ status: "cancelled" });
    expect(await journal.get("op-1")).toMatchObject({ status: "cancelled", cancelRequested: false });
  });

  it("keeps a cancel in-progress when an earlier step already completed", async () => {
    const { coordinator, journal } = setup();
    const hold = gate();
    const running = coordinator.run(newInput(), [step("a", () => hold.promise), step("b", async () => "B")]);
    await flush();
    coordinator.cancel("op-1");
    hold.open();
    expect(await running).toEqual({ status: "cancelled", recoveryRequired: true });
    expect(await journal.get("op-1")).toMatchObject({ status: "in-progress", cancelRequested: true });
  });

  it("returns the stored result of an operation closed by recovery", async () => {
    const { coordinator, journal } = setup();
    await journal.begin(newInput());
    await journal.applyRecovery("op-1", {
      nextState: "EXTERNAL",
      action: "none",
      recoveryPolicy: "restore-previous",
      migrationStarted: false,
      restore: null,
      reason: "consistent",
    });
    expect(await coordinator.run(newInput(), [])).toEqual({
      status: "interrupted",
      recoveredState: "EXTERNAL",
      reason: "consistent",
    });
  });

  it("treats a step that throws after an accepted cancel as cancelled", async () => {
    const { coordinator } = setup();
    const running = coordinator.run(newInput(), [
      step(
        "a",
        (ctx) =>
          new Promise<void>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")))),
      ),
    ]);
    await flush();
    coordinator.cancel("op-1");
    expect(await running).toEqual({ status: "cancelled" });
  });

  it("cancel during a non-cancellable phase is refused and the operation continues", async () => {
    const { coordinator } = setup();
    const hold = gate();
    let sawAbort = false;
    const running = coordinator.run(newInput(), [
      step(
        "sqlite",
        async (ctx) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
          });
          await hold.promise;
          return "written";
        },
        { phase: "PREPARING", cancellable: false },
      ),
      step("after", async () => "ok"),
    ]);
    await flush();
    expect(coordinator.cancel("op-1")).toEqual({ accepted: false, reason: "non-cancellable-phase" });
    hold.open();
    expect(await running).toEqual({ status: "completed", result: "ok" });
    expect(sawAbort).toBe(false);
  });

  it("cancel of an unknown or finished operation is refused", async () => {
    const { coordinator } = setup();
    expect(coordinator.cancel("nope")).toEqual({ accepted: false, reason: "unknown-operation" });
    await coordinator.run(newInput(), []);
    expect(coordinator.cancel("op-1")).toEqual({ accepted: false, reason: "unknown-operation" });
  });

  it("a cancel accepted during the last step is ignored once it completes", async () => {
    const { coordinator } = setup();
    const hold = gate();
    const running = coordinator.run(newInput(), [step("a", () => hold.promise)]);
    await flush();
    coordinator.cancel("op-1");
    hold.open();
    // Every step finished: a late cancel has nothing left to stop and is ignored.
    expect(await running).toEqual({ status: "completed", result: null });
  });

  it("refuses a cancel once every step has completed", async () => {
    const { coordinator } = setup();
    const running = coordinator.run(newInput(), [step("a", async () => "A")]);
    expect(await running).toEqual({ status: "completed", result: "A" });
    expect(coordinator.cancel("op-1")).toEqual({ accepted: false, reason: "unknown-operation" });
  });

  it("a failed step that moved the owner ends in NEEDS_REPAIR and the failure is stored", async () => {
    const { coordinator, journal } = setup();
    const result = await coordinator.run(newInput(), [
      step(
        "a",
        async () => {
          throw new Error("port busy");
        },
        { phase: "PREPARING" },
      ),
    ]);
    expect(result).toEqual({ status: "failed", error: "port busy" });
    expect(await journal.get("op-1")).toMatchObject({ phase: "NEEDS_REPAIR", status: "failed", error: "port busy" });
    expect(await coordinator.run(newInput(), [])).toEqual({ status: "failed", error: "port busy" });
  });

  it("a failure before any phase change leaves the phase alone; non-Error throws are stringified", async () => {
    const { coordinator, journal } = setup();
    const result = await coordinator.run(newInput({ kind: "apply-agent" }), [step("a", () => Promise.reject("plain"))]);
    expect(result).toEqual({ status: "failed", error: "plain" });
    expect((await journal.get("op-1"))?.phase).toBe("EXTERNAL");
  });

  it("an illegal phase request fails the operation", async () => {
    const { coordinator } = setup();
    const result = await coordinator.run(newInput(), [step("a", async () => undefined, { phase: "MANAGED" })]);
    expect(result).toMatchObject({ status: "failed" });
  });

  it("markMigrationStarted from a step forbids a later restore and is persisted", async () => {
    const { coordinator, journal } = setup();
    await coordinator.run(newInput(), [
      step("a", async (ctx) => ctx.markMigrationStarted(), { phase: "PREPARING", cancellable: false }),
      step("b", async () => undefined, { phase: "EXTERNAL" }),
    ]);
    expect(await journal.get("op-1")).toMatchObject({
      migrationStarted: true,
      recoveryPolicy: "repair-only",
      status: "failed",
      phase: "NEEDS_REPAIR",
    });
  });

  it("a journal that cannot be read fails closed instead of starting from empty", async () => {
    const store: OperationJournalStore = {
      load: () => Promise.reject(new Error("corrupt")),
      save: () => Promise.resolve(),
    };
    const result = await setup(store).coordinator.run(newInput(), [step("a", async () => 1)]);
    expect(result).toEqual({ status: "failed", error: "corrupt" });
  });

  it("busy lookup tolerates a failing journal read", async () => {
    class FailingLookupJournal extends OperationJournal {
      override async get(operationId: string) {
        if (operationId === "bad") throw new Error("late failure");
        return super.get(operationId);
      }
    }
    const coordinator = new OperationCoordinator(
      new FailingLookupJournal(new InMemoryOperationJournalStore(), makeClock()),
    );
    const hold = gate();
    const running = coordinator.run(newInput(), [step("a", () => hold.promise)]);
    await flush();
    expect((await coordinator.run(newInput({ operationId: "bad" }), [])).status).toBe("busy");
    hold.open();
    await running;
  });

  it("allows only one of many concurrent operations (Promise.all)", async () => {
    const { coordinator } = setup();
    const hold = gate();
    let executed = 0;
    const requests = Array.from({ length: 8 }, (_, i) =>
      coordinator.run(newInput({ operationId: `op-${i}` }), [
        step("s", async () => {
          executed += 1;
          await hold.promise;
          return i;
        }),
      ]),
    );
    await flush();
    hold.open();
    const results = await Promise.all(requests);
    expect(results.filter((r) => r.status === "completed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "busy")).toHaveLength(7);
    expect(executed).toBe(1);
  });

  it("many concurrent resubmissions of one id share one run", async () => {
    const { coordinator } = setup();
    let executed = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        coordinator.run(newInput(), [
          step("s", async () => {
            executed += 1;
            return "v";
          }),
        ]),
      ),
    );
    expect(executed).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });
});
