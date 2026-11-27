import type { ShellLanguagePreference } from "@work-intelligence/schema";
import { formatMessage, type ShellLocale } from "./i18n.js";

export const LANGUAGE_CHOICES: readonly ShellLanguagePreference[] = ["system", "zh-TW", "en"];

export interface RepairLanguageSection {
  readonly preference: ShellLanguagePreference;
  readonly systemLocale: ShellLocale;
}

export interface LanguageMessages {
  readonly heading: string;
  readonly intro: string;
  readonly label: string;
  readonly followSystem: string;
  readonly failed: string;
}

const LANGUAGE_NAMES: Readonly<Record<ShellLocale, string>> = { "zh-TW": "繁體中文", en: "English" };

const zhTW: LanguageMessages = {
  heading: "語言",
  intro: "App 視窗、系統匣選單與 Dashboard 都會使用這個語言。在 Dashboard 改語言時，這裡也會跟著改。",
  label: "顯示語言",
  followSystem: "跟隨系統（{language}）",
  failed: "無法儲存語言設定，請稍後再試。",
};

const en: LanguageMessages = {
  heading: "Language",
  intro:
    "The App window, the tray menu and the Dashboard use this language. Changing the language in the Dashboard changes it here too.",
  label: "Display language",
  followSystem: "Follow system ({language})",
  failed: "Could not save the language setting. Try again later.",
};

export function languageMessages(locale: ShellLocale): LanguageMessages {
  return locale === "zh-TW" ? zhTW : en;
}

export function languageChoiceLabel(
  text: LanguageMessages,
  choice: ShellLanguagePreference,
  systemLocale: ShellLocale,
): string {
  return choice === "system"
    ? formatMessage(text.followSystem, { language: LANGUAGE_NAMES[systemLocale] })
    : LANGUAGE_NAMES[choice];
}
