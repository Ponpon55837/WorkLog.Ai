/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendController, type BackendControllerOptions } from "../../apps/desktop/src/main/backend.js";
import { ShellState } from "../../apps/desktop/src/main/state.js";
import {
  isDeterministicFailure,
  RestartPolicy,
  type BackendInfo,
  type DesktopSettingsV1,
} from "../../packages/desktop-core/src/index.js";

const IDENTITY = {
  realPath: "/synthetic/data/work.sqlite",
  fileId: { device: "1", inode: "2" },
  lineageId: "c".repeat(64),
};
const OLD = 43_100;
const NEW = 43_200;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function info(port: number): BackendInfo {
  return {
    runId: "synthetic-run-id",
    pid: 1234,
    port,
    appVersion: "9.9.9",
    schemaVersion: 33,
    databaseIdentity: IDENTITY,
    execPath: "/synthetic/node",
  };
}

function setup(
  options: { startResult?: "ok" | "fail"; stopped?: boolean; refused?: boolean; prepareFails?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "wi-backend-port-"));
  directories.push(root);
  const settingsFile = join(root, "settings.json");
  const settings: DesktopSettingsV1 = {
    configVersion: 1,
    installId: "synthetic-install",
    desired: {
      databasePath: "/synthetic/data/work.sqlite",
      port: OLD,
      launchAtLogin: false,
      backupDirectory: "/synthetic/backups",
    },
    active: { databaseIdentity: IDENTITY, port: OLD, runtimeVersion: "9.9.9", serviceOwner: "desktop" },
  };
  writeFileSync(settingsFile, JSON.stringify(settings));
  const state = new ShellState();
  state.settings = settings;
  state.setOwner("MANAGED");
  const requests: Array<Record<string, unknown>> = [];
  const journal: unknown[] = [];
  let running: BackendInfo | undefined = options.stopped ? undefined : info(OLD);
  let stops = 0;
  const supervisor = {
    get running() {
      return running;
    },
    stop: async () => {
      stops += 1;
      running = undefined;
    },
  };
  const managed = {
    start: async (request: Record<string, unknown>) => {
      requests.push(request);
      journal.push(request.details);
      const port = (request.backend as { port: number }).port;
      if (options.startResult === "fail") {
        running = undefined;
        return {
          operation: { status: "failed", error: "PORT_OCCUPIED_BY_OTHER: in use" },
          errorCode: "PORT_OCCUPIED_BY_OTHER",
        };
      }
      running = info(port);
      return { operation: { status: "completed", result: null }, backend: running };
    },
  };
  const controller = createBackendController({
    state,
    paths: { settingsFile },
    supervisor,
    managed,
    coordinator: { current: () => null },
    lastBackup: { bindDatabase: () => undefined },
    log: () => undefined,
    openRepairWindow: () => undefined,
    prepareRuntime: async () => {
      if (options.prepareFails) throw new Error("synthetic runtime failure");
    },
    reinstallOnRefusal: false,
    notifyError: () => undefined,
    whenReady: async () => undefined,
    desktopFacts: () => ({ legacyService: { running: "stopped" } }),
    storageRefused: () => options.refused === true,
  } as unknown as BackendControllerOptions);
  const onDisk = (): DesktopSettingsV1 => JSON.parse(readFileSync(settingsFile, "utf8")) as DesktopSettingsV1;
  return { controller, state, requests, journal, onDisk, stops: () => stops, running: () => running };
}

