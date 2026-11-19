// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { describe, expect, it } from "vitest";
import { createRestore, type RestoreOptions } from "../../apps/desktop/src/main/restore.js";

/**
 * The main-process controller behind 「從備份還原」, with a fake supervisor and backend: what is refused and why, what is
 * stopped (nothing, until the user confirmed), that a failed restore brings the original backend back and that the page only
 * ever holds one-time ids. All values are synthetic.
 */

const DATABASE = "/synthetic/data/work-intelligence.sqlite";
const WINDOW = 3;

type ItemStatus = "ok" | "newer-schema" | "corrupt" | "not-database";
type RestoreStatus = "ok" | "in-use" | "locked" | "corrupt" | "failed";

interface Setup {
  readonly noDatabase?: boolean;
  readonly items?: ReadonlyArray<{ fileName: string; status: ItemStatus }>;
  readonly chosen?: string | null;
  readonly operation?: boolean;
  readonly busyActivity?: boolean;
  readonly agents?: boolean;
  readonly confirm?: boolean;
  readonly restore?: RestoreStatus;
  /** The operation's start after a replacement fails (the new database does not start). */
  readonly startFails?: boolean;
  /** The restore child was sent the request and gave no verdict (it crashed or ended). */
  readonly noVerdict?: boolean;
  /** The database file as the restore found it, and after: what the controller compares when there was no verdict. */
  readonly fingerprints?: readonly [string | null, string | null];
  /** Another page action takes the lock while the second busy check waits for the backend's activity report. */
  readonly lockDuringLateCheck?: boolean;
  readonly restart?: { ok: true } | { ok: false; code: string };
  /** The project folders the backup records (old computer); present: the controller asks about the ones not found here. */
  readonly roots?: readonly string[];
  /** The user's answers to the native question, in order, and the folders the chooser returns, in order. */
  readonly relocateChoices?: readonly ("choose" | "skip" | "cancel")[];
  readonly folders?: readonly (string | null)[];
  /** Folders that exist on this computer. */
  readonly existing?: readonly string[];
}

function setup(options: Setup = {}) {
  const events: string[] = [];
  const confirmations: unknown[] = [];
  const restoreRequests: unknown[] = [];
  const inspectRequests: Array<Record<string, unknown>> = [];
  let running: { port: number } | undefined = { port: 43_100 };
  let cleared = 0;
  const failures: string[] = [];
  let fingerprintCalls = 0;
  let activityCalls = 0;
  const relocations: unknown[] = [];
  let folderCalls = 0;
  const state = {
    busy: false,
    locale: "en" as const,
    databasePath: () => (options.noDatabase ? null : DATABASE),
    backupDirectory: () => null,
    touch: () => events.push("touch"),
  };
  const items = options.items ?? [{ fileName: "good.sqlite", status: "ok" as const }];
  const controllerOptions = {
    state,
    coordinator: { current: () => (options.operation ? { kind: "legacy-disable" } : null) },
    supervisor: {
      get running() {
        return running;
      },
      queryActivity: async () => {
        activityCalls += 1;
        if (options.lockDuringLateCheck && activityCalls === 2) state.busy = true;
        return options.busyActivity
          ? { status: "known" as const, busy: ["import" as const], pendingImport: false }
          : { status: "known" as const, busy: [], pendingImport: false };
      },
      inspectBackups: async (request: Record<string, unknown>) => {
        inspectRequests.push(request);
        const files = request.files as string[] | undefined;
        const list = files
          ? files.map((file) => ({
              fileName: file.split("/").pop() as string,
              status: options.items?.[0]?.status ?? ("ok" as const),
            }))
          : items;
        return {
          outcome: "checked" as const,
          result: {
            type: "inspect-result",
            directoryReadable: true,
            items: list.map((item) => ({
              path: `/synthetic/backups/${item.fileName}`,
              fileName: item.fileName,
              kind: "manual",
              createdAt: "2026-01-02T03:04:05.000Z",
              bytes: 4096,
              status: item.status,
              ...(item.status === "ok" ? { schemaVersion: 9, projects: 2, sessions: 5 } : {}),
            })),
          },
        };
      },
      backupRoots: async () => ({
        outcome: "checked" as const,
        result: {
          type: "backup-roots-result",
          status: "ok",
          roots: (options.roots ?? []).map((path) => ({ path, name: "" })),
        },
      }),
      restoreDatabase: async (request: unknown) => {
        events.push("replace");
        restoreRequests.push(request);
        if (options.noVerdict) return { outcome: "unknown" as const, code: "CHILD_EXITED", detail: "the child ended" };
        const status = options.restore ?? "ok";
        return {
          outcome: "checked" as const,
          result: {
            type: "restore-result",
            status,
            ...(status === "ok"
              ? {
                  safetyBackup: "safety.sqlite",
                  projects: 2,
                  sessions: 5,
                  schemaVersion: 9,
                  ...(options.roots ? { remappedProjects: restoreRemapCount(request) } : {}),
                }
              : {}),
          },
        };
      },
    },
    backend: {
      restoreWhileStopped: async (replace: (context: unknown) => Promise<unknown>) => {
        events.push("stop");
        running = undefined;
        try {
          await replace({ markMigrationStarted: async () => events.push("point-of-no-return") });
        } catch {
          // A refused replacement: the original database is untouched and the backend stays stopped for the caller.
          return { ok: false as const, code: "RESTORE_FAILED" };
        }
        if (options.startFails) return { ok: false as const, code: "DB_INTEGRITY_CHECK_FAILED" };
        events.push("start");
        running = { port: 43_100 };
        return { ok: true as const };
      },
      start: async (kind: string) => {
        events.push(`start-${kind}`);
        const outcome = options.restart ?? { ok: true as const };
        if (outcome.ok) running = { port: 43_100 };
        return outcome;
      },
      presenter: () => ({ clear: () => (cleared += 1), present: (code: string) => failures.push(`present:${code}`) }),
      recovery: { cancel: () => events.push("cancel-recovery"), handleFailure: (code: string) => failures.push(code) },
    },
    fingerprint: () => {
      const [before, after] = options.fingerprints ?? [null, null];
      fingerprintCalls += 1;
      return fingerprintCalls === 1 ? before : after;
    },
    agentsRunning: async () => options.agents === true,
    ...(options.roots
      ? {
          relocate: async (details: unknown) => {
            relocations.push(details);
            return options.relocateChoices?.[relocations.length - 1] ?? "skip";
          },
          chooseFolder: async () => options.folders?.[folderCalls++] ?? null,
          directoryExists: async (folder: string) => (options.existing ?? []).includes(folder),
        }
      : {}),
    chooseFile: async () => (options.chosen === undefined ? "/synthetic/backups/chosen.sqlite" : options.chosen),
    confirm: async (details: unknown) => {
      events.push("confirm");
      confirmations.push(details);
      return options.confirm ?? true;
    },
    backupsChanged: () => events.push("backups-changed"),
    log: () => undefined,
  };
  const controller = createRestore(controllerOptions as unknown as RestoreOptions);
  return {
    controller,
    events,
    state,
    confirmations,
    relocations,
    restoreRequests,
    inspectRequests,
    failures,
    cleared: () => cleared,
    isRunning: () => running !== undefined,
  };
}

