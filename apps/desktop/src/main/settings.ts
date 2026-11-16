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

function defaultSettings(): DesktopSettingsV1 {
  const base = configDirectory();
  return {
    configVersion: 1,
    installId: randomUUID(),
    desired: {
      databasePath: join(base, "data", "work-intelligence.sqlite"),
      port: DEFAULT_PORT,
      launchAtLogin: false,
      backupDirectory: join(base, "backups"),
    },
  };
}

/** Reads the settings into the state (a new install gets the defaults); false when they need repair. */
export async function loadSettings(state: ShellState, paths: DesktopPaths, log: Logger): Promise<boolean> {
  const read = await readDesktopSettings(paths.settingsFile);
  if (read.kind === "ok") {
    state.settings = read.settings;
    return true;
  }
  if (read.kind === "new-install") {
    state.settings = defaultSettings();
    await writeDesktopSettingsAtomic(paths.settingsFile, state.settings);
    return true;
  }
  log(`[shell] settings need repair: ${read.reason}`);
  return false;
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
