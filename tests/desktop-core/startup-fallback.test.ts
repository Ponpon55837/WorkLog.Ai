/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackendController, type BackendControllerOptions } from "../../apps/desktop/src/main/backend.js";
import { ShellState } from "../../apps/desktop/src/main/state.js";
import {
  planPortFallback,
  sameAsLastKnownGood,
  startupFallbackText,
  type BackendInfo,
  type DesktopSettingsV1,
} from "../../packages/desktop-core/src/index.js";

const IDENTITY = {
  realPath: "/synthetic/data/work.sqlite",
  fileId: { device: "1", inode: "2" },
  lineageId: "c".repeat(64),
};
const OTHER_IDENTITY = { ...IDENTITY, lineageId: "d".repeat(64) };
const WANTED = 43_100;
const GOOD = 43_150;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("planPortFallback", () => {
  const good = { databaseIdentity: IDENTITY, port: GOOD, runtimeVersion: "9.9.8" };
  const base = {
    failureCode: "PORT_OCCUPIED_BY_OTHER",
    attemptedPort: WANTED,
    lastKnownGood: good,
    alreadyTried: false,
  };

  it("offers the last good port for a port failure, and nothing for any other failure", () => {
    expect(planPortFallback(base)).toEqual({ port: GOOD, runtimeVersion: "9.9.8" });
    expect(planPortFallback({ ...base, failureCode: "PORT_NOT_PERMITTED" })).toMatchObject({ port: GOOD });
    for (const failureCode of ["DB_MISSING", "DB_OFFLINE", "RUNTIME_MISSING", "PORT_NOT_RELEASED", "SCHEMA_TOO_NEW"]) {
      expect(planPortFallback({ ...base, failureCode })).toBeNull();
    }
  });

  it("offers nothing without a record, for the same port, or after a failed fallback", () => {
    expect(planPortFallback({ ...base, lastKnownGood: null })).toBeNull();
    expect(planPortFallback({ ...base, lastKnownGood: undefined })).toBeNull();
    expect(planPortFallback({ ...base, attemptedPort: GOOD })).toBeNull();
    expect(planPortFallback({ ...base, alreadyTried: true })).toBeNull();
  });

  it("compares the verified database with the last good one", () => {
    expect(sameAsLastKnownGood(good, IDENTITY)).toBe(true);
    expect(sameAsLastKnownGood(good, OTHER_IDENTITY)).toBe(false);
    expect(sameAsLastKnownGood(null, IDENTITY)).toBe(false);
  });

  it("says in both languages which port runs, that the choice stayed, and that data was not touched on failure", () => {
    const restored = {
      kind: "port-restored",
      wantedPort: WANTED,
      usedPort: GOOD,
      code: "X",
      runtimeVersion: "9.9.8",
      sameDatabase: true,
    } as const;
    expect(startupFallbackText("en", restored)).toContain(`${GOOD}`);
    expect(startupFallbackText("zh-TW", restored)).toContain("沒有被更改");
    expect(startupFallbackText("en", { ...restored, sameDatabase: false })).toContain("not the database");
    const failed = { kind: "port-failed", wantedPort: WANTED, triedPort: GOOD, code: "X" } as const;
    expect(startupFallbackText("en", failed)).toContain("not changed");
    expect(startupFallbackText("zh-TW", failed)).toContain("沒有被更動");
  });
});

function setup(
  options: {
    goodRecord?: boolean;
    fallbackFails?: boolean;
    identity?: typeof IDENTITY;
    sameDatabaseServer?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "wi-fallback-"));
  directories.push(root);
  const settingsFile = join(root, "settings.json");
  const settings: DesktopSettingsV1 = {
    configVersion: 1,
    installId: "synthetic-install",
    desired: {
      databasePath: "/synthetic/data/work.sqlite",
      port: WANTED,
      launchAtLogin: false,
      backupDirectory: "/synthetic/backups",
    },
    active: { databaseIdentity: IDENTITY, port: GOOD, runtimeVersion: "9.9.8", serviceOwner: "desktop" },
    ...(options.goodRecord === false
      ? {}
      : { lastKnownGood: { databaseIdentity: IDENTITY, port: GOOD, runtimeVersion: "9.9.8" } }),
  };
  writeFileSync(settingsFile, JSON.stringify(settings));
  const state = new ShellState();
  state.settings = settings;
  state.setOwner("NEEDS_REPAIR");
  const ports: number[] = [];
  let running: BackendInfo | undefined;
  const supervisor = {
    get running() {
      return running;
    },
    stop: async () => {
      running = undefined;
    },
  };
  const managed = {
    start: async (request: Record<string, unknown>) => {
      const port = (request.backend as { port: number }).port;
      ports.push(port);
      if (port === WANTED || options.fallbackFails) {
        running = undefined;
        return {
          operation: { status: "failed", error: "PORT_OCCUPIED_BY_OTHER: in use" },
          errorCode: "PORT_OCCUPIED_BY_OTHER",
        };
      }
      running = {
        runId: "synthetic-run-id",
        pid: 1234,
        port,
        appVersion: "9.9.9",
        schemaVersion: 33,
        databaseIdentity: options.identity ?? IDENTITY,
        execPath: "/synthetic/node",
      };
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
    prepareRuntime: async () => undefined,
    reinstallOnRefusal: false,
    notifyError: () => undefined,
    whenReady: async () => undefined,
    ...(options.sameDatabaseServer === undefined
      ? {}
      : { sameDatabaseServerOn: async () => options.sameDatabaseServer === true }),
  } as unknown as BackendControllerOptions);
  const onDisk = (): DesktopSettingsV1 => JSON.parse(readFileSync(settingsFile, "utf8")) as DesktopSettingsV1;
  return { controller, state, ports, onDisk };
}

