import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { ApiHealth } from "../api/client";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";

/** Owns app-wide health data that is shown in the shell on every route. */
export const useAppStore = defineStore("app", () => {
  const healthEnabled = ref(false);
  const healthQuery = useQuery({
    key: queryKeys.app.health,
    enabled: healthEnabled,
    query: ({ signal }) => useApi().client.getHealth(signal),
  });

  const appHealth = computed<ApiHealth | null>(() => healthQuery.data.value ?? null);
  const appHealthError = computed(() =>
    healthQuery.error.value
      ? errorMessage(healthQuery.error.value, "無法載入 Work Intelligence，請確認本機 API 是否已啟動。")
      : null,
  );

  async function loadHealth(): Promise<void> {
    try {
      await healthQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        healthEnabled.value = true;
        throw error;
      }
    }
    healthEnabled.value = true;
  }

  return { appHealth, appHealthError, loadHealth };
});
