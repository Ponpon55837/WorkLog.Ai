// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackendController, type BackendControllerOptions } from "../../apps/desktop/src/main/backend.js";
import { backendTestEnvironment } from "../../apps/desktop/src/main/config.js";
import { ShellState } from "../../apps/desktop/src/main/state.js";
import {
  buildChildEnvironment,
  type BackendInfo,
  type DesktopSettingsV1,
} from "../../packages/desktop-core/src/index.js";

/**
 * The migration hold the desktop smoke test gives the backend child (R06): it is passed to the child only by a test
 * build that is not packaged, and nothing in the user's own environment can reach the child. Synthetic data only.
 */

const HOLD_VARIABLE = "WORK_INTELLIGENCE_DESKTOP_TEST_HOLD_MIGRATION_FILE";
const CHILD_VARIABLE = "WORK_INTELLIGENCE_TEST_HOLD_MIGRATION_FILE";
const RELEASE = join(tmpdir(), "synthetic-hold", "release");
const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("backendTestEnvironment", () => {
  it("passes the hold to the child in a test build that is not packaged", () => {
    vi.stubGlobal("__WI_TEST_BUILD__", true);
    expect(isAbsolute(RELEASE)).toBe(true);
    expect(backendTestEnvironment({ isPackaged: false, environment: { [HOLD_VARIABLE]: RELEASE } })).toEqual({
      [CHILD_VARIABLE]: RELEASE,
    });
  });

  it("passes nothing without the variable or with a path that is not absolute", () => {
    vi.stubGlobal("__WI_TEST_BUILD__", true);
    expect(backendTestEnvironment({ isPackaged: false, environment: {} })).toBeUndefined();
    expect(backendTestEnvironment({ isPackaged: false, environment: { [HOLD_VARIABLE]: "" } })).toBeUndefined();
    expect(
      backendTestEnvironment({ isPackaged: false, environment: { [HOLD_VARIABLE]: "relative/release" } }),
    ).toBeUndefined();
  });

  it("ignores the variable in a packaged App, even in a test build", () => {
    vi.stubGlobal("__WI_TEST_BUILD__", true);
    expect(backendTestEnvironment({ isPackaged: true, environment: { [HOLD_VARIABLE]: RELEASE } })).toBeUndefined();
  });

  it("ignores the variable in a production build, packaged or not", () => {
    vi.stubGlobal("__WI_TEST_BUILD__", false);
    for (const isPackaged of [true, false]) {
      expect(backendTestEnvironment({ isPackaged, environment: { [HOLD_VARIABLE]: RELEASE } })).toBeUndefined();
    }
  });
});

describe("what reaches the backend child", () => {
  const parent = { [HOLD_VARIABLE]: RELEASE, [CHILD_VARIABLE]: RELEASE, HOME: "/synthetic/home" };

  it("never inherits the hold from the parent environment on any platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const environment = buildChildEnvironment({ platform, parentEnvironment: parent });
      expect(environment).not.toHaveProperty(HOLD_VARIABLE);
      expect(environment).not.toHaveProperty(CHILD_VARIABLE);
    }
  });

  it("carries the hold only when the App passes it on purpose", () => {
    const environment = buildChildEnvironment({
      platform: "linux",
      parentEnvironment: parent,
      desktopValues: { [CHILD_VARIABLE]: RELEASE },
    });
    expect(environment[CHILD_VARIABLE]).toBe(RELEASE);
  });
});

describe("the backend controller", () => {
  function startRequests(backendEnvironment?: Readonly<Record<string, string>>): Array<Record<string, unknown>> {
    const root = mkdtempSync(join(tmpdir(), "wi-backend-test-environment-"));
    directories.push(root);
    const settingsFile = join(root, "settings.json");
    const identity = {
      realPath: "/synthetic/work.sqlite",
      fileId: { device: "1", inode: "2" },
      lineageId: "d".repeat(64),
    };
    const settings: DesktopSettingsV1 = {
      configVersion: 1,
      installId: "synthetic-install",
      desired: {
        databasePath: "/synthetic/work.sqlite",
        port: 43_100,
        launchAtLogin: false,
        backupDirectory: "/synthetic/b",
      },
      active: { databaseIdentity: identity, port: 43_100, runtimeVersion: "9.9.9", serviceOwner: "desktop" },
    };
    writeFileSync(settingsFile, JSON.stringify(settings));
    const state = new ShellState();
    state.settings = settings;
    state.setOwner("MANAGED");
    const requests: Array<Record<string, unknown>> = [];
    const info: BackendInfo = {
      runId: "synthetic-run-id",
      pid: 1234,
      port: 43_100,
      appVersion: "9.9.9",
      schemaVersion: 33,
      databaseIdentity: identity,
      execPath: "/synthetic/node",
    };
    const controller = createBackendController({
      state,
      paths: { settingsFile },
      supervisor: { running: undefined, stop: async () => undefined },
      managed: {
        start: async (request: Record<string, unknown>) => {
          requests.push(request);
          return { operation: { status: "completed", result: null }, backend: info };
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
      ...(backendEnvironment ? { backendEnvironment } : {}),
    } as unknown as BackendControllerOptions);
    void controller.start("restart");
    return requests;
  }

  it("hands the extra environment to every start and adds none otherwise", async () => {
    const withHold = startRequests({ [CHILD_VARIABLE]: RELEASE });
    const without = startRequests();
    await vi.waitFor(() => expect(withHold).toHaveLength(1));
    await vi.waitFor(() => expect(without).toHaveLength(1));
    expect((withHold[0]?.backend as Record<string, unknown>).environment).toEqual({ [CHILD_VARIABLE]: RELEASE });
    expect(without[0]?.backend).not.toHaveProperty("environment");
  });
});
