import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHarness, startRequest, type Harness } from "./backend-helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function finish<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

const DB = "/synthetic/data/work-intelligence.sqlite";
const SOURCE = "/synthetic/backups/a.sqlite";

describe("backupRoots", () => {
  it("returns the roots a preview child read and shuts it down", async () => {
    const harness = makeHarness({
      scripts: [{ roots: { roots: [{ path: "/synthetic/projects/app", name: "app" }] } }],
    });
    const outcome = await finish(harness.supervisor.backupRoots(SOURCE, DB));
    expect(outcome).toMatchObject({ outcome: "checked", result: { roots: [{ name: "app" }] } });
    expect(harness.children[0]?.sent.map((message) => message.type)).toEqual(["backup-roots", "shutdown"]);
  });

  it("fails when the child answers nothing in time", async () => {
    const harness = makeHarness({ scripts: [{ roots: false }], timeouts: { quickCheckMs: 50 } });
    const pending = harness.supervisor.backupRoots(SOURCE, DB);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ outcome: "failed" });
  });
});

describe("maintainDatabase", () => {
  it("sends the mode and the optional backup folder and returns the verdict", async () => {
    const harness = makeHarness({ scripts: [{ maintain: { backupFileName: "b.sqlite", reclaimedBytes: 5 } }] });
    const outcome = await finish(
      harness.supervisor.maintainDatabase({
        mode: "maintain",
        databasePath: DB,
        backupDirectory: "/synthetic/backups",
      }),
    );
    expect(outcome).toMatchObject({ outcome: "checked", result: { status: "ok", reclaimedBytes: 5 } });
    expect(harness.children[0]?.sent[0]).toEqual({
      type: "maintain-database",
      mode: "maintain",
      databasePath: DB,
      backupDirectory: "/synthetic/backups",
    });
  });

  it("omits the backup folder for a check", async () => {
    const harness = makeHarness();
    await finish(harness.supervisor.maintainDatabase({ mode: "check", databasePath: DB }));
    expect(harness.children[0]?.sent[0]).toEqual({ type: "maintain-database", mode: "check", databasePath: DB });
  });

  it("is failed before the request was sent and unknown after it", async () => {
    const hello = makeHarness({ scripts: [{ hello: false }] });
    const pending = hello.supervisor.maintainDatabase({ mode: "check", databasePath: DB });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).outcome).toBe("failed");

    const exited = makeHarness({ scripts: [{ maintain: "exit" }] });
    expect((await finish(exited.supervisor.maintainDatabase({ mode: "maintain", databasePath: DB }))).outcome).toBe(
      "unknown",
    );
  });
});

describe("restoreDatabase remap", () => {
  it("sends a copy of each mapped folder", async () => {
    const harness = makeHarness();
    await finish(
      harness.supervisor.restoreDatabase({
        source: SOURCE,
        databasePath: DB,
        remap: [{ from: "/old/app", to: "/new/app" }],
      }),
    );
    expect(harness.children[0]?.sent[0]).toMatchObject({ remap: [{ from: "/old/app", to: "/new/app" }] });
  });
});

/** Makes the fake child answer `maintenance-hint-query` with `reply(requestId)` messages. */
function answerHint(harness: Harness, reply: (requestId: unknown) => Record<string, unknown>[]): void {
  const child = harness.children[0];
  if (!child) throw new Error("no child");
  const original = child.send.bind(child);
  child.send = (message, callback) => {
    if (message.type === "maintenance-hint-query") {
      queueMicrotask(() => reply(message.requestId).forEach((m) => child.say(m)));
    }
    return original(message, callback);
  };
}

describe("queryMaintenanceHint", () => {
  it("is unknown without a running backend", async () => {
    expect(await makeHarness().supervisor.queryMaintenanceHint()).toEqual({ status: "unknown" });
  });

  it("returns the hint, skipping a stale answer", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    answerHint(harness, (requestId) => [
      { type: "maintenance-hint", requestId: "stale-request-id", reclaimableBytes: 1 },
      { type: "maintenance-hint", requestId, reclaimableBytes: 9, suggest: true },
    ]);
    expect(await harness.supervisor.queryMaintenanceHint()).toEqual({
      status: "known",
      reclaimableBytes: 9,
      suggest: true,
    });
  });

  it("is unknown when no answer comes in time", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    const pending = harness.supervisor.queryMaintenanceHint(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ status: "unknown" });
  });
});
