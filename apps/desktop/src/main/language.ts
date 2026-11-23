import {
  languagePreferenceOf,
  resolveShellLanguage,
  withLanguagePreference,
  type LanguageSetResult,
  type RepairLanguageSection,
} from "@work-intelligence/desktop-core";
import type { DesktopFacts, ShellLanguagePreference } from "@work-intelligence/schema";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

/** The App's language: the setting, the language every surface uses, and the one way to change it. */
export interface ShellLanguage {
  /** Takes the language from the settings and the system again; redraws everything when it changed. */
  apply(): void;
  /** What the Settings tab's 「語言」 card shows. */
  section(): RepairLanguageSection;
  /** What the Dashboard the App manages is told, so it shows the same language. */
  fact(): NonNullable<DesktopFacts["language"]>;
  /** The 「語言」 card: saves the choice, then redraws the window, the tray and the menu and tells the Dashboard. */
  set(preference: ShellLanguagePreference): Promise<LanguageSetResult>;
  /**
   * The user picked a language in the Dashboard. It becomes the App's setting, except when 「跟隨系統」 already reads as
   * that language: then nothing changes, so the App keeps following the system.
   */
  setFromDashboard(locale: "zh-TW" | "en"): Promise<LanguageSetResult>;
}

interface ShellLanguageOptions {
  readonly state: ShellState;
  readonly paths: Pick<DesktopPaths, "settingsFile">;
  /** The system language (`app.getLocale()` once Electron is ready, the preferred system language before). */
  readonly systemLocale: () => string | undefined;
  /** Redraws what shows the language and pushes the new facts to the backend; called after every change. */
  readonly onChange: () => void;
  readonly log: Logger;
}

export function createShellLanguage(options: ShellLanguageOptions): ShellLanguage {
  const { state, paths, log } = options;

  function systemLocale(): "zh-TW" | "en" {
    return resolveShellLanguage("system", options.systemLocale());
  }

  function apply(): void {
    // Without a settings file (the first-run page is open) a choice made on the page stays as it is.
    if (state.settings) state.languagePreference = languagePreferenceOf(state.settings);
    const next = resolveShellLanguage(state.languagePreference, options.systemLocale());
    if (next === state.locale) return;
    state.locale = next;
    options.onChange();
  }

  async function set(preference: ShellLanguagePreference): Promise<LanguageSetResult> {
    try {
      // Before the first-run page committed the settings there is no file: the choice waits in memory for the commit.
      await state.updateSettings(paths.settingsFile, (current) =>
        languagePreferenceOf(current) === preference ? null : withLanguagePreference(current, preference),
      );
    } catch {
      log("[shell] the language setting could not be saved");
      return { ok: false, reason: "failed" };
    }
    state.languagePreference = preference;
    state.locale = resolveShellLanguage(preference, options.systemLocale());
    log(`[shell] language ${preference} (${state.locale})`);
    // Also when the language stayed (跟隨系統 → the language it already read as): the card and the facts changed.
    options.onChange();
    return { ok: true };
  }

  return {
    apply,
    section: () => ({ preference: state.languagePreference, systemLocale: systemLocale() }),
    fact: () => ({ preference: state.languagePreference, locale: state.locale }),
    set,
    setFromDashboard: async (locale) => {
      if (locale === state.locale) return { ok: true };
      log("[shell] language changed in the Dashboard");
      return set(locale);
    },
  };
}
