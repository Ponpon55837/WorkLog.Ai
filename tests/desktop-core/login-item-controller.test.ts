/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoginItemController } from "../../apps/desktop/src/main/login-item.js";
import { ShellState } from "../../apps/desktop/src/main/state.js";
import { readDesktopSettings, type DesktopSettingsV1 } from "../../packages/desktop-core/src/index.js";

vi.mock("electron", () => ({ app: { setLoginItemSettings: vi.fn(), getLoginItemSettings: vi.fn() } }));

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

function setup(platform: NodeJS.Platform, system: unknown, launchAtLogin = false, apply?: (s: ShellState) => void) {
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
    apply:
      apply ??
      ((s) => {
        applied.push(s.settings?.desired.launchAtLogin === true);
      }),
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
    const order: string[] = [];
    const { controller, settingsFile, changed, state } = setup(platform, enabled, false, (s) => {
      order.push(
        `apply:${JSON.parse(readFileSync(path.join(directory, "desktop-settings.json"), "utf8")).desired.launchAtLogin}`,
      );
      void s;
    });
    const result = await controller.set(true);
    expect(order).toEqual(["apply:true"]);
    expect(result.ok).toBe(true);
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

describe("when the system refuses the change", () => {
  it("answers failed with what the system says, and does not keep a choice the system never took", async () => {
    const refuse = () => {
      throw new Error("synthetic refusal");
    };
    const { controller, state, settingsFile, changed } = setup(
      "win32",
      { openAtLogin: false, executableWillLaunchAtLogin: false },
      false,
      refuse,
    );
    await fsp.writeFile(settingsFile, JSON.stringify(settings(false)));
    const answer = await controller.set(true);
    expect(answer).toEqual({
      ok: false,
      reason: "failed",
      section: { supported: true, desired: false, system: "disabled" },
    });
    expect(state.settings?.desired.launchAtLogin).toBe(false);
    expect(JSON.parse(await fsp.readFile(settingsFile, "utf8")).desired.launchAtLogin).toBe(false);
    expect(changed()).toBe(1);
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

const syntheticIdentity = { realPath: "/synthetic/db.sqlite", fileId: null, lineageId: null };

describe("overlapping settings writes", () => {
  it("keeps the other writer's field when the switch and a record of the active service overlap", async () => {
    const { controller, state, settingsFile } = setup(
      "win32",
      { openAtLogin: true, executableWillLaunchAtLogin: true },
      false,
    );
    await fsp.writeFile(settingsFile, JSON.stringify(settings(false)));
    const record = state.updateSettings(settingsFile, (current) => ({
      ...current,
      lastKnownGood: { databaseIdentity: syntheticIdentity, port: 43_100, runtimeVersion: "1.0.0" },
    }));
    const toggle = controller.set(true);
    await Promise.all([record, toggle]);
    const read = await readDesktopSettings(settingsFile);
    expect(read.kind === "ok" && read.settings.desired.launchAtLogin).toBe(true);
    expect(read.kind === "ok" && read.settings.lastKnownGood?.port).toBe(43_100);
  });
});
