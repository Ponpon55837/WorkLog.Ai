import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY, makeHarness, settle, startRequest } from "./backend-helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("update-facts", () => {
  it("is sent to the running backend and refused when nothing runs", async () => {
    const harness = makeHarness();
    expect(await harness.supervisor.updateFacts({ activePort: 1 })).toBe(false);
    await harness.supervisor.start(startRequest());
    const desktop = { storageRisk: { risk: "removable", migrationBlocked: true } } as const;
    expect(await harness.supervisor.updateFacts(desktop)).toBe(true);
    expect(harness.children[0]?.sent).toContainEqual({ type: "update-facts", desktop });
  });

  it("reports a channel that cannot send as false", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    const child = harness.children[0];
    if (!child) throw new Error("no child");
    child.send = () => {
      throw new Error("closed");
    };
    expect(await harness.supervisor.updateFacts({ activePort: 1 })).toBe(false);
  });
});

describe("copyDatabase", () => {
  it("asks a preview child for the copy and shuts it down", async () => {
    const harness = makeHarness();
    const outcome = await harness.supervisor.copyDatabase("/synthetic/a.sqlite", "/synthetic/b.sqlite");
    expect(outcome).toEqual({ outcome: "checked", result: { type: "copy-result", status: "ok", identity: IDENTITY } });
    expect(harness.children[0]?.sent.map((message) => message.type)).toEqual(["copy-database", "shutdown"]);
    expect(harness.children[0]?.sent[0]).toEqual({
      type: "copy-database",
      source: "/synthetic/a.sqlite",
      target: "/synthetic/b.sqlite",
    });
    expect(harness.supervisor.running).toBeUndefined();
  });

  it("passes a failed verdict through", async () => {
    const harness = makeHarness({ scripts: [{ copy: { status: "no-space" } }] });
    const outcome = await harness.supervisor.copyDatabase("/synthetic/a.sqlite", "/synthetic/b.sqlite");
    expect(outcome).toMatchObject({ outcome: "checked", result: { status: "no-space" } });
  });

  it("fails when the child never says hello, answers nothing, or is cancelled by a stop", async () => {
    const mute = makeHarness({ scripts: [{ hello: false }] });
    const pending = mute.supervisor.copyDatabase("/synthetic/a.sqlite", "/synthetic/b.sqlite");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ outcome: "failed" });

    const silent = makeHarness({ scripts: [{ copy: false }], timeouts: { copyMs: 50 } });
    const waiting = silent.supervisor.copyDatabase("/synthetic/a.sqlite", "/synthetic/b.sqlite");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toMatchObject({ outcome: "failed" });

    const queued = makeHarness();
    const first = queued.supervisor.copyDatabase("/synthetic/a.sqlite", "/synthetic/b.sqlite");
    const second = queued.supervisor.copyDatabase("/synthetic/a.sqlite", "/synthetic/c.sqlite");
    const stopped = queued.supervisor.stop();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await stopped;
    await first;
    expect(await second).toMatchObject({ outcome: "failed", code: "REPAIR_REQUIRED" });
  });
});
