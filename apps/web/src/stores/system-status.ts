import { useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { SystemStatus } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import { databaseInspectionStatus } from "../utils/status";
import { queryKeys } from "./query-keys";

/** Owns the system diagnostics query and its page-scoped request lifecycle. */
export const useSystemStatusStore = defineStore("system-status", () => {
  const queryCache = useQueryCache();
  const systemStatusActive = ref(false);
  const systemStatusQuery = useQuery({
    key: queryKeys.views.systemStatus,
    enabled: systemStatusActive,
    query: ({ signal }): Promise<SystemStatus> => useApi().client.getSystemStatus(signal),
  });

  const systemStatus = computed(() => systemStatusQuery.data.value ?? null);
  const systemStatusLoading = computed(() => systemStatusQuery.isLoading.value);
  const systemStatusError = computed(() =>
    systemStatusQuery.error.value
      ? errorMessage(systemStatusQuery.error.value, "無法載入系統狀態，請確認本機 API 是否已啟動。")
      : "",
  );
  const databaseStatus = computed(() =>
    systemStatus.value
      ? databaseInspectionStatus[systemStatus.value.database.state]
      : databaseInspectionStatus.unreadable,
  );

  async function refreshSystemStatus(): Promise<void> {
    try {
      await systemStatusQuery.refetch(true);
    } catch {
      // Query errors are exposed through systemStatusError for the page to render.
    }
  }

  function setSystemStatusActive(active: boolean): void {
    if (active) {
      // Invalidate before enabling so the enabled watcher starts exactly one fresh request on page entry.
      void queryCache.invalidateQueries({ key: queryKeys.views.systemStatus, exact: true }, false);
      systemStatusActive.value = true;
      return;
    }

    systemStatusActive.value = false;
    queryCache.cancelQueries({ key: queryKeys.views.systemStatus, exact: true });
  }

  return {
    systemStatus,
    systemStatusLoading,
    systemStatusError,
    databaseStatus,
    refreshSystemStatus,
    setSystemStatusActive,
  };
});
