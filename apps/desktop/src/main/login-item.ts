import { app } from "electron";
import {
  changeLoginItem,
  loginItemQueryFor,
  readSystemLoginItem,
  writeDesktopSettingsAtomic,
  type LoginItemSetResult,
  type RepairLoginItemSection,
} from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import { applyLoginItem } from "./settings.js";
import type { ShellState } from "./state.js";

export interface LoginItemControllerOptions {
  readonly state: ShellState;
  readonly paths: Pick<DesktopPaths, "settingsFile">;
  readonly platform?: NodeJS.Platform;
  /** Reads Electron's login item answer; injectable so a test needs no real system. */
  readonly readSystem?: (query: ReturnType<typeof loginItemQueryFor>) => unknown;
  /** Applies the settings to the system (Electron's `setLoginItemSettings`). */
  readonly apply?: (state: ShellState) => void;
  /** Called after a change, so the backend's facts (the Web status) follow. */
  readonly changed?: () => void;
  readonly log: Logger;
}

export interface LoginItemController {
  section(): RepairLoginItemSection;
  set(enable: boolean): Promise<LoginItemSetResult>;
}

/**
 * The Settings tab's 「登入時自動啟動」 switch. The page sends only a boolean; the user's own click on the switch is the
 * consent that {@link changeLoginItem} requires for turning it on. The settings file is written the same atomic way as
 * every other App setting before the system's login item is touched, and the section always shows what the system says.
 */
export function createLoginItemController(options: LoginItemControllerOptions): LoginItemController {
  const { state, paths, log } = options;
  const platform = options.platform ?? process.platform;
  const readSystem =
    options.readSystem ?? ((query: ReturnType<typeof loginItemQueryFor>) => app.getLoginItemSettings(query as never));
  const apply = options.apply ?? applyLoginItem;
  const supported = loginItemQueryFor(platform) !== undefined;

  function section(): RepairLoginItemSection {
    const desired = state.settings?.desired.launchAtLogin === true;
    if (!supported) return { supported: false, desired, system: "unknown" };
    let raw: unknown;
    try {
      raw = readSystem(loginItemQueryFor(platform));
    } catch {
      raw = undefined;
    }
    return { supported: true, desired, system: readSystemLoginItem(platform, raw) };
  }

  return {
    section,
    async set(enable) {
      const { settings } = state;
      if (!supported) return { ok: false, reason: "unsupported" };
      if (!settings) return { ok: false, reason: "failed" };
      const change = changeLoginItem(settings, enable ? { enable: true, consent: true } : { enable: false }, platform);
      if (!change.ok) return { ok: false, reason: "failed" };
      try {
        await writeDesktopSettingsAtomic(paths.settingsFile, change.settings);
      } catch (error) {
        log(`[shell] login item setting not saved: ${error instanceof Error ? error.name : "unknown"}`);
        return { ok: false, reason: "failed" };
      }
      state.settings = change.settings;
      try {
        apply(state);
      } catch (error) {
        log(`[shell] login item not applied: ${error instanceof Error ? error.name : "unknown"}`);
      }
      state.touch();
      options.changed?.();
      return { ok: true, section: section() };
    },
  };
}
