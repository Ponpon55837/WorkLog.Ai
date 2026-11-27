import path from "node:path";
import type { LegacyServicePlatform } from "./types.js";

export const SYSTEM_SETTINGS_TARGETS = ["task-scheduler", "login-items"] as const;
export type SystemSettingsTarget = (typeof SYSTEM_SETTINGS_TARGETS)[number];

export const MACOS_LOGIN_ITEMS_URL = "x-apple.systempreferences:com.apple.LoginItems-Extension";

export interface SystemSettingsShell {
  openPath(fixedPath: string): Promise<string>;
  openExternal(fixedUrl: string): Promise<void>;
}

export interface OpenSystemSettingsOptions {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly shell: SystemSettingsShell;
}

export function systemSettingsTargetFor(platform: LegacyServicePlatform): SystemSettingsTarget | null {
  if (platform === "win32") return "task-scheduler";
  if (platform === "darwin") return "login-items";
  return null;
}

export function systemSettingsField(platform: LegacyServicePlatform): {
  readonly systemSettings?: SystemSettingsTarget;
} {
  const target = systemSettingsTargetFor(platform);
  return target === null ? {} : { systemSettings: target };
}

export function taskSchedulerPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  const systemRoot = root && path.win32.isAbsolute(root) ? root : "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "taskschd.msc");
}

export function launchAgentsFolder(homeDirectory: string): string {
  return path.posix.join(homeDirectory, "Library", "LaunchAgents");
}

export async function openSystemSettings(
  target: SystemSettingsTarget,
  options: OpenSystemSettingsOptions,
): Promise<{ readonly ok: boolean }> {
  const { platform, env, homeDirectory, shell } = options;
  try {
    if (target === "task-scheduler") {
      if (platform !== "win32") return { ok: false };
      return { ok: (await shell.openPath(taskSchedulerPath(env))) === "" };
    }
    if (platform !== "darwin") return { ok: false };
    try {
      await shell.openExternal(MACOS_LOGIN_ITEMS_URL);
      return { ok: true };
    } catch {
      return { ok: (await shell.openPath(launchAgentsFolder(homeDirectory))) === "" };
    }
  } catch {
    return { ok: false };
  }
}
