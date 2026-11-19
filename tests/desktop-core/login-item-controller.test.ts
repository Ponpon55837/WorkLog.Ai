// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoginItemController } from "../../apps/desktop/src/main/login-item.js";
import { ShellState } from "../../apps/desktop/src/main/state.js";
import { readDesktopSettings, type DesktopSettingsV1 } from "../../packages/desktop-core/src/index.js";

vi.mock("electron", () => ({ app: { setLoginItemSettings: vi.fn(), getLoginItemSettings: vi.fn() } }));

// Synthetic settings only: the controller writes a temporary file and asks a fake system.
let directory = "";

function settings(launchAtLogin: boolean): DesktopSettingsV1 {
  return {
    configVersion: 1,
    installId: "synthetic-install",
    desired: {
      databasePath: path.join(directory, "data", "work-intelligence.sqlite"),
      port: 43_100,
      launchAtLogin,
      backupDirectory: path.join(directory, "backups"),
    },
  };
}

beforeEach(async () => {
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), "login-item-controller-"));
});

afterEach(async () => {
  await fsp.rm(directory, { recursive: true, force: true });
});

function setup(platform: NodeJS.Platform, system: unknown, launchAtLogin = false) {
  const state = new ShellState();
  state.settings = settings(launchAtLogin);
  const settingsFile = path.join(directory, "desktop-settings.json");
  const applied: boolean[] = [];
  let changed = 0;
  const controller = createLoginItemController({
    state,
    paths: { settingsFile },
    platform,
    readSystem: () => system,
    apply: (s) => void applied.push(s.settings?.desired.launchAtLogin === true),
    changed: () => void (changed += 1),
    log: () => undefined,
  });
  return { state, settingsFile, controller, applied, changed: () => changed };
}

describe.each([
  [
    "win32",
    { openAtLogin: true, executableWillLaunchAtLogin: true },
    { openAtLogin: true, executableWillLaunchAtLogin: false },
  ],
  ["darwin", { status: "enabled" }, { status: "not-registered" }],
] as const)("the login item switch on %s", (platform, enabled, disabled) => {
  it("shows what the system says, not what the settings say", () => {
    expect(setup(platform, enabled, false).controller.section()).toEqual({
      supported: true,
      desired: false,
      system: "enabled",
    });
    expect(setup(platform, disabled, true).controller.section()).toEqual({
      supported: true,
      desired: true,
      system: "disabled",
    });
  });

  it("turns on: writes the settings file first, then applies, then tells the backend", async () => {
    const { controller, settingsFile, applied, changed, state } = setup(platform, enabled, false);
    const result = await controller.set(true);
    expect(result.ok).toBe(true);
    expect(applied).toEqual([true]);
    expect(changed()).toBe(1);
    expect(state.settings?.desired.launchAtLogin).toBe(true);
    const read = await readDesktopSettings(settingsFile);
    expect(read.kind === "ok" && read.settings.desired.launchAtLogin).toBe(true);
  });

  it("turns off without any consent", async () => {
    const { controller, settingsFile, applied } = setup(platform, disabled, true);
    expect((await controller.set(false)).ok).toBe(true);
    expect(applied).toEqual([false]);
    const read = await readDesktopSettings(settingsFile);
    expect(read.kind === "ok" && read.settings.desired.launchAtLogin).toBe(false);
  });

  it("changes nothing when the settings file cannot be written", async () => {
    const { controller, applied, state, changed } = setup(platform, enabled, false);
    // A directory where the file belongs makes the atomic write fail.
    await fsp.mkdir(path.join(directory, "desktop-settings.json"));
    expect(await controller.set(true)).toEqual({ ok: false, reason: "failed" });
    expect(applied).toEqual([]);
    expect(changed()).toBe(0);
    expect(state.settings?.desired.launchAtLogin).toBe(false);
  });
});

describe("the login item switch where there is no login item", () => {
  it("is unsupported and never writes", async () => {
    const { controller, settingsFile } = setup("linux", undefined);
    expect(controller.section().supported).toBe(false);
    expect(await controller.set(true)).toEqual({ ok: false, reason: "unsupported" });
    await expect(fsp.stat(settingsFile)).rejects.toThrow();
  });
});

describe("how often the system is asked", () => {
  function counted(system: () => unknown) {
    const state = new ShellState();
    const reads = vi.fn(system);
    const controller = createLoginItemController({
      state,
      paths: { settingsFile: path.join(directory, "desktop-settings.json") },
      platform: "win32",
      readSystem: reads,
      apply: () => undefined,
      log: () => undefined,
    });
    return { state, reads, controller };
  }

  afterEach(() => vi.useRealTimers());

  it("does not ask before there are settings, so the first-run page waits for nothing", () => {
    const { reads, controller } = counted(() => ({ openAtLogin: true, executableWillLaunchAtLogin: true }));
    expect(controller.section()).toEqual({ supported: true, desired: false, system: "unknown" });
    expect(reads).not.toHaveBeenCalled();
  });

  it("reuses one answer inside the window, asks again after it, and at once after a change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state, reads, controller } = counted(() => ({ openAtLogin: true, executableWillLaunchAtLogin: true }));
    state.settings = settings(false);
    controller.section();
    controller.section();
    expect(reads).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_500);
    controller.section();
    expect(reads).toHaveBeenCalledTimes(2);
    await controller.set(true);
    expect(reads).toHaveBeenCalledTimes(3);
  });
});
