// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { describe, expect, it } from "vitest";
import { createChangePort, type ChangePortOptions } from "../../apps/desktop/src/main/change-port.js";
import { PortHandoffStore, PORT_HANDOFF_TTL_MS } from "../../packages/desktop-core/src/index.js";

/**
 * The main-process controller behind 「變更連接埠」, with a fake supervisor, backend and OS: what is refused and why, what
 * is stopped (nothing, until the user confirmed), the rollback, and the single-use snapshot. All values are synthetic.
 */

const OLD = 43_100;
const NEW = 43_200;

interface Setup {
  readonly settings?: boolean;
  readonly running?: boolean;
  readonly operation?: boolean;
  readonly activity?: "idle" | "busy" | "unknown" | "busy-after-dialog";
  readonly probe?: { free: true } | { free: false; code: string };
  readonly dialog?: boolean;
  /** The start on the new port is refused before anything is stopped (the old backend keeps serving). */
  readonly refusedBeforeStopping?: boolean;
  readonly start?: Array<{ ok: true } | { ok: false; busy?: false; code: string } | { ok: false; busy: true }>;
  readonly restart?: { ok: true } | { ok: false; busy?: false; code: string } | { ok: false; busy: true } | "throws";
}

function setup(options: Setup = {}) {
  const events: string[] = [];
  const opened: Array<unknown> = [];
  let now = 0;
  let dialogDone = false;
  const handoff = new PortHandoffStore(() => now);
  const starts: unknown[] = [];
  const startOutcomes = [...(options.start ?? [{ ok: true as const }])];
  const failures: string[] = [];
  let cleared = 0;
  let shown = 0;
  let queries = 0;
  let running: { port: number } | undefined = options.running === false ? undefined : { port: OLD };
  const state = {
    settings: options.settings === false ? null : { desired: { port: OLD } },
    touch: () => events.push("touch"),
  };
  const controllerOptions = {
    state,
    coordinator: { current: () => (options.operation ? { kind: "legacy-disable" } : null) },
    supervisor: {
      get running() {
        return running;
      },
      queryActivity: async () => {
        queries += 1;
        const mode = options.activity ?? "idle";
        if (mode === "unknown") return { status: "unknown" as const };
        if (mode === "busy" || (mode === "busy-after-dialog" && dialogDone)) {
          return { status: "known" as const, busy: ["import" as const] };
        }
        return { status: "known" as const, busy: [] };
      },
    },
    backend: {
      startOnPort: async (change: unknown) => {
        events.push("start-new");
        starts.push(change);
        const outcome = startOutcomes.shift() ?? { ok: true as const };
        // A real managed start stops the old backend first; only a refusal before that leaves it serving.
        if (outcome.ok) running = { port: (change as { port: number }).port };
        else if (!options.refusedBeforeStopping) running = undefined;
        return outcome;
      },
      start: async (kind: string) => {
        events.push(`start-${kind}`);
        if (options.restart === "throws") throw new Error("boom");
        const restored = options.restart ?? { ok: true as const };
        if (restored.ok) running = { port: OLD };
        return restored;
      },
      presenter: () => ({ clear: () => (cleared += 1) }),
      recovery: { handleFailure: (code: string) => failures.push(code) },
    },
    probePort: async () => options.probe ?? { free: true as const },
    confirmDialog: async (from: number, to: number) => {
      events.push(`confirm ${from}->${to}`);
      dialogDone = true;
      return options.dialog ?? true;
    },
    handoff,
    openDashboard: (taken: unknown) => opened.push(taken),
    showSection: () => (shown += 1),
    log: () => undefined,
  };
  const controller = createChangePort(controllerOptions as unknown as ChangePortOptions);
  return {
    controller,
    events,
    opened,
    starts,
    failures,
    handoff,
    state,
    advance: (ms: number) => (now += ms),
    cleared: () => cleared,
    shown: () => shown,
    queries: () => queries,
  };
}

