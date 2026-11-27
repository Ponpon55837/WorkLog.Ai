import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHarness, settle, startRequest, type Harness } from "./backend-helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type Probe = NonNullable<Harness["deps"]["probePort"]>;

function withProbe(probe: Probe): Harness {
  const harness = makeHarness();
  (harness.deps as { probePort?: Probe }).probePort = probe;
  return harness;
}

describe("the port probe before a start", () => {
  it("maps EACCES and EADDRNOTAVAIL to PORT_NOT_PERMITTED, apart from a port that is in use", async () => {
    for (const [code, expected] of [
      ["EACCES", "PORT_NOT_PERMITTED"],
      ["EADDRNOTAVAIL", "PORT_NOT_PERMITTED"],
      ["EADDRINUSE", "PORT_OCCUPIED_BY_OTHER"],
    ] as const) {
      const harness = withProbe(async () => ({ free: false, code }));
      expect(await harness.supervisor.start(startRequest())).toMatchObject({ status: "failed", code: expected });
      expect(harness.spawn).not.toHaveBeenCalled();
    }
  });

  it("starts when the probe says free, and still reads a plain `isPortFree` without a probe", async () => {
    expect((await withProbe(async () => ({ free: true })).supervisor.start(startRequest())).status).toBe("started");
    const plain = makeHarness({ isPortFree: async () => false });
    expect(await plain.supervisor.start(startRequest())).toMatchObject({ code: "PORT_OCCUPIED_BY_OTHER" });
  });
});

function answerActivity(harness: Harness, reply: (requestId: unknown) => Record<string, unknown>[]): void {
  const child = harness.children[0];
  if (!child) throw new Error("no child");
  const original = child.send.bind(child);
  child.send = (message, callback) => {
    if (message.type === "activity-query") queueMicrotask(() => reply(message.requestId).forEach((m) => child.say(m)));
    return original(message, callback);
  };
}

describe("queryActivity", () => {
  it("returns what the running backend says it is busy with", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    answerActivity(harness, (requestId) => [{ type: "activity", requestId, busy: ["import", "export"] }]);
    expect(await harness.supervisor.queryActivity()).toEqual({
      status: "known",
      busy: ["import", "export"],
      pendingImport: false,
    });
    answerActivity(harness, (requestId) => [{ type: "activity", requestId, busy: [] }]);
    expect(await harness.supervisor.queryActivity()).toEqual({ status: "known", busy: [], pendingImport: false });
  });

  it("carries the idle import preview flag apart from the busy kinds", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    answerActivity(harness, (requestId) => [{ type: "activity", requestId, busy: [], pendingImport: true }]);
    expect(await harness.supervisor.queryActivity()).toEqual({ status: "known", busy: [], pendingImport: true });
  });

  it("skips a late answer to an earlier query and waits for its own", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    answerActivity(harness, (requestId) => [
      { type: "activity", requestId: "stale-request-id", busy: ["backup"] },
      { type: "activity", requestId, busy: [] },
    ]);
    expect(await harness.supervisor.queryActivity()).toEqual({ status: "known", busy: [], pendingImport: false });
  });

  it("is unknown without a running backend and when no answer comes in time", async () => {
    const idle = makeHarness();
    expect(await idle.supervisor.queryActivity()).toEqual({ status: "unknown" });

    const silent = makeHarness();
    await silent.supervisor.start(startRequest());
    const pending = silent.supervisor.queryActivity(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ status: "unknown" });
  });

  it("is unknown when the channel is closed", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    const child = harness.children[0];
    if (!child) throw new Error("no child");
    child.send = () => {
      throw new Error("closed");
    };
    expect(await harness.supervisor.queryActivity()).toEqual({ status: "unknown" });
  });
});

describe("open-port-settings from the child", () => {
  it("reaches the listeners with what the page sent, until one unsubscribes", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    const seen: unknown[] = [];
    const stop = harness.supervisor.onOpenPortSettings((request) => seen.push(request));
    harness.children[0]?.say({ type: "open-port-settings", preferences: { theme: "dark" }, route: "/reports" });
    harness.children[0]?.say({ type: "open-port-settings" });
    await settle();
    expect(seen).toEqual([{ preferences: { theme: "dark" }, route: "/reports" }, {}]);
    stop();
    harness.children[0]?.say({ type: "open-port-settings" });
    expect(seen).toHaveLength(2);
  });

  it("is ignored when nobody listens", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(startRequest());
    harness.children[0]?.say({ type: "open-port-settings" });
    expect(harness.supervisor.running).toBeDefined();
  });
});