describe("the backend controller falls back to the last working port", () => {
  it("starts on the last good port after a port failure, keeps the user's choice and explains itself", async () => {
    const { controller, state, ports, onDisk } = setup();
    expect(await controller.start("restart")).toEqual({ ok: true });
    expect(ports).toEqual([WANTED, GOOD]);
    expect(state.owner).toBe("MANAGED");
    expect(state.startupFallback).toMatchObject({
      kind: "port-restored",
      wantedPort: WANTED,
      usedPort: GOOD,
      sameDatabase: true,
    });
    expect(onDisk().desired.port).toBe(WANTED);
    expect(onDisk().active).toMatchObject({ port: GOOD });
  });

  it("says when the verified database is not the one that last ran there", async () => {
    const { controller, state } = setup({ identity: OTHER_IDENTITY });
    await controller.start("restart");
    expect(state.startupFallback).toMatchObject({ kind: "port-restored", sameDatabase: false });
  });

  it("returns the original failure and goes to repair when the fallback fails too, and does not try again", async () => {
    const { controller, state, ports, onDisk } = setup({ fallbackFails: true });
    const before = JSON.stringify(onDisk());
    expect(await controller.start("restart")).toEqual({ ok: false, code: "PORT_OCCUPIED_BY_OTHER" });
    expect(state.owner).toBe("NEEDS_REPAIR");
    expect(state.startupFallback).toMatchObject({ kind: "port-failed", wantedPort: WANTED, triedPort: GOOD });
    expect(JSON.stringify(onDisk())).toBe(before);
    await controller.start("restart");
    expect(ports).toEqual([WANTED, GOOD, WANTED]);
  });

  it("does not start a second server on one database when the port is held by another Work Intelligence server", async () => {
    const { controller, state, ports } = setup({ sameDatabaseServer: true });
    expect(await controller.start("restart")).toEqual({ ok: false, code: "PORT_OCCUPIED_BY_OTHER" });
    expect(ports).toEqual([WANTED]);
    expect(state.owner).toBe("NEEDS_REPAIR");
    expect(state.startupFallback).toBeNull();
    for (const kind of ["change-db", "takeover"] as const) {
      const asked = setup({ sameDatabaseServer: true });
      expect(await asked.controller.start(kind)).toEqual({ ok: false, code: "PORT_OCCUPIED_BY_OTHER" });
      expect(asked.ports).toEqual([WANTED]);
    }
  });

  it("still falls back when the holder is another program", async () => {
    const { controller, ports } = setup({ sameDatabaseServer: false });
    expect(await controller.start("restart")).toEqual({ ok: true });
    expect(ports).toEqual([WANTED, GOOD]);
  });

  it("does nothing without a record, and never for a port change the user asked for", async () => {
    const none = setup({ goodRecord: false });
    expect(await none.controller.start("restart")).toEqual({ ok: false, code: "PORT_OCCUPIED_BY_OTHER" });
    expect(none.ports).toEqual([WANTED]);
    expect(none.state.startupFallback).toBeNull();
    const change = setup();
    expect(await change.controller.startOnPort({ port: WANTED, from: GOOD })).toEqual({
      ok: false,
      code: "PORT_OCCUPIED_BY_OTHER",
    });
    expect(change.ports).toEqual([WANTED]);
  });

  it("clears the note once a start on the chosen port works again", async () => {
    const { controller, state } = setup();
    await controller.start("restart");
    expect(state.startupFallback).not.toBeNull();
    expect(await controller.startOnPort({ port: GOOD, from: WANTED })).toEqual({ ok: true });
    expect(state.startupFallback).toBeNull();
  });
});
