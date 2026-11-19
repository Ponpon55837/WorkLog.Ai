// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { describe, expect, it } from "vitest";
import { createMaintenance, maintenanceFailureOf } from "../../apps/desktop/src/main/maintenance.js";
import {
  maintenanceFailureText,
  maintenanceMessages,
  maintenanceSuccessText,
  reclaimableText,
} from "../../packages/desktop-core/src/shell/maintenance-i18n.js";

/**
 * The controller behind 「整理資料庫」 with a fake supervisor and backend: what is refused (and that nothing is stopped
 * before the user confirmed), that a failed run brings the backend back, and that the check never stops the service.
 * All values are synthetic.
 */

const DATABASE = "/synthetic/data/work-intelligence.sqlite";

type ChildStatus = "ok" | "in-use" | "missing" | "invalid" | "integrity-failed" | "backup-failed" | "failed";

interface Setup {
  readonly noDatabase?: boolean;
  readonly operation?: boolean;
  readonly agents?: boolean;
  readonly confirm?: boolean;
  readonly child?: ChildStatus;
  readonly noVerdict?: boolean;
  readonly startFails?: boolean;
  readonly fingerprints?: readonly [string | null, string | null];
}

function setup(options: Setup = {}) {
  const events: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  let running: { port: number } | undefined = { port: 43_100 };
  let fingerprintCalls = 0;
  const state = {
    busy: false,
    busyAction: null as string | null,
    locale: "en" as const,
    databasePath: () => (options.noDatabase ? null : DATABASE),
    backupDirectory: () => null,
    touch: () => events.push("touch"),
  };
  const controller = createMaintenance({
    state: state as never,
    coordinator: { current: () => (options.operation ? ({ kind: "restore" } as never) : null) },
    supervisor: {
      get running() {
        return running as never;
      },
      queryActivity: async () => ({ status: "known" as const, busy: [], pendingImport: false }),
      queryMaintenanceHint: async () => ({
        status: "known" as const,
        reclaimableBytes: 8_000_000,
        databaseBytes: 20_000_000,
        suggest: true,
        last: { status: "completed" as const, at: "2026-01-02T03:04:05.000Z" },
      }),
      maintainDatabase: async (request: Record<string, unknown>) => {
        events.push(`maintain:${String(request.mode)}`);
        requests.push(request);
        if (options.noVerdict) return { outcome: "unknown" as const, code: "CHILD_EXITED", detail: "ended" } as never;
        const status = options.child ?? "ok";
        return {
          outcome: "checked" as const,
          result: {
            type: "maintain-result",
            mode: request.mode,
            status,
            ...(status === "ok" && request.mode === "maintain"
              ? { backupFileName: "before-maintenance.sqlite", reclaimedBytes: 4_000_000 }
              : {}),
          },
        } as never;
      },
    },
    backend: {
      maintainWhileStopped: async (work: (context: unknown) => Promise<unknown>) => {
        events.push("stop");
        running = undefined;
        try {
          await work({ markMigrationStarted: async () => undefined });
        } catch {
          return { ok: false as const, code: "REPAIR_REQUIRED" };
        }
        if (options.startFails) return { ok: false as const, code: "DB_OFFLINE" };
        events.push("start");
        running = { port: 43_100 };
        return { ok: true as const };
      },
      start: async () => {
        events.push("restart");
        running = { port: 43_100 };
        return { ok: true as const };
      },
      presenter: () => ({ clear: () => undefined, present: () => undefined }) as never,
      recovery: { cancel: () => events.push("cancel-retry"), handleFailure: () => undefined } as never,
    },
    agentsRunning: async () => options.agents === true,
    confirm: async () => {
      events.push("confirm");
      return options.confirm !== false;
    },
    backupsChanged: () => events.push("backups"),
    changed: () => events.push("changed"),
    fingerprint: () => {
      const pair = options.fingerprints ?? ["a", "a"];
      return pair[Math.min(fingerprintCalls++, 1)] ?? null;
    },
    log: () => undefined,
  });
  return { controller, events, requests, state };
}

describe("maintenance controller: refusals stop nothing", () => {
  it("refuses without a database, while an operation runs, and while an Agent is connected", async () => {
    expect(await setup({ noDatabase: true }).controller.run("maintain")).toMatchObject({
      ok: false,
      reason: "no-database",
    });
    const busy = setup({ operation: true });
    expect(await busy.controller.run("maintain")).toMatchObject({
      ok: false,
      reason: "busy",
      busy: { source: "operation", operation: "restore" },
    });
    const agents = setup({ agents: true });
    expect(await agents.controller.run("maintain")).toMatchObject({ ok: false, reason: "agents-running" });
    for (const run of [busy, agents]) expect(run.events).not.toContain("stop");
  });

  it("refuses while another page action holds the lock, and asks first: a cancelled confirmation stops nothing", async () => {
    const held = setup();
    held.state.busy = true;
    expect(await held.controller.run("maintain")).toMatchObject({
      ok: false,
      reason: "busy",
      busy: { source: "page-action" },
    });
    const declined = setup({ confirm: false });
    expect(await declined.controller.run("maintain")).toMatchObject({
      ok: false,
      reason: "cancelled",
      dataIntact: true,
    });
    expect(declined.events).toEqual(["confirm"]);
  });
});

