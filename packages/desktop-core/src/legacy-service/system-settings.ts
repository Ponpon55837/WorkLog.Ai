import path from "node:path";
import type { LegacyServicePlatform } from "./types.js";

/**
 * Where the App sends the user when it cannot turn the old login service off itself. The page names a target from this
 * list, never a path or a URL; main maps it to one fixed place (see `openSystemSettings`).
 */
export const SYSTEM_SETTINGS_TARGETS = ["task-scheduler", "login-items"] as const;
export type SystemSettingsTarget = (typeof SYSTEM_SETTINGS_TARGETS)[number];

/** The macOS settings pane for login items and background items; fixed, never built from input. */
export const MACOS_LOGIN_ITEMS_URL = "x-apple.systempreferences:com.apple.LoginItems-Extension";

/** The two Electron `shell` calls the resolver may use; tests pass fakes. */
export interface SystemSettingsShell {
  /** Resolves to "" on success and to an error text otherwise (Electron's `shell.openPath`). */
  openPath(fixedPath: string): Promise<string>;
  openExternal(fixedUrl: string): Promise<void>;
}

export interface OpenSystemSettingsOptions {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly shell: SystemSettingsShell;
}

/** The settings place that lists the old service on this platform; `null` where the App has none to open. */
export function systemSettingsTargetFor(platform: LegacyServicePlatform): SystemSettingsTarget | null {
  if (platform === "win32") return "task-scheduler";
  if (platform === "darwin") return "login-items";
  return null;
}

/** The state field a view carries: the target to offer, or nothing. */
export function systemSettingsField(platform: LegacyServicePlatform): {
  readonly systemSettings?: SystemSettingsTarget;
} {
  const target = systemSettingsTargetFor(platform);
  return target === null ? {} : { systemSettings: target };
}

/** `%SystemRoot%\System32\taskschd.msc`; SystemRoot comes from the environment, `C:\Windows` when it is not absolute. */
export function taskSchedulerPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  const systemRoot = root && path.win32.isAbsolute(root) ? root : "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "taskschd.msc");
}

/** The per-user LaunchAgents folder, where the old service's definition lives on macOS. */
export function launchAgentsFolder(homeDirectory: string): string {
  return path.posix.join(homeDirectory, "Library", "LaunchAgents");
}

/**
 * Opens the one fixed place for `target`: the Windows Task Scheduler through `openPath` (a `.msc` is a file, never an
 * `openExternal` URL), the macOS Login Items pane through `openExternal`, and the LaunchAgents folder through
 * `openPath` when the pane cannot be opened. A target that does not belong to this platform opens nothing.
 */
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
