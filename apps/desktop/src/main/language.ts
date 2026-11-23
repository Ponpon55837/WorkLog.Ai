import {
  readLanguagePreference,
  resolveShellLanguage,
  writeLanguagePreference,
  type LanguageSetResult,
  type RepairLanguageSection,
} from "@work-intelligence/desktop-core";
import type { DesktopFacts, ShellLanguagePreference } from "@work-intelligence/schema";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

/** The App's language: the choice, the language every surface uses, and the one way to change it. */
export interface ShellLanguage {
  /** Reads the choice from its own file. Never fails: a missing or unusable file means 「跟隨系統」. */
  load(): Promise<void>;
  /** Takes the language from the choice and the system again; redraws everything when it changed. */
  apply(): void;
  /** What the Settings tab's 「語言」 card shows. */
  section(): RepairLanguageSection;
  /** What the Dashboard the App manages is told, so it shows the same language. */
  fact(): NonNullable<DesktopFacts["language"]>;
  /** The 「語言」 card: saves the choice, then redraws the window, the tray and the menu and tells the Dashboard. */
  set(preference: ShellLanguagePreference): Promise<LanguageSetResult>;
  /**
   * The user picked a language in the Dashboard. It becomes the App's choice, except when 「跟隨系統」 already reads as
   * that language: then nothing changes, so the App keeps following the system.
   */
  setFromDashboard(locale: "zh-TW" | "en"): Promise<LanguageSetResult>;
}

interface ShellLanguageOptions {
  readonly state: ShellState;
  readonly paths: Pick<DesktopPaths, "preferencesFile">;
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

  async function load(): Promise<void> {
    const read = await readLanguagePreference(paths.preferencesFile);
    // The file only holds a language: one that cannot be used is never a reason to repair, the App follows the system.
    if (read.problem) log(`[shell] the language file is ${read.problem}; following the system language`);
    state.languagePreference = read.preference;
    apply();
  }

  function apply(): void {
    const next = resolveShellLanguage(state.languagePreference, options.systemLocale());
    if (next === state.locale) return;
    state.locale = next;
    options.onChange();
  }

  async function set(preference: ShellLanguagePreference): Promise<LanguageSetResult> {
    try {
      await writeLanguagePreference(paths.preferencesFile, preference);
    } catch {
      log("[shell] the language choice could not be saved");
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
    load,
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