function restoreRemapCount(request: unknown): number {
  return ((request as { remap?: unknown[] }).remap ?? []).length;
}

async function firstListedId(controller: ReturnType<typeof setup>["controller"]): Promise<string> {
  const listed = await controller.list(WINDOW);
  if (!listed.ok) throw new Error("list failed");
  const id = listed.backups.find((backup) => backup.backupId !== undefined)?.backupId;
  if (id === undefined) throw new Error("no restorable backup listed");
  return id;
}

describe("listing and choosing backups", () => {
  it("issues ids only for restorable backups, and never shows a path", async () => {
    const { controller } = setup({
      items: [
        { fileName: "good.sqlite", status: "ok" },
        { fileName: "newer.sqlite", status: "newer-schema" },
        { fileName: "broken.sqlite", status: "corrupt" },
      ],
    });
    const listed = await controller.list(WINDOW);
    if (!listed.ok) throw new Error("expected ok");
    expect(listed.backups.map((backup) => [backup.fileName, backup.problem, backup.backupId !== undefined])).toEqual([
      ["good.sqlite", null, true],
      ["newer.sqlite", "newer-schema", false],
      ["broken.sqlite", "corrupt", false],
    ]);
    expect(JSON.stringify(listed)).not.toContain("/synthetic");
  });

  it("is reachable with no database: nothing listed, nothing asked of the child", async () => {
    const { controller, inspectRequests } = setup({ noDatabase: true });
    expect(await controller.list(WINDOW)).toMatchObject({ ok: true, noDatabase: true, backups: [] });
    expect(inspectRequests).toEqual([]);
  });

  it("reports running Agents with the list", async () => {
    const listed = await setup({ agents: true }).controller.list(WINDOW);
    expect(listed).toMatchObject({ ok: true, agentsRunning: true });
  });

  it("refuses a chosen file that is not restorable, before any confirmation", async () => {
    for (const status of ["newer-schema", "corrupt", "not-database"] as const) {
      const { controller, confirmations } = setup({ items: [{ fileName: "x", status }] });
      expect(await controller.pick(WINDOW)).toMatchObject({ ok: false, reason: status });
      expect(confirmations).toEqual([]);
    }
  });

  it("returns a cancelled chooser as cancelled, and a good file as an id without its path", async () => {
    expect(await setup({ chosen: null }).controller.pick(WINDOW)).toEqual({ ok: false, reason: "cancelled" });
    const picked = await setup().controller.pick(WINDOW);
    if (!picked.ok) throw new Error("expected ok");
    expect(picked.backup.backupId).toBeDefined();
    expect(JSON.stringify(picked)).not.toContain("/synthetic");
  });
});