describe("the port change controller", () => {
  it("changes the port: confirm, one managed start, then the Dashboard opens at the new address", async () => {
    const { controller, events, starts, opened, cleared } = setup();
    expect(await controller.change(String(NEW))).toEqual({ ok: true, changed: true, port: NEW });
    expect(events).toEqual([`confirm ${OLD}->${NEW}`, "start-new", "touch"]);
    expect(starts).toEqual([{ port: NEW, from: OLD }]);
    expect(opened).toEqual([undefined]);
    expect(cleared()).toBe(1);
  });

  it("carries the Dashboard's preferences once: consumed by the first Dashboard it opens", async () => {
    const { controller, opened, handoff } = setup();
    controller.offer({ preferences: { theme: "dark", extra: 1 }, route: "/reports" });
    expect(controller.section()).toMatchObject({ port: OLD, activePort: OLD, handoffHeld: true, focus: true });
    await controller.change(NEW);
    expect(opened).toEqual([{ preferences: { theme: "dark" }, route: "/reports" }]);
    expect(handoff.holds()).toBe(false);
    await controller.change(NEW + 1);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toBeUndefined();
  });

  it("drops a snapshot older than two minutes", async () => {
    const { controller, opened, advance } = setup();
    controller.offer({ preferences: { theme: "dark" }, route: "/reports" });
    advance(PORT_HANDOFF_TTL_MS);
    expect(controller.section().handoffHeld).toBe(false);
    await controller.change(NEW);
    expect(opened).toEqual([undefined]);
  });

  it("opens the section for the tray item and for the Dashboard's request", () => {
    const { controller, shown } = setup();
    controller.openSection();
    controller.offer({});
    expect(shown()).toBe(2);
    expect(controller.section().focus).toBe(true);
  });

  it("reports a focus request in one state only, so a later page load does not scroll again", () => {
    const { controller } = setup();
    expect(controller.section().focus).toBe(false);
    controller.openSection();
    expect(controller.section().focus).toBe(true);
    expect(controller.section().focus).toBe(false);
    controller.offer({});
    expect(controller.section().focus).toBe(true);
    expect(controller.section().focus).toBe(false);
  });

  it("does nothing for the current port, and refuses an invalid one before anything runs", async () => {
    const { controller, events, queries } = setup();
    expect(await controller.change(OLD)).toEqual({ ok: true, changed: false, port: OLD });
    expect(await controller.change("80")).toEqual({ ok: false, reason: "invalid", problem: "below-1024" });
    expect(await controller.change("6667")).toEqual({ ok: false, reason: "invalid", problem: "browser-restricted" });
    expect(events).toEqual([]);
    expect(queries()).toBe(0);
  });

  it("refuses an occupied target and stops nothing", async () => {
    const { controller, events } = setup({ probe: { free: false, code: "EADDRINUSE" } });
    expect(await controller.change(NEW)).toEqual({ ok: false, reason: "occupied" });
    expect(events).toEqual([]);
  });

  it("refuses a target the OS does not allow, and stops nothing", async () => {
    const { controller, events } = setup({ probe: { free: false, code: "EACCES" } });
    expect(await controller.change(NEW)).toEqual({ ok: false, reason: "not-permitted" });
    expect(events).toEqual([]);
  });

  it("refuses while another operation runs", async () => {
    const { controller, events, queries } = setup({ operation: true });
    expect(await controller.change(NEW)).toEqual({ ok: false, reason: "busy", busy: "operation" });
    expect(events).toEqual([]);
    expect(queries()).toBe(0);
  });

  it("refuses while the backend imports, backs up or exports, and when it cannot be asked", async () => {
    const busy = setup({ activity: "busy" });
    expect(await busy.controller.change(NEW)).toEqual({ ok: false, reason: "busy", busy: "activity" });
    expect(busy.events).toEqual([]);
    const unknown = setup({ activity: "unknown" });
    expect(await unknown.controller.change(NEW)).toEqual({ ok: false, reason: "busy", busy: "unknown" });
    expect(unknown.events).toEqual([]);
  });

  it("asks the backend again after the confirmation, in case a job started meanwhile", async () => {
    const { controller, events } = setup({ activity: "busy-after-dialog" });
    expect(await controller.change(NEW)).toEqual({ ok: false, reason: "busy", busy: "activity" });
    expect(events).toEqual([`confirm ${OLD}->${NEW}`]);
  });

  it("does not ask a backend that is not running, and changes the port all the same", async () => {
    const { controller, queries } = setup({ running: false });
    expect(await controller.change(NEW)).toMatchObject({ ok: true, changed: true });
    expect(queries()).toBe(0);
  });

  it("changes nothing when the user cancels the native confirmation", async () => {
    const { controller, events } = setup({ dialog: false });
    expect(await controller.change(NEW)).toEqual({ ok: false, reason: "cancelled" });
    expect(events).toEqual([`confirm ${OLD}->${NEW}`]);
  });

  it("does not restart a backend a refused start left serving on the old port", async () => {
    const { controller, events, failures, cleared } = setup({
      start: [{ ok: false, code: "LEGACY_SERVICE_ACTIVE" }],
      refusedBeforeStopping: true,
    });
    expect(await controller.change(NEW)).toEqual({
      ok: false,
      reason: "failed",
      errorCode: "LEGACY_SERVICE_ACTIVE",
      rolledBack: true,
    });
    expect(events).toEqual([`confirm ${OLD}->${NEW}`, "start-new"]);
    expect(failures).toEqual([]);
    expect(cleared()).toBe(0);
  });

  it("restarts on the old port when the new one fails to start", async () => {
    const { controller, events, opened, cleared } = setup({ start: [{ ok: false, code: "PORT_OCCUPIED_BY_OTHER" }] });
    expect(await controller.change(NEW)).toEqual({
      ok: false,
      reason: "occupied",
      errorCode: "PORT_OCCUPIED_BY_OTHER",
      rolledBack: true,
    });
    expect(events).toEqual([`confirm ${OLD}->${NEW}`, "start-new", "start-restart"]);
    expect(opened).toEqual([]);
    expect(cleared()).toBe(1);
  });

  it("names a bind the OS refused, and any other failure, after the rollback", async () => {
    const denied = setup({ start: [{ ok: false, code: "PORT_NOT_PERMITTED" }] });
    expect(await denied.controller.change(NEW)).toMatchObject({ reason: "not-permitted", rolledBack: true });
    const other = setup({ start: [{ ok: false, code: "CHILD_EXITED" }] });
    expect(await other.controller.change(NEW)).toMatchObject({
      reason: "failed",
      errorCode: "CHILD_EXITED",
      rolledBack: true,
    });
  });

  it("goes to repair when the old port does not start either, and keeps the section usable", async () => {
    const { controller, failures, cleared } = setup({
      start: [{ ok: false, code: "CHILD_EXITED" }],
      restart: { ok: false, code: "PORT_OCCUPIED_BY_OTHER" },
    });
    expect(await controller.change(NEW)).toMatchObject({ ok: false, reason: "failed", rolledBack: false });
    expect(failures).toEqual(["PORT_OCCUPIED_BY_OTHER"]);
    expect(cleared()).toBe(0);
    expect(controller.section().port).toBe(OLD);
  });

  it("treats a restart that throws, or one that finds another operation, as not rolled back", async () => {
    const thrown = setup({ start: [{ ok: false, code: "CHILD_EXITED" }], restart: "throws" });
    expect(await thrown.controller.change(NEW)).toMatchObject({ rolledBack: false });
    expect(thrown.failures).toEqual(["REPAIR_REQUIRED"]);
    const busy = setup({ start: [{ ok: false, code: "CHILD_EXITED" }], restart: { ok: false, busy: true } });
    expect(await busy.controller.change(NEW)).toMatchObject({ rolledBack: false });
    expect(busy.failures).toEqual([]);
  });

  it("answers busy when the managed start finds another operation holding the lock", async () => {
    const { controller, opened } = setup({ start: [{ ok: false, busy: true }] });
    expect(await controller.change(NEW)).toEqual({ ok: false, reason: "busy", busy: "operation" });
    expect(opened).toEqual([]);
  });

  it("fails without settings", async () => {
    const { controller } = setup({ settings: false });
    expect(await controller.change(NEW)).toEqual({ ok: false, reason: "failed" });
    expect(controller.section()).toMatchObject({ port: null });
  });

  it("reports no active port while the backend is down", () => {
    expect(setup({ running: false }).controller.section()).toMatchObject({ port: OLD, activePort: null });
  });
});
