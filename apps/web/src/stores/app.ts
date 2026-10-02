import { useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { ApiHealth } from "../api/client";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

/** Owns app-wide health data that is shown in the shell on every route. */
export const useAppStore = defineStore("app", () => {
  const queryCache = useQueryCache();
  const healthEnabled = ref(false);
  const healthQuery = useQuery({
    key: queryKeys.app.health,
    enabled: healthEnabled,
    query: ({ signal }) => useApi().client.getHealth(signal),
  });

  const appHealth = computed<ApiHealth | null>(() => healthQuery.data.value ?? null);
  const appHealthError = computed(() =>
    healthQuery.error.value ? errorMessage(healthQuery.error.value, t("common.couldNotLoadWorkIntelligence")) : null,
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

  /** Cancels every in-flight query when the app shell unmounts; each query's fetch sees its signal abort. */
  function abortPendingRequests(): void {
    queryCache.cancelQueries();
  }

  return { appHealth, appHealthError, loadHealth, abortPendingRequests };
});