describe("running a restore", () => {
  it("confirms first, then stops, replaces, starts, and reports the counts and the safety backup", async () => {
    const { controller, events, confirmations, restoreRequests } = setup();
    const id = await firstListedId(controller);
    const result = await controller.run(WINDOW, id);
    expect(result).toEqual({ ok: true, safetyBackup: "safety.sqlite", projects: 2, sessions: 5 });
    expect(events.indexOf("confirm")).toBeLessThan(events.indexOf("stop"));
    expect(events.filter((event) => ["stop", "replace", "start"].includes(event))).toEqual([
      "stop",
      "replace",
      "start",
    ]);
    expect(confirmations).toEqual([expect.objectContaining({ database: null, size: expect.any(String) })]);
    expect(restoreRequests).toEqual([
      expect.objectContaining({ source: "/synthetic/backups/good.sqlite", databasePath: DATABASE }),
    ]);
  });

  it("uses a token only once", async () => {
    const { controller } = setup();
    const id = await firstListedId(controller);
    await controller.run(WINDOW, id);
    expect(await controller.run(WINDOW, id)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses an id of another window", async () => {
    const { controller, events } = setup();
    const id = await firstListedId(controller);
    expect(await controller.run(WINDOW + 1, id)).toMatchObject({ ok: false, reason: "expired" });
    expect(events).toEqual([]);
  });

  it("says the real reason it is busy and stops nothing", async () => {
    const operation = setup({ operation: true });
    expect(await operation.controller.run(WINDOW, await firstListedId(operation.controller))).toMatchObject({
      ok: false,
      reason: "busy",
      busy: { source: "operation", operation: "legacy-disable" },
    });
    const activity = setup({ busyActivity: true });
    expect(await activity.controller.run(WINDOW, await firstListedId(activity.controller))).toMatchObject({
      ok: false,
      reason: "busy",
      busy: { source: "activity", activities: ["import"] },
    });
    expect(operation.events).toEqual([]);
    expect(activity.events).toEqual([]);
  });

  it("refuses while an Agent runs: no dialog, nothing stopped, and the id can be used again", async () => {
    const { controller, events, confirmations } = setup({ agents: true });
    const id = await firstListedId(controller);
    expect(await controller.run(WINDOW, id)).toMatchObject({ ok: false, reason: "agents-running", dataIntact: true });
    expect(confirmations).toEqual([]);
    expect(events).toEqual([]);
    expect(await controller.run(WINDOW, id)).toMatchObject({ reason: "agents-running" });
  });

  it("stops nothing when the user cancels the confirmation", async () => {
    const { controller, events } = setup({ confirm: false });
    expect(await controller.run(WINDOW, await firstListedId(controller))).toMatchObject({
      ok: false,
      reason: "cancelled",
    });
    expect(events).toEqual(["confirm"]);
  });

  it.each(["locked", "in-use", "failed"] as const)(
    "a refused replacement (%s) leaves the data alone and brings the original backend back",
    async (restore) => {
      const { controller, events, isRunning, state } = setup({ restore });
      const id = await firstListedId(controller);
      const result = await controller.run(WINDOW, id);
      expect(result).toMatchObject({ ok: false, dataIntact: true, backendRunning: true });
      expect(events).toContain("start-restart");
      expect(isRunning()).toBe(true);
      expect(state.busy).toBe(false);
      // A lock or a running Agent may pass: the same id can be tried again.
      expect(await controller.run(WINDOW, id)).toMatchObject({ ok: false });
    },
  );

  it("a corrupt backup stays refused, and the original backend still comes back", async () => {
    const { controller, isRunning } = setup({ restore: "corrupt" });
    const id = await firstListedId(controller);
    expect(await controller.run(WINDOW, id)).toMatchObject({ ok: false, reason: "corrupt", dataIntact: true });
    expect(isRunning()).toBe(true);
    expect(await controller.run(WINDOW, id)).toMatchObject({ reason: "expired" });
  });

  it("reports the backend as not running when it cannot be brought back, with the data still intact", async () => {
    const { controller, failures } = setup({ restore: "locked", restart: { ok: false, code: "REPAIR_REQUIRED" } });
    expect(await controller.run(WINDOW, await firstListedId(controller))).toMatchObject({
      ok: false,
      reason: "locked",
      dataIntact: true,
      backendRunning: false,
    });
    expect(failures).toContain("REPAIR_REQUIRED");
  });

  it("claims nothing when the restore child gave no verdict and the database cannot be shown unchanged", async () => {
    for (const fingerprints of [undefined, ["a", "b"], ["a", null]] as const) {
      const { controller, isRunning, state } = setup({ noVerdict: true, ...(fingerprints ? { fingerprints } : {}) });
      const id = await firstListedId(controller);
      const result = await controller.run(WINDOW, id);
      expect(result).toMatchObject({ ok: false, reason: "outcome-unknown", dataIntact: false });
      expect(isRunning()).toBe(true);
      expect(state.busy).toBe(false);
      // The token is spent: the list is read again for a new one.
      expect(await controller.run(WINDOW, id)).toMatchObject({ reason: "expired" });
    }
  });

  it("calls the original kept after a silent child only when the file is provably the same", async () => {
    const { controller } = setup({ noVerdict: true, fingerprints: ["same", "same"] });
    expect(await controller.run(WINDOW, await firstListedId(controller))).toMatchObject({
      ok: false,
      reason: "failed",
      dataIntact: true,
    });
  });

  it("does not take, or clear, the lock of a page action that started during the last busy check", async () => {
    const { controller, state, events } = setup({ lockDuringLateCheck: true });
    const result = await controller.run(WINDOW, await firstListedId(controller));
    expect(result).toMatchObject({ ok: false, reason: "busy", busy: { source: "page-action" } });
    expect(state.busy).toBe(true);
    expect(events).not.toContain("stop");
  });

  it("when the restored database does not start, says so and points to the safety backup", async () => {
    const { controller } = setup({ startFails: true });
    expect(await controller.run(WINDOW, await firstListedId(controller))).toMatchObject({
      ok: false,
      reason: "start-failed",
      dataIntact: false,
      safetyBackup: "safety.sqlite",
      errorCode: "DB_INTEGRITY_CHECK_FAILED",
    });
  });
});

describe("restoring on a new computer: project folders that are not here", () => {
  const OLD = ["/old/home/work/alpha", "/old/home/work/beta"];

  it("asks, lets the user choose the new place, and restores with the matching folders moved", async () => {
    const { controller, relocations, restoreRequests, confirmations } = setup({
      roots: OLD,
      relocateChoices: ["choose"],
      folders: ["/new/work"],
      existing: ["/new/work/alpha", "/new/work/beta"],
    });
    const result = await controller.run(WINDOW, await firstListedId(controller));
    expect(relocations).toEqual([{ total: 2, missing: 2, mapped: 0, noMatch: false }]);
    expect(restoreRequests).toMatchObject([
      {
        remap: [
          { from: "/old/home/work/alpha", to: "/new/work/alpha" },
          { from: "/old/home/work/beta", to: "/new/work/beta" },
        ],
      },
    ]);
    expect(confirmations).toMatchObject([{ remapped: 2 }]);
    expect(result).toMatchObject({ ok: true, remapped: 2 });
  });

  it("asks again for what is still missing, and says when a folder matched nothing", async () => {
    const { controller, relocations, restoreRequests } = setup({
      roots: OLD,
      relocateChoices: ["choose", "choose", "skip"],
      folders: ["/elsewhere", "/new/work"],
      existing: ["/new/work/alpha"],
    });
    await controller.run(WINDOW, await firstListedId(controller));
    expect(relocations).toEqual([
      { total: 2, missing: 2, mapped: 0, noMatch: false },
      { total: 2, missing: 2, mapped: 0, noMatch: true },
      { total: 2, missing: 1, mapped: 1, noMatch: false },
    ]);
    expect(restoreRequests).toMatchObject([{ remap: [{ from: "/old/home/work/alpha", to: "/new/work/alpha" }] }]);
  });

  it("restores with the old paths when the user says so, and stops nothing when the user cancels", async () => {
    const skipped = setup({ roots: OLD, relocateChoices: ["skip"] });
    await skipped.controller.run(WINDOW, await firstListedId(skipped.controller));
    expect((skipped.restoreRequests[0] as { remap?: unknown }).remap).toBeUndefined();

    const cancelled = setup({ roots: OLD, relocateChoices: ["cancel"] });
    expect(await cancelled.controller.run(WINDOW, await firstListedId(cancelled.controller))).toMatchObject({
      ok: false,
      reason: "cancelled",
      dataIntact: true,
    });
    expect(cancelled.events).not.toContain("stop");
  });

  it("does not ask when every recorded folder exists here", async () => {
    const { controller, relocations } = setup({ roots: OLD, existing: OLD });
    await controller.run(WINDOW, await firstListedId(controller));
    expect(relocations).toEqual([]);
  });
});
