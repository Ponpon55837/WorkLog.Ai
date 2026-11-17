import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app } from "electron";
import {
  changeLoginItem,
  loginItemSettingsFor,
  readDesktopSettings,
  writeDesktopSettingsAtomic,
  type DesktopSettingsV1,
} from "@work-intelligence/desktop-core";
import { configDirectory } from "@work-intelligence/shared/database-location";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

const DEFAULT_PORT = 3210;

/** What "使用預設設定開始" commits: the standalone locations, a new install id, and the login item as the user chose. */
export function defaultSettings(launchAtLogin = false, port: number = DEFAULT_PORT): DesktopSettingsV1 {
  const base = configDirectory();
  return {
    configVersion: 1,
    installId: randomUUID(),
    desired: {
      databasePath: join(base, "data", "work-intelligence.sqlite"),
      port,
      launchAtLogin,
      backupDirectory: join(base, "backups"),
    },
  };
}

export type SettingsLoad = "ok" | "new-install" | "repair";

/**
 * Reads the settings into the state. A new install writes nothing and starts nothing: the first-run page (DT-01) asks
 * first, and only a start that worked commits settings. An install that already has settings (an upgrade from 1.6.48
 * or earlier) never sees that page.
 */
export async function loadSettings(state: ShellState, paths: DesktopPaths, log: Logger): Promise<SettingsLoad> {
  const read = await readDesktopSettings(paths.settingsFile);
  if (read.kind === "ok") {
    state.settings = read.settings;
    return "ok";
  }
  if (read.kind === "new-install") {
    state.needsSetup = true;
    log("[shell] no settings yet: first-run setup");
    return "new-install";
  }
  log(`[shell] settings need repair: ${read.reason}`);
  return "repair";
}

/** Commits the settings the first-run page started with; the file is what marks the App as set up. */
export async function commitSettings(state: ShellState, paths: DesktopPaths): Promise<void> {
  if (!state.settings) return;
  await writeDesktopSettingsAtomic(paths.settingsFile, state.settings);
  state.needsSetup = false;
  state.touch();
}

/** Only the user's recorded consent keeps the login item on; a settings file never turns it on by itself. */
export function applyLoginItem(state: ShellState): void {
  const { settings } = state;
  if (!settings) return;
  const change = changeLoginItem(
    settings,
    settings.desired.launchAtLogin ? { enable: true, consent: true } : { enable: false },
    process.platform,
  );
  const item = change.ok ? change.loginItem : loginItemSettingsFor(process.platform, false);
  if (item) app.setLoginItemSettings({ ...item, args: item.args ? [...item.args] : undefined });
}
