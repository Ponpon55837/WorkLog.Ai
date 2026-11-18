// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLegacyDisable, type LegacyDisableOptions } from "../../apps/desktop/src/main/legacy-disable.js";
import {
  legacyDefinitionDigest,
  type LegacyServiceDetection,
  type LegacyServiceFound,
} from "../../packages/desktop-core/src/legacy-service/index.js";

/**
 * The main-process controller behind 「停用舊的登入服務…」, with a fake OS, coordinator, supervisor and backend: what may
 * confirm, when the native dialog is asked, what the journal records, when the database is checked and what counts as
 * damage, and when 「立即啟動」 may start the backend. All data is synthetic.
 */

const DEFINITION = "<plist>synthetic definition</plist>\n";
const PORT = 43_210;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Preflight = "ok" | "damaged" | "locked" | "throws";

interface Setup {
  readonly platform?: LegacyServiceFound["platform"];
  readonly running?: LegacyServiceFound["running"];
  readonly sameDatabase?: boolean;
  readonly preflight?: Preflight;
  readonly dialog?: boolean;
  readonly ownBackendPort?: number;
  readonly port?: number;
  readonly portFree?: boolean;
  readonly windowsRunners?: number;
  readonly swapDefinitionAfterStop?: boolean;
}

function setup(options: Setup = {}) {
  const root = mkdtempSync(join(tmpdir(), "wi-legacy-controller-"));
  directories.push(root);
  const appDatabase = join(root, "app.sqlite");
  writeFileSync(appDatabase, "");
  const otherDatabase = join(root, "other.sqlite");
  writeFileSync(otherDatabase, "");
  const platform = options.platform ?? "linux";
  const definitionPath = join(root, "work-intelligence.service");
  const files = new Map([[definitionPath, DEFINITION]]);
  const detection: LegacyServiceFound = {
    kind: "found",
    platform,
    definitionPath,
    definitionSource: "file",
    recognised: true,
    repositoryRoot: platform === "win32" ? "C:\\synthetic\\checkout" : "/srv/synthetic-checkout",
    databasePath: options.sameDatabase === false ? otherDatabase : appDatabase,
    port: options.port ?? PORT,
    running: options.running ?? "running",
    enabled: "enabled",
    definitionDigest: legacyDefinitionDigest(DEFINITION),
  };
  const commands: string[] = [];
  const dialogs: boolean[] = [];
  const errors: string[] = [];
  const previews: Array<{ path: string; quickCheck?: boolean }> = [];
  const journal: unknown[] = [];
  const starts: string[] = [];
  let repairOpened = 0;
  const refresh = async (): Promise<LegacyServiceDetection> =>
    files.has(definitionPath) ? detection : { kind: "none" };

  const preflightResult = () => {
    switch (options.preflight ?? "ok") {
      case "ok":
        return { status: "ok" as const, identity: { synthetic: true } };
      case "damaged":
        return { status: "unreadable" as const, detail: "the database failed its integrity check" };
      case "locked":
        return { status: "unreadable" as const, detail: "the database file cannot be read" };
      default:
        return null;
    }
  };

  const controllerOptions = {
    state: {
      settings: {},
      needsSetup: false,
      launchMode: "interactive",
      owner: "desktop",
      databasePath: () => appDatabase,
      recentErrors: { record: (code: string) => errors.push(code) },
      candidates: { add: () => "candidate-1", setPreview: () => undefined },
      touch: () => undefined,
    },
    legacy: { refresh },
    coordinator: {
      current: () => null,
      run: async (request: unknown, steps: Array<{ run: (context: unknown) => Promise<unknown> }>) => {
        journal.push(request);
        let result: unknown = null;
        for (const step of steps)
          result = await step.run({ operationId: "synthetic", signal: new AbortController().signal });
        return { status: "completed", result };
      },
    },
    supervisor: {
      running: options.ownBackendPort === undefined ? undefined : { port: options.ownBackendPort },
      preview: async (path: string, previewOptions: { quickCheck?: boolean }) => {
        previews.push({ path, ...previewOptions });
        const preflight = preflightResult();
        if (preflight === null) throw new Error("the preview child failed");
        return { outcome: "checked", preflight: { type: "preflight-result", ...preflight }, willMigrate: false };
      },
    },
    backend: {
      start: async (reason: string) => {
        starts.push(reason);
        return { ok: true };
      },
      presenter: () => ({ clear: () => undefined }),
      recovery: { handleFailure: () => undefined },
    },
    openRepairWindow: () => {
      repairOpened += 1;
    },
    log: () => undefined,
    environment: { SystemRoot: "C:\\Windows" },
    confirmDialog: async (hardStop: boolean) => {
      dialogs.push(hardStop);
      return options.dialog ?? true;
    },
    dependencies: {
      runCommand: async (command: string, args: readonly string[]) => {
        commands.push([command, ...args].join(" "));
        if (/powershell/i.test(command)) {
          const list = Array.from({ length: options.windowsRunners ?? 0 }, (_, index) => ({
            pid: 100 + index,
            parentPid: 1,
            name: "node.exe",
            commandLine: `node.exe "C:\\synthetic\\checkout\\scripts\\service-runner.mjs"`,
          }));
          return { stdout: Buffer.from(JSON.stringify(list), "utf8").toString("base64"), code: 0 };
        }
        if (args[0] === "print" || args.includes("is-enabled")) return { stdout: "", code: 1 };
        if (options.swapDefinitionAfterStop && args.includes("disable")) files.set(definitionPath, "swapped");
        return { stdout: "", code: 0 };
      },
      detect: refresh,
      ...(options.ownBackendPort === undefined ? { isPortFree: async () => options.portFree ?? true } : {}),
      isProcessAlive: () => false,
      readDefinition: async (file: string) => Buffer.from(files.get(file) ?? "", "utf8"),
      lstat: async (file: string) => (files.has(file) ? { isFile: true, isSymbolicLink: false } : null),
      unlink: async (file: string) => {
        files.delete(file);
      },
      sleep: async () => undefined,
      now: (() => {
        let clock = 0;
        return () => (clock += 1_000);
      })(),
    },
  };
  const controller = createLegacyDisable(controllerOptions as unknown as LegacyDisableOptions);
  return {
    controller,
    files,
    commands,
    dialogs,
    errors,
    previews,
    journal,
    starts,
    appDatabase,
    repairOpened: () => repairOpened,
    startImport: () => {
      const directory = join(root, ".work-intelligence-transfer", "import-abc123");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, ".wi-transfer"), "work-intelligence transfer directory v1\n");
    },
  };
}

