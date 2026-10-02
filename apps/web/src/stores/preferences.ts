import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { EDITOR_PROTOCOLS, type EditorProtocol } from "../utils/code-links";
import { detectLocale, isLocale, locale as activeLocale, type Locale } from "../i18n";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

const EDITOR_KEY = "work-intelligence:editor";
/** Also read by public/theme-init.js before the app loads, so the first paint uses the right theme. */
const THEME_KEY = "work-intelligence:theme";
const LOCALE_KEY = "work-intelligence:locale";

/** Browser storage can be missing or blocked (private windows, previews); the preference then lasts one visit. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Keep the in-memory choice when storage is unavailable.
  }
}

function readEditor(): EditorProtocol {
  const stored = readStored(EDITOR_KEY);
  return (EDITOR_PROTOCOLS as readonly string[]).includes(stored ?? "") ? (stored as EditorProtocol) : "none";
}

function readTheme(): ThemePreference {
  const stored = readStored(THEME_KEY);
  return (THEME_PREFERENCES as readonly string[]).includes(stored ?? "") ? (stored as ThemePreference) : "system";
}

function readLocale(): Locale {
  const stored = readStored(LOCALE_KEY);
  if (isLocale(stored)) return stored;
  return detectLocale(typeof navigator === "undefined" ? undefined : navigator.languages);
}

/** Personal preferences kept in this browser only, never sent to the local API. */
export const usePreferencesStore = defineStore("preferences", () => {
  const editor = ref<EditorProtocol>(readEditor());
  const theme = ref<ThemePreference>(readTheme());
  // The i18n module owns the locale ref so pure utils can translate; the store only persists it.
  const locale = activeLocale;
  locale.value = readLocale();
  /** Kept current by useAppearance's media-query listener. */
  const systemPrefersDark = ref(true);
  const resolvedTheme = computed<ResolvedTheme>(() => {
    if (theme.value === "system") return systemPrefersDark.value ? "dark" : "light";
    return theme.value;
  });

  watch(editor, (value) => writeStored(EDITOR_KEY, value));
  watch(theme, (value) => writeStored(THEME_KEY, value));
  watch(locale, (value) => writeStored(LOCALE_KEY, value));

  function $reset(): void {
    editor.value = "none";
    theme.value = "system";
    locale.value = "zh-TW";
  }

  return { editor, theme, locale, systemPrefersDark, resolvedTheme, $reset };
});
