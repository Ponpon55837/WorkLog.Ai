import { useMutation, useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type { SystemStatus } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { queryKeys } from "./query-keys";
import { usePreferencesStore } from "./preferences";
import type { Locale } from "../i18n";

function toLocale(shellLocale: "zh-TW" | "en"): Locale {
  return shellLocale === "en" ? "en-US" : "zh-TW";
}

/** The App's language is adopted when the status reports it, never written back; a language picked here is handed to the App. */
export const useDesktopLanguageStore = defineStore("desktop-language", () => {
  const preferencesStore = usePreferencesStore();
  const statusLoadEnabled = ref(false);
  // The System status page's own query (same key); waits for loadStatus() so a first load on that page asks once, not twice.
  const statusQuery = useQuery({
    key: queryKeys.views.systemStatus,
    enabled: statusLoadEnabled,
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

  function loadStatus(): void {
    statusLoadEnabled.value = true;
  }

  async function changeLocale(next: Locale): Promise<void> {
    preferencesStore.locale = next;
    if (!desktop.value?.managed) return;
    try {
      await setLanguageMutation.mutateAsync(next === "en-US" ? "en" : "zh-TW");
    } catch {
      // The local change stands; the App keeps its own language until the next successful pick.
    }
  }

  return { loadStatus, changeLocale };
});