async function previewId(controller: ReturnType<typeof setup>["controller"]): Promise<string> {
  const result = await controller.preview();
  if (!result.ok) throw new Error("expected a preview");
  return result.preview.previewId;
}

describe("the legacy disable controller", () => {
  it("accepts only the current preview id, and asks nothing for any other", async () => {
    const { controller, dialogs, commands } = setup();
    expect(await controller.confirm("00000000-0000-4000-8000-000000000000", false)).toEqual({
      ok: false,
      reason: "invalid",
    });
    const first = await previewId(controller);
    const second = await previewId(controller);
    expect(await controller.confirm(first, false)).toEqual({ ok: false, reason: "invalid" });
    expect(dialogs).toEqual([]);
    expect(commands).toEqual([]);
    expect((await controller.confirm(second, false)).ok).toBe(true);
  });

  it("does nothing when the native dialog is cancelled", async () => {
    const { controller, commands, files, journal } = setup({ dialog: false });
    expect(await controller.confirm(await previewId(controller), false)).toEqual({ ok: false, reason: "cancelled" });
    expect(commands).toEqual([]);
    expect(journal).toEqual([]);
    expect(files.size).toBe(1);
  });

  it("needs 「仍要停用」 while an import runs, and warns first about one that started after the preview", async () => {
    const busy = setup();
    busy.startImport();
    const preview = await busy.controller.preview();
    expect(preview.ok && preview.preview.busy).toBe(true);
    const id = preview.ok ? preview.preview.previewId : "";
    expect(await busy.controller.confirm(id, false)).toEqual({ ok: false, reason: "invalid" });
    expect((await busy.controller.confirm(id, true)).ok).toBe(true);

    const late = setup();
    const lateId = await previewId(late.controller);
    late.startImport();
    expect(await late.controller.confirm(lateId, false)).toEqual({ ok: false, reason: "now-busy" });
    expect(late.dialogs).toEqual([]);
    expect(late.commands).toEqual([]);
    expect(await late.controller.confirm(lateId, false)).toEqual({ ok: false, reason: "invalid" });
    expect((await late.controller.confirm(lateId, true)).ok).toBe(true);
  });

  it("records the operation as legacy-disable with the previewed definition", async () => {
    const { controller, journal } = setup();
    await controller.confirm(await previewId(controller), false);
    expect(journal).toEqual([
      expect.objectContaining({
        kind: "legacy-disable",
        previousOwner: "desktop",
        oldRunningState: true,
        oldServiceDefinition: expect.objectContaining({
          platform: "linux",
          repositoryRoot: "/srv/synthetic-checkout",
          definitionDigest: legacyDefinitionDigest(DEFINITION),
        }),
      }),
    ]);
  });

  it("treats the App's own backend on the port as proof the old one is not listening there", async () => {
    // A real listener on an ephemeral port stands in for the App's backend: the port is genuinely taken.
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const own = setup({ ownBackendPort: port, port });
      expect(await own.controller.confirm(await previewId(own.controller), false)).toEqual({
        ok: true,
        offerStart: false,
      });
      expect(own.files.size).toBe(0);
      expect(own.starts).toEqual([]);
      // Someone else on that port: the old service may still be there, so nothing is removed.
      const other = setup({ ownBackendPort: port + 1, port });
      expect(await other.controller.confirm(await previewId(other.controller), false)).toEqual({
        ok: false,
        reason: "still-running",
      });
      expect(other.files.size).toBe(1);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("checks the App's database read-only after the stop, and offers 「立即啟動」 only once it passed", async () => {
    const { controller, previews, starts, appDatabase } = setup();
    expect(await controller.startNow()).toEqual({ ok: false, reason: "invalid" });
    expect(await controller.confirm(await previewId(controller), false)).toEqual({ ok: true, offerStart: true });
    expect(previews).toEqual([{ path: appDatabase, quickCheck: true }]);
    expect(starts).toEqual([]);
    expect(await controller.startNow()).toEqual({ ok: true });
    expect(await controller.startNow()).toEqual({ ok: false, reason: "invalid" });
    expect(starts).toEqual(["restart"]);
  });

  it("does not check a database the old service did not share", async () => {
    const { controller, previews } = setup({ sameDatabase: false });
    expect((await controller.confirm(await previewId(controller), false)).ok).toBe(true);
    expect(previews).toEqual([]);
  });

  it("reports damage only for a failed quick_check, and then opens repair and offers no start", async () => {
    const damaged = setup({ preflight: "damaged" });
    expect(await damaged.controller.confirm(await previewId(damaged.controller), false)).toEqual({
      ok: false,
      reason: "database-check-failed",
    });
    expect(damaged.errors).toEqual(["DB_INTEGRITY_CHECK_FAILED"]);
    expect(damaged.repairOpened()).toBe(1);
    expect(await damaged.controller.startNow()).toEqual({ ok: false, reason: "invalid" });
  });

  it.each(["locked", "throws"] as const)(
    "calls a database it could not check (%s) unverified: no damage recorded, no start offered",
    async (preflight) => {
      const { controller, errors, files } = setup({ preflight });
      expect(await controller.confirm(await previewId(controller), false)).toEqual({
        ok: true,
        offerStart: false,
        databaseUnverified: true,
      });
      expect(files.size).toBe(0);
      expect(errors).toEqual([]);
      expect(await controller.startNow()).toEqual({ ok: false, reason: "invalid" });
    },
  );

  it("still checks the database when a step after the stop failed", async () => {
    const { controller, previews, errors } = setup({ preflight: "damaged", swapDefinitionAfterStop: true });
    expect(await controller.confirm(await previewId(controller), false)).toEqual({
      ok: false,
      reason: "failed",
      removed: false,
    });
    expect(previews).toHaveLength(1);
    expect(errors).toEqual(["DB_INTEGRITY_CHECK_FAILED"]);
  });

  it("does not check the database while the old service still holds the port", async () => {
    const { controller, previews, files } = setup({ portFree: false });
    expect(await controller.confirm(await previewId(controller), false)).toEqual({
      ok: false,
      reason: "still-running",
    });
    expect(previews).toEqual([]);
    expect(files.size).toBe(1);
  });

  it("warns about the hard stop on Windows when a runner is alive although the task reads as stopped", async () => {
    const { controller, dialogs } = setup({ platform: "win32", running: "stopped", windowsRunners: 1 });
    const preview = await controller.preview();
    expect(preview.ok && { running: preview.preview.running, hardStop: preview.preview.hardStop }).toEqual({
      running: true,
      hardStop: true,
    });
    await controller.confirm(preview.ok ? preview.preview.previewId : "", false);
    expect(dialogs).toEqual([true]);
  });

  it("promises no hard stop on Windows when the task is stopped and no runner is alive", async () => {
    const { controller } = setup({ platform: "win32", running: "stopped", windowsRunners: 0 });
    const preview = await controller.preview();
    expect(preview.ok && { running: preview.preview.running, hardStop: preview.preview.hardStop }).toEqual({
      running: false,
      hardStop: false,
    });
  });
});