describe("maintenance controller: a run", () => {
  it("stops, maintains (which backs up first), starts again and reports the backup and the saved space", async () => {
    const run = setup();
    expect(await run.controller.run("maintain")).toEqual({
      ok: true,
      mode: "maintain",
      backupFileName: "before-maintenance.sqlite",
      reclaimedBytes: 4_000_000,
    });
    expect(
      run.events.filter((event) =>
        ["confirm", "cancel-retry", "stop", "maintain:maintain", "start", "backups"].includes(event),
      ),
    ).toEqual(["confirm", "cancel-retry", "stop", "maintain:maintain", "start", "backups"]);
    expect(run.state.busy).toBe(false);
    expect(run.state.busyAction).toBeNull();
  });

  it("brings the backend back on the unchanged database when the work was refused", async () => {
    for (const [child, reason] of [
      ["in-use", "in-use"],
      ["backup-failed", "backup-failed"],
      ["invalid", "invalid"],
    ] as const) {
      const run = setup({ child });
      expect(await run.controller.run("maintain")).toMatchObject({
        ok: false,
        reason,
        dataIntact: true,
        backendRunning: true,
      });
      expect(run.events).toContain("restart");
    }
  });

  it("does not claim intact data after an integrity failure, and says so when the service cannot start again", async () => {
    expect(await setup({ child: "integrity-failed" }).controller.run("maintain")).toMatchObject({
      reason: "integrity-failed",
      dataIntact: false,
    });
    expect(await setup({ startFails: true }).controller.run("maintain")).toMatchObject({
      ok: false,
      reason: "start-failed",
      dataIntact: false,
      backendRunning: false,
    });
  });

  it("with no verdict, calls the data unchanged only when the file is provably the same", async () => {
    expect(await setup({ noVerdict: true, fingerprints: ["a", "a"] }).controller.run("maintain")).toMatchObject({
      reason: "failed",
      dataIntact: true,
    });
    expect(await setup({ noVerdict: true, fingerprints: ["a", "b"] }).controller.run("maintain")).toMatchObject({
      reason: "outcome-unknown",
      dataIntact: false,
    });
  });
});

describe("maintenance controller: the read-only check", () => {
  it("runs beside the serving backend without asking or stopping, and remembers its answer", async () => {
    const run = setup();
    expect(await run.controller.run("check")).toEqual({ ok: true, mode: "check" });
    expect(run.events).not.toContain("stop");
    expect(run.events).not.toContain("confirm");
    expect(run.controller.section().check).toMatchObject({ ok: true });
    const bad = setup({ child: "integrity-failed" });
    expect(await bad.controller.run("check")).toMatchObject({ ok: false, reason: "integrity-failed" });
    expect(bad.controller.section().check).toMatchObject({ ok: false });
  });
});

describe("maintenance controller: the section", () => {
  it("answers at once, then shows the free space and the last run once the backend has answered", async () => {
    const run = setup();
    expect(run.controller.section()).toMatchObject({ reclaimableBytes: null, suggest: false, last: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run.controller.section()).toMatchObject({
      reclaimableBytes: 8_000_000,
      databaseBytes: 20_000_000,
      suggest: true,
      last: { status: "completed" },
    });
    expect(run.events).toContain("changed");
  });
});

describe("maintenance texts", () => {
  it("maps every child status, and says what happened to the data", () => {
    expect(maintenanceFailureOf({ outcome: "failed", code: "X", detail: "" } as never)).toBe("failed");
    const text = maintenanceMessages("en");
    expect(
      maintenanceFailureText(text, "en", {
        ok: false,
        mode: "maintain",
        reason: "agents-running",
        dataIntact: true,
        backendRunning: true,
      }),
    ).toContain(text.dataIntact);
    expect(
      maintenanceFailureText(text, "en", {
        ok: false,
        mode: "maintain",
        reason: "failed",
        dataIntact: false,
        backendRunning: false,
      }),
    ).toContain(text.notRunning);
    expect(
      maintenanceSuccessText(text, {
        ok: true,
        mode: "maintain",
        backupFileName: "b.sqlite",
        reclaimedBytes: 2_000_000,
      }),
    ).toContain("b.sqlite");
    expect(reclaimableText(maintenanceMessages("zh-TW"), 8_000_000, true)).toContain("建議整理");
  });
});
