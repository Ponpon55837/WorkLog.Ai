import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHarness, settle } from "./backend-helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Settles `pending` under fake timers (a stopping child is waited for with timers). */
async function finish<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

const DB = "/synthetic/data/work-intelligence.sqlite";
const SOURCE = "/synthetic/backups/a.sqlite";

describe("inspectBackups", () => {
  it("sends only the fields it was given and shuts the child down", async () => {
    const harness = makeHarness({
      scripts: [{ inspect: { items: [{ path: SOURCE, fileName: "a.sqlite", bytes: 10, status: "ok" }] } }],
    });
    const outcome = await finish(harness.supervisor.inspectBackups({ databasePath: DB }));
    expect(outcome).toMatchObject({ outcome: "checked", result: { items: [{ fileName: "a.sqlite" }] } });
    expect(harness.children[0]?.sent.map((message) => message.type)).toEqual(["inspect-backups", "shutdown"]);
    expect(harness.children[0]?.sent[0]).toEqual({ type: "inspect-backups", databasePath: DB });
    expect(harness.supervisor.running).toBeUndefined();
  });

  it("passes the folder, the files, the integrity flag and the limit through", async () => {
    const harness = makeHarness();
    await finish(
      harness.supervisor.inspectBackups({
        databasePath: DB,
        backupDirectory: "/synthetic/backups",
        files: [SOURCE],
        integrity: false,
        limit: 3,
      }),
    );
    expect(harness.children[0]?.sent[0]).toEqual({
      type: "inspect-backups",
      databasePath: DB,
      backupDirectory: "/synthetic/backups",
      files: [SOURCE],
      integrity: false,
      limit: 3,
    });
  });

  it("fails when the child answers nothing in time", async () => {
    const harness = makeHarness({ scripts: [{ inspect: false }], timeouts: { quickCheckMs: 50 } });
    const pending = harness.supervisor.inspectBackups({ databasePath: DB });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ outcome: "failed" });
  });

  it("is cancelled when a stop came after it was queued", async () => {
    const harness = makeHarness();
    const first = harness.supervisor.inspectBackups({ databasePath: DB });
    const second = harness.supervisor.inspectBackups({ databasePath: DB });
    const stopped = harness.supervisor.stop();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await stopped;
    await first;
    expect(await second).toMatchObject({ outcome: "failed", code: "REPAIR_REQUIRED" });
  });

  it("logs a child that did not exit after it was asked to stop", async () => {
    const harness = makeHarness({ scripts: [{ onShutdown: "ignore", onSigterm: "ignore", onSigkill: "ignore" }] });
    const pending = harness.supervisor.inspectBackups({ databasePath: DB });
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(harness.logs.some((line) => line.includes("did not exit"))).toBe(true);
  });
});

describe("restoreDatabase", () => {
  it("passes a verdict through, with the optional backup folder", async () => {
    const harness = makeHarness({
      scripts: [{ restore: { status: "ok", safetyBackup: "safety.sqlite", projects: 1, sessions: 2 } }],
    });
    const outcome = await finish(
      harness.supervisor.restoreDatabase({ source: SOURCE, databasePath: DB, backupDirectory: "/synthetic/backups" }),
    );
    expect(outcome).toMatchObject({ outcome: "checked", result: { type: "restore-result", status: "ok" } });
    expect(harness.children[0]?.sent.map((message) => message.type)).toEqual(["restore-database", "shutdown"]);
    expect(harness.children[0]?.sent[0]).toEqual({
      type: "restore-database",
      source: SOURCE,
      databasePath: DB,
      backupDirectory: "/synthetic/backups",
    });
  });

  it("omits the backup folder when none is given and passes a refusal through", async () => {
    const harness = makeHarness({ scripts: [{ restore: { status: "locked" } }] });
    const outcome = await finish(harness.supervisor.restoreDatabase({ source: SOURCE, databasePath: DB }));
    expect(outcome).toMatchObject({ outcome: "checked", result: { status: "locked" } });
    expect(harness.children[0]?.sent[0]).toEqual({ type: "restore-database", source: SOURCE, databasePath: DB });
  });

  it("is failed, not unknown, when the child never said hello (the request was never sent)", async () => {
    const harness = makeHarness({ scripts: [{ hello: false }] });
    const pending = harness.supervisor.restoreDatabase({ source: SOURCE, databasePath: DB });
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await pending;
    expect(outcome.outcome).toBe("failed");
    expect(harness.children[0]?.sent.some((message) => message.type === "restore-database")).toBe(false);
  });

  it("is unknown when the request was sent and the child ended without a verdict", async () => {
    const harness = makeHarness({ scripts: [{ restore: "exit" }] });
    const outcome = await finish(harness.supervisor.restoreDatabase({ source: SOURCE, databasePath: DB }));
    expect(outcome.outcome).toBe("unknown");
  });

  it("never kills a restoring child for taking long: it waits without a timer", async () => {
    const harness = makeHarness({ scripts: [{ restore: false }] });
    let done = false;
    const pending = harness.supervisor.restoreDatabase({ source: SOURCE, databasePath: DB }).then((outcome) => {
      done = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(done).toBe(false);
    expect(harness.children[0]?.kills).toEqual([]);
    harness.children[0]?.say({ type: "restore-result", status: "ok" });
    expect(await pending).toMatchObject({ outcome: "checked", result: { status: "ok" } });
  });

  it("is refused as failed when a stop came after it was queued, and waits for earlier work first", async () => {
    const harness = makeHarness();
    const first = harness.supervisor.inspectBackups({ databasePath: DB });
    const second = harness.supervisor.restoreDatabase({ source: SOURCE, databasePath: DB });
    const stopped = harness.supervisor.stop();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await stopped;
    await first;
    expect(await second).toMatchObject({ outcome: "failed", code: "REPAIR_REQUIRED" });
    expect(harness.children.flatMap((child) => child.sent.map((message) => message.type))).not.toContain(
      "restore-database",
    );
  });

  it("logs a child that did not exit after the restore", async () => {
    const harness = makeHarness({ scripts: [{ onShutdown: "ignore", onSigterm: "ignore", onSigkill: "ignore" }] });
    const pending = harness.supervisor.restoreDatabase({ source: SOURCE, databasePath: DB });
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(harness.logs.some((line) => line.includes("did not exit"))).toBe(true);
  });
});
