import { posix, win32 } from "node:path";
import type { LegacyServicePlatform } from "./types.js";

export const LEGACY_LAUNCHD_LABEL = "ai.workintelligence.server";
export const LEGACY_SYSTEMD_UNIT = "work-intelligence.service";
export const LEGACY_WINDOWS_TASK_NAME = "Work Intelligence";
export const LEGACY_WINDOWS_TASK_PATH = "\\";
export const LEGACY_RUNNER_RELATIVE_PATH = "scripts/service-runner.mjs";
export const LEGACY_DEFAULT_PORT = 3210;
export const LEGACY_SYSTEMD_DESCRIPTION = "Work Intelligence local server";

export interface LegacyServiceDefinitionPathOptions {
  platform: LegacyServicePlatform;
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
}

function isAbsoluteFor(platform: LegacyServicePlatform, value: string | undefined): value is string {
  return Boolean(value && (platform === "win32" ? win32 : posix).isAbsolute(value));
}

export function legacyServiceDefinitionPath(options: LegacyServiceDefinitionPathOptions): string {
  const { platform, homeDirectory, environment } = options;
  if (platform === "darwin") {
    return posix.join(homeDirectory, "Library", "LaunchAgents", `${LEGACY_LAUNCHD_LABEL}.plist`);
  }
  if (platform === "linux") {
    const configRoot = isAbsoluteFor(platform, environment.XDG_CONFIG_HOME)
      ? environment.XDG_CONFIG_HOME
      : posix.join(homeDirectory, ".config");
    return posix.join(configRoot, "systemd", "user", LEGACY_SYSTEMD_UNIT);
  }
  const localAppData = isAbsoluteFor(platform, environment.LOCALAPPDATA)
    ? environment.LOCALAPPDATA
    : win32.join(homeDirectory, "AppData", "Local");
  return win32.join(localAppData, LEGACY_WINDOWS_TASK_NAME, "service", "work-intelligence.task.xml");
}

export function legacyWindowsTaskTarget(): string {
  return `${LEGACY_WINDOWS_TASK_PATH}${LEGACY_WINDOWS_TASK_NAME}`;
}
