import type { ShellLanguagePreference } from "@work-intelligence/schema";
import type { DesktopSettingsV1 } from "../settings/schema.js";
import { resolveShellLocale, type ShellLocale } from "./i18n.js";

/**
 * The one rule for the App's language. A chosen language wins; 「跟隨系統」 reads the system language (`zh-*` is
 * Traditional Chinese, anything else English). Every surface (the window, the tray, the menu, the dialogs, the
 * diagnostics and the Dashboard the App manages) takes its language from here.
 */
export function resolveShellLanguage(
  preference: ShellLanguagePreference,
  systemLocale: string | undefined,
): ShellLocale {
  return preference === "system" ? resolveShellLocale(systemLocale) : preference;
}

/** The language setting in `settings`. A file without one (every file before this setting existed) follows the system. */
export function languagePreferenceOf(settings: DesktopSettingsV1 | null): ShellLanguagePreference {
  return settings?.desired.language ?? "system";
}

/**
 * `settings` with the language set to `preference`. 「跟隨系統」 leaves the field out, so a user who never chose a
 * language keeps a file of the same shape older versions wrote.
 */
export function withLanguagePreference(
  settings: DesktopSettingsV1,
  preference: ShellLanguagePreference,
): DesktopSettingsV1 {
  const { language: _previous, ...desired } = settings.desired;
  return { ...settings, desired: preference === "system" ? desired : { ...desired, language: preference } };
}
