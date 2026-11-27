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

export interface ShellLanguage {
  load(): Promise<void>;
  apply(): void;
  section(): RepairLanguageSection;
  fact(): NonNullable<DesktopFacts["language"]>;
  set(preference: ShellLanguagePreference): Promise<LanguageSetResult>;
  setFromDashboard(locale: "zh-TW" | "en"): Promise<LanguageSetResult>;
}

interface ShellLanguageOptions {
  readonly state: ShellState;
  readonly paths: Pick<DesktopPaths, "preferencesFile">;
  readonly systemLocale: () => string | undefined;
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
