import { useMutation, useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, watch } from "vue";
import type { SystemStatus } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { queryKeys } from "./query-keys";
import { usePreferencesStore } from "./preferences";
import type { Locale } from "../i18n";

/** The desktop App's locale names; the Dashboard's English is "en-US". */
function toLocale(shellLocale: "zh-TW" | "en"): Locale {
  return shellLocale === "en" ? "en-US" : "zh-TW";
}

/**
 * Keeps the Dashboard language and the desktop App's language in step. The App's language is adopted when the
 * status reports it (never written back); a language the user picks here is handed to the App when it manages this backend.
 */
export const useDesktopLanguageStore = defineStore("desktop-language", () => {
  const preferencesStore = usePreferencesStore();
  // Loaded from app start (not only on the System status page) so the language is adopted on the first load.
  const statusQuery = useQuery({
    key: queryKeys.desktop.status,
    query: ({ signal }): Promise<SystemStatus> => useApi().client.getSystemStatus(signal),
  });
  const setLanguageMutation = useMutation({
    mutation: (shellLocale: "zh-TW" | "en") => useApi().client.setDesktopLanguage(shellLocale),
  });

  const desktop = computed(() => statusQuery.data.value?.desktop);
  const appLocale = computed(() => desktop.value?.language?.locale);

  // Watches the App's reported value, not the page's locale, so a user pick never gets overwritten by a stale status.
  watch(
    appLocale,
    (reported) => {
      if (reported) preferencesStore.locale = toLocale(reported);
    },
    { immediate: true },
  );

  /** The user picked a language here: apply it, and tell the App when it manages this backend. */
  async function changeLocale(next: Locale): Promise<void> {
    preferencesStore.locale = next;
    if (!desktop.value?.managed) return;
    try {
      await setLanguageMutation.mutateAsync(next === "en-US" ? "en" : "zh-TW");
    } catch {
      // The local change stands; the App keeps its own language until the next successful pick.
    }
  }

  return { changeLocale };
});
