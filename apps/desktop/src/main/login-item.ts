import { app } from "electron";
import {
  changeLoginItem,
  loginItemQueryFor,
  readSystemLoginItem,
  type LoginItemSetResult,
  type RepairLoginItemSection,
} from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import { applyLoginItem } from "./settings.js";
import type { ShellState } from "./state.js";

const SYSTEM_READ_WINDOW_MS = 2_000;

export interface LoginItemControllerOptions {
  readonly state: ShellState;
  readonly paths: Pick<DesktopPaths, "settingsFile">;
  readonly platform?: NodeJS.Platform;
  readonly readSystem?: (query: ReturnType<typeof loginItemQueryFor>) => unknown;
  readonly apply?: (state: ShellState) => void;
  readonly changed?: () => void;
  readonly log: Logger;
}

export interface LoginItemController {
  section(): RepairLoginItemSection;
  set(enable: boolean): Promise<LoginItemSetResult>;
}

export function createLoginItemController(options: LoginItemControllerOptions): LoginItemController {
  const { state, paths, log } = options;
  const platform = options.platform ?? process.platform;
  const readSystem =
    options.readSystem ?? ((query: ReturnType<typeof loginItemQueryFor>) => app.getLoginItemSettings(query as never));
  const apply = options.apply ?? applyLoginItem;
  const supported = loginItemQueryFor(platform) !== undefined;
  let cached: { readonly at: number; readonly system: RepairLoginItemSection["system"] } | undefined;

  function section(): RepairLoginItemSection {
    const desired = state.settings?.desired.launchAtLogin === true;
    if (!supported) return { supported: false, desired, system: "unknown" };
    if (!state.settings) return { supported: true, desired, system: "unknown" };
    const now = Date.now();
    if (cached && now - cached.at < SYSTEM_READ_WINDOW_MS) return { supported: true, desired, system: cached.system };
    let raw: unknown;
    try {
      raw = readSystem(loginItemQueryFor(platform));
    } catch {
      raw = undefined;
    }
    const system = readSystemLoginItem(platform, raw);
    cached = { at: now, system };
    return { supported: true, desired, system };
  }

  return {
    section,
    async set(enable) {
      if (!supported) return { ok: false, reason: "unsupported" };
      if (!state.settings) return { ok: false, reason: "failed" };
      const request = enable ? ({ enable: true, consent: true } as const) : ({ enable: false } as const);
      let before = state.settings.desired.launchAtLogin;
      try {
        await state.updateSettings(paths.settingsFile, (current) => {
          before = current.desired.launchAtLogin;
          const change = changeLoginItem(current, request, platform);
          return change.ok ? change.settings : null;
        });
      } catch (error) {
        log(`[shell] login item setting not saved: ${error instanceof Error ? error.name : "unknown"}`);
        return { ok: false, reason: "failed" };
      }
      try {
        apply(state);
      } catch (error) {
        log(`[shell] login item not applied: ${error instanceof Error ? error.name : "unknown"}`);
        // The system refused: keep the file telling what the system really does, then report the failure with the real state.
        try {
          await state.updateSettings(paths.settingsFile, (current) => ({
            ...current,
            desired: { ...current.desired, launchAtLogin: before },
          }));
        } catch {
          log("[shell] login item setting not restored");
        }
        cached = undefined;
        state.touch();
        options.changed?.();
        return { ok: false, reason: "failed", section: section() };
      }
      cached = undefined;
      state.touch();
      options.changed?.();
      return { ok: true, section: section() };
    },
  };
}
