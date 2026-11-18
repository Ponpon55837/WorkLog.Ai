import { describe, expect, it } from "vitest";
import {
  MACOS_LOGIN_ITEMS_URL,
  REPAIR_CHANNELS,
  SYSTEM_SETTINGS_TARGETS,
  openSystemSettings,
  repairInputSchemas,
  systemSettingsTargetFor,
  taskSchedulerPath,
  type SystemSettingsShell,
} from "../../packages/desktop-core/src/index.js";

/** A fake `shell` that records every call; `openPath` answers `pathAnswer` ("" is success), `openExternal` may throw. */
function fakeShell(options: { pathAnswer?: string; externalFails?: boolean } = {}) {
  const calls: { method: "openPath" | "openExternal"; value: string }[] = [];
  const shell: SystemSettingsShell = {
    openPath: (value) => {
      calls.push({ method: "openPath", value });
      return Promise.resolve(options.pathAnswer ?? "");
    },
    openExternal: (value) => {
      calls.push({ method: "openExternal", value });
      return options.externalFails ? Promise.reject(new Error("no handler")) : Promise.resolve();
    },
  };
  return { shell, calls };
}

describe("the OS place for turning the old login service off by hand", () => {
  it("is Task Scheduler on Windows, Login Items on macOS, and nothing elsewhere", () => {
    expect(systemSettingsTargetFor("win32")).toBe("task-scheduler");
    expect(systemSettingsTargetFor("darwin")).toBe("login-items");
    expect(systemSettingsTargetFor("linux")).toBeNull();
  });

  it("resolves taskschd.msc under the environment's SystemRoot, falling back to C:\\Windows", () => {
    expect(taskSchedulerPath({ SystemRoot: "D:\\WINNT" })).toBe("D:\\WINNT\\System32\\taskschd.msc");
    expect(taskSchedulerPath({ SYSTEMROOT: "E:\\Win" })).toBe("E:\\Win\\System32\\taskschd.msc");
    expect(taskSchedulerPath({})).toBe("C:\\Windows\\System32\\taskschd.msc");
    // A relative or hostile value is not trusted as a root.
    expect(taskSchedulerPath({ SystemRoot: "..\\evil" })).toBe("C:\\Windows\\System32\\taskschd.msc");
  });

  it("opens the .msc with openPath on Windows, never openExternal", async () => {
    const { shell, calls } = fakeShell();
    const result = await openSystemSettings("task-scheduler", {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      homeDirectory: "C:\\Users\\synthetic",
      shell,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ method: "openPath", value: "C:\\Windows\\System32\\taskschd.msc" }]);
  });

  it("reports a failure when openPath answers an error text", async () => {
    const { shell } = fakeShell({ pathAnswer: "no such file" });
    const result = await openSystemSettings("task-scheduler", {
      platform: "win32",
      env: {},
      homeDirectory: "C:\\Users\\synthetic",
      shell,
    });
    expect(result).toEqual({ ok: false });
  });

  it("opens the fixed Login Items pane on macOS", async () => {
    const { shell, calls } = fakeShell();
    const result = await openSystemSettings("login-items", {
      platform: "darwin",
      env: {},
      homeDirectory: "/Users/synthetic",
      shell,
    });
    expect(result).toEqual({ ok: true });
    expect(MACOS_LOGIN_ITEMS_URL).toBe("x-apple.systempreferences:com.apple.LoginItems-Extension");
    expect(calls).toEqual([{ method: "openExternal", value: MACOS_LOGIN_ITEMS_URL }]);
  });

  it("falls back to the LaunchAgents folder through openPath when the pane cannot be opened", async () => {
    const { shell, calls } = fakeShell({ externalFails: true });
    const result = await openSystemSettings("login-items", {
      platform: "darwin",
      env: {},
      homeDirectory: "/Users/synthetic",
      shell,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      { method: "openExternal", value: MACOS_LOGIN_ITEMS_URL },
      { method: "openPath", value: "/Users/synthetic/Library/LaunchAgents" },
    ]);
  });

  it("opens nothing for a target that belongs to another platform", async () => {
    for (const [target, platform] of [
      ["task-scheduler", "darwin"],
      ["task-scheduler", "linux"],
      ["login-items", "win32"],
      ["login-items", "linux"],
    ] as const) {
      const { shell, calls } = fakeShell();
      expect(await openSystemSettings(target, { platform, env: {}, homeDirectory: "/h", shell })).toEqual({
        ok: false,
      });
      expect(calls).toEqual([]);
    }
  });

  it("takes an enum on the channel and rejects any string, path or URL", () => {
    expect(REPAIR_CHANNELS.openSystemSettings).toBe("app:open-system-settings");
    for (const target of SYSTEM_SETTINGS_TARGETS) {
      expect(repairInputSchemas.openSystemSettings.safeParse({ target }).success).toBe(true);
    }
    for (const target of ["C:\\Windows\\System32\\cmd.exe", "https://example.test", "taskschd.msc", ""]) {
      expect(repairInputSchemas.openSystemSettings.safeParse({ target }).success).toBe(false);
    }
    expect(repairInputSchemas.openSystemSettings.safeParse({ target: "login-items", path: "/x" }).success).toBe(false);
    expect(repairInputSchemas.openSystemSettings.safeParse({}).success).toBe(false);
  });
});