describe("a port change in the backend controller", () => {
  it("commits desired.port, active and lastKnownGood together once the backend is verified", async () => {
    const { controller, state, onDisk, requests, journal } = setup();
    expect(await controller.startOnPort({ port: NEW, from: OLD })).toEqual({ ok: true });
    expect(requests[0]).toMatchObject({
      kind: "change-port",
      stopRunning: true,
      backend: { port: NEW, desktop: { activePort: NEW, legacyService: { running: "stopped" } } },
    });
    expect(journal).toEqual([{ from: OLD, to: NEW }]);
    for (const settings of [onDisk(), state.settings as DesktopSettingsV1]) {
      expect(settings.desired.port).toBe(NEW);
      expect(settings.active).toMatchObject({ port: NEW, serviceOwner: "desktop" });
      expect(settings.lastKnownGood).toEqual({ databaseIdentity: IDENTITY, port: NEW, runtimeVersion: "9.9.9" });
    }
    expect(state.owner).toBe("MANAGED");
  });

  it("leaves the settings file untouched when the new port fails to start", async () => {
    const { controller, state, onDisk } = setup({ startResult: "fail" });
    const before = JSON.stringify(onDisk());
    expect(await controller.startOnPort({ port: NEW, from: OLD })).toEqual({
      ok: false,
      code: "PORT_OCCUPIED_BY_OTHER",
    });
    expect(JSON.stringify(onDisk())).toBe(before);
    expect(state.settings?.desired.port).toBe(OLD);
    expect(state.owner).toBe("NEEDS_REPAIR");
  });

  it("stops the new backend and fails when the settings cannot be written", async () => {
    // A file where the settings directory must be makes the atomic write fail.
    const root = mkdtempSync(join(tmpdir(), "wi-backend-port-bad-"));
    directories.push(root);
    const broken = setupBrokenWrite(root);
    expect(await broken.controller.startOnPort({ port: NEW, from: OLD })).toEqual({
      ok: false,
      code: "REPAIR_REQUIRED",
    });
    expect(broken.stops()).toBe(1);
    expect(broken.state.settings?.desired.port).toBe(OLD);
    expect(broken.state.owner).toBe("NEEDS_REPAIR");
  });

  it("refuses every kind of start on a database known to be on a network share, before stopping or starting anything", async () => {
    const stopped = setup({ refused: true, stopped: true });
    for (const kind of ["restart", "takeover", "change-db"] as const) {
      expect(await stopped.controller.start(kind)).toEqual({ ok: false, code: "DB_STORAGE_NETWORK" });
    }
    expect(await stopped.controller.startOnPort({ port: NEW, from: OLD })).toEqual({
      ok: false,
      code: "DB_STORAGE_NETWORK",
    });
    expect(await stopped.controller.recovery.retryNow()).toEqual({ ok: false, code: "DB_STORAGE_NETWORK" });
    expect(stopped.requests).toEqual([]);
    expect(stopped.state.owner).toBe("NEEDS_REPAIR");
    expect(stopped.state.backend).toBe("stopped");
    const serving = setup({ refused: true });
    expect(await serving.controller.start("restart")).toEqual({ ok: false, code: "DB_STORAGE_NETWORK" });
    expect(serving.requests).toEqual([]);
    expect(serving.running()?.port).toBe(OLD);
    expect(serving.state.owner).toBe("MANAGED");
  });

  it("does not mark a still-running service stopped or in need of repair when the runtime cannot be prepared", async () => {
    const serving = setup({ prepareFails: true });
    serving.state.backend = "running";
    expect(await serving.controller.start("restart")).toEqual({ ok: false, code: "RUNTIME_INSTALL_FAILED" });
    expect(serving.requests).toEqual([]);
    expect(serving.running()?.port).toBe(OLD);
    expect(serving.state.owner).toBe("MANAGED");
    expect(serving.state.backend).toBe("running");
    const idle = setup({ prepareFails: true, stopped: true });
    expect(await idle.controller.start("restart")).toEqual({ ok: false, code: "RUNTIME_INSTALL_FAILED" });
    expect(idle.state.owner).toBe("NEEDS_REPAIR");
    expect(idle.state.backend).toBe("stopped");
  });

  it("makes the refusal deterministic, so an automatic restart schedules no retry that would loop", () => {
    expect(isDeterministicFailure("DB_STORAGE_NETWORK")).toBe(true);
    expect(new RestartPolicy({ clock: () => 0 }).decide("DB_STORAGE_NETWORK")).toEqual({
      retry: false,
      reason: "deterministic",
    });
  });

  it("records lastKnownGood on every verified start, and skips the write when nothing changed", async () => {
    const { controller, state, onDisk } = setup();
    expect(await controller.start("restart")).toEqual({ ok: true });
    expect(onDisk().lastKnownGood).toMatchObject({ port: OLD });
    const written = state.settings;
    expect(await controller.start("restart")).toEqual({ ok: true });
    expect(state.settings).toBe(written);
    expect(onDisk().desired.port).toBe(OLD);
  });
});

function setupBrokenWrite(root: string) {
  const made = setup();
  const settingsFile = join(root, "missing", "deeper", "settings.json");
  writeFileSync(join(root, "missing"), "a file, not a directory");
  const state = new ShellState();
  state.settings = made.state.settings;
  state.setOwner("MANAGED");
  let running: BackendInfo | undefined = info(OLD);
  let stops = 0;
  const controller = createBackendController({
    state,
    paths: { settingsFile },
    supervisor: {
      get running() {
        return running;
      },
      stop: async () => {
        stops += 1;
        running = undefined;
      },
    },
    managed: {
      start: async (request: { backend: { port: number } }) => {
        running = info(request.backend.port);
        return { operation: { status: "completed", result: null }, backend: running };
      },
    },
    coordinator: { current: () => null },
    lastBackup: { bindDatabase: () => undefined },
    log: () => undefined,
    openRepairWindow: () => undefined,
    prepareRuntime: async () => undefined,
    reinstallOnRefusal: false,
    notifyError: () => undefined,
    whenReady: async () => undefined,
  } as unknown as BackendControllerOptions);
  return { controller, state, stops: () => stops };
}
