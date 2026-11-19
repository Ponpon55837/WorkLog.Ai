// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { describe, expect, it } from "vitest";
import { createBackupDirectory } from "../../apps/desktop/src/main/backup-directory.js";
import {
  backupDirectoryMessages,
  backupDirectoryResultText,
  backupDirectoryVerdict,
} from "../../packages/desktop-core/src/index.js";

/**
 * The controller behind 「更換備份位置」 with fake dialogs and a fake backend: the folder is proved writable and classified
 * before anything is written, a network drive is refused, a risky one needs a yes, the service restarts to use the folder and
 * the old folder comes back when that fails. Old backups are never touched. All values are synthetic.
 */

const OLD = "/synthetic/backups";
const NEW = "/synthetic/elsewhere/backups";

interface Setup {
  readonly chosen?: string | null;
  readonly writable?: boolean;
  readonly risk?: "none" | "network" | "removable" | "cloud-sync" | "unknown";
  readonly confirmRisk?: boolean;
  readonly operation?: boolean;
  readonly busyActivity?: boolean;
  readonly stopped?: boolean;
  /** Restart results in order; the default is one success. */
  readonly restarts?: readonly ({ ok: true } | { ok: false; code: string } | { ok: false; busy: true })[];
}

function setup(options: Setup = {}) {
  const events: string[] = [];
  const written: string[] = [];
  let folder = OLD;
  let running = options.stopped ? undefined : { port: 43_100 };
  const restarts = [...(options.restarts ?? [{ ok: true as const }])];
  const state = {
    settings: { desired: { backupDirectory: OLD } },
    backupDirectory: () => folder,
    touch: () => events.push("touch"),
    updateSettings: async (_file: string, mutate: (current: { desired: { backupDirectory: string } }) => unknown) => {
      const next = mutate({ desired: { backupDirectory: folder } }) as { desired: { backupDirectory: string } } | null;
      if (next) {
        folder = next.desired.backupDirectory;
        written.push(folder);
      }
    },
  };
  const controller = createBackupDirectory({
    state: state as never,
    paths: { settingsFile: "/synthetic/settings.json" },
    coordinator: { current: () => (options.operation ? ({ kind: "restore" } as never) : null) },
    supervisor: {
      get running() {
        return running as never;
      },
      queryActivity: async () => ({
        status: "known" as const,
        busy: options.busyActivity ? ["import" as const] : [],
        pendingImport: false,
      }),
    },
    backend: {
      start: async () => {
        events.push("restart");
        const next = restarts.shift() ?? { ok: true as const };
        if (next.ok) running = { port: 43_100 };
        else running = undefined;
        return next as never;
      },
      presenter: () => ({ clear: () => events.push("clear") }) as never,
      recovery: { cancel: () => events.push("cancel-retry"), handleFailure: () => events.push("repair") } as never,
    },
    classify: async () => ({ risk: options.risk ?? "none" }),
    chooseFolder: async () => (options.chosen === undefined ? NEW : options.chosen),
    confirmRisk: async () => {
      events.push("confirm-risk");
      return options.confirmRisk !== false;
    },
    probeWritable: async () => options.writable !== false,
    homeDirectory: "/synthetic",
    platform: "linux",
    backupsChanged: () => events.push("backups"),
    log: () => undefined,
  });
  return { controller, events, written, folder: () => folder };
}

describe("backup folder policy", () => {
  it("refuses a network drive, asks about external, cloud-synced and hard-linked folders, and accepts the rest", () => {
    expect(backupDirectoryVerdict("network")).toBe("refuse");
    for (const risk of ["removable", "cloud-sync", "hard-link"] as const)
      expect(backupDirectoryVerdict(risk)).toBe("confirm");
    for (const risk of ["none", "unknown", undefined] as const) expect(backupDirectoryVerdict(risk)).toBe("use");
  });
});

describe("backup directory controller", () => {
  it("shows the folder with the home directory masked", () => {
    expect(setup().controller.section()).toEqual({ display: "~/backups" });
  });

  it("changes the folder, restarts the service to use it and says the old backups stayed", async () => {
    const run = setup();
    expect(await run.controller.choose()).toEqual({
      ok: true,
      display: "~/elsewhere/backups",
      existingBackupsStayed: true,
    });
    expect(run.written).toEqual([NEW]);
    expect(run.events).toEqual(expect.arrayContaining(["cancel-retry", "restart", "backups"]));
  });

  it("writes only the settings when the service is not running, and no restart is needed", async () => {
    const run = setup({ stopped: true });
    expect(await run.controller.choose()).toMatchObject({ ok: true });
    expect(run.events).not.toContain("restart");
  });

  it("changes nothing when cancelled, not writable, or refused as a network drive", async () => {
    expect(await setup({ chosen: null }).controller.choose()).toEqual({ ok: false, reason: "cancelled" });
    expect(await setup({ writable: false }).controller.choose()).toEqual({ ok: false, reason: "not-writable" });
    const network = setup({ risk: "network" });
    expect(await network.controller.choose()).toEqual({ ok: false, reason: "refused", risk: "network" });
    for (const run of [network]) expect(run.written).toEqual([]);
  });

  it("asks before a risky folder, and a no changes nothing", async () => {
    const declined = setup({ risk: "removable", confirmRisk: false });
    expect(await declined.controller.choose()).toEqual({ ok: false, reason: "declined", risk: "removable" });
    expect(declined.written).toEqual([]);
    const accepted = setup({ risk: "cloud-sync" });
    expect(await accepted.controller.choose()).toMatchObject({ ok: true });
    expect(accepted.events).toContain("confirm-risk");
    const unknown = setup({ risk: "unknown" });
    await unknown.controller.choose();
    expect(unknown.events).not.toContain("confirm-risk");
  });

  it("refuses while an operation runs or the service does import or backup work, before any dialog", async () => {
    const operation = setup({ operation: true });
    expect(await operation.controller.choose()).toMatchObject({
      ok: false,
      reason: "busy",
      busy: { source: "operation", operation: "restore" },
    });
    const activity = setup({ busyActivity: true });
    expect(await activity.controller.choose()).toMatchObject({
      ok: false,
      reason: "busy",
      busy: { source: "activity" },
    });
    for (const run of [operation, activity]) expect(run.written).toEqual([]);
  });

  it("puts the old folder back when the restart fails, and brings the service back", async () => {
    const run = setup({ restarts: [{ ok: false, code: "DB_OFFLINE" }, { ok: true }] });
    expect(await run.controller.choose()).toEqual({ ok: false, reason: "failed", backendRunning: true });
    expect(run.written).toEqual([NEW, OLD]);
    expect(run.folder()).toBe(OLD);
  });

  it("goes to repair when the service cannot start again either, without touching data", async () => {
    const run = setup({
      restarts: [
        { ok: false, code: "DB_OFFLINE" },
        { ok: false, code: "DB_OFFLINE" },
      ],
    });
    expect(await run.controller.choose()).toEqual({ ok: false, reason: "start-failed", backendRunning: false });
    expect(run.events).toContain("repair");
    expect(run.folder()).toBe(OLD);
  });
});

describe("backup directory texts", () => {
  it("states in both languages that old backups are not moved, and what each refusal means", () => {
    for (const locale of ["en", "zh-TW"] as const) {
      const text = backupDirectoryMessages(locale);
      expect(text.notMoved.length).toBeGreaterThan(20);
      expect(
        backupDirectoryResultText(text, locale, { ok: true, display: "~/b", existingBackupsStayed: true }, ""),
      ).toContain("~/b");
      expect(
        backupDirectoryResultText(text, locale, { ok: false, reason: "refused", risk: "network" }, "NET"),
      ).toContain("NET");
    }
  });
});
