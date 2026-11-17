import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { SystemStatus } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { errorMessage } from "../utils/format";
import { databaseInspectionStatus } from "../utils/status";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

/** Owns the system diagnostics query and its page-scoped request lifecycle. */
export const useSystemStatusStore = defineStore("system-status", () => {
  const queryCache = useQueryCache();
  const systemStatusActive = ref(false);
  const systemStatusQuery = useQuery({
    key: queryKeys.views.systemStatus,
    enabled: systemStatusActive,
    query: ({ signal }): Promise<SystemStatus> => useApi().client.getSystemStatus(signal),
  });

  const openAgentSetupMutation = useMutation({
    mutation: () => useApi().client.openDesktopAgentSetup(),
  });

  const systemStatus = computed(() => systemStatusQuery.data.value ?? null);
  const systemStatusLoading = computed(() => systemStatusQuery.isLoading.value);
  const systemStatusError = computed(() =>
    systemStatusQuery.error.value
      ? errorMessage(systemStatusQuery.error.value, t("systemStatus.couldNotLoadSystemStatusCheckThatThe"))
      : "",
  );
  const databaseStatus = computed(() =>
    systemStatus.value
      ? databaseInspectionStatus[systemStatus.value.database.state]
      : databaseInspectionStatus.unreadable,
  );

  const agentSetupOpening = computed(() => openAgentSetupMutation.isLoading.value);

  async function refreshSystemStatus(): Promise<void> {
    try {
      await systemStatusQuery.refetch(true);
    } catch {
      // Query errors are exposed through systemStatusError for the page to render.
    }
  }

  /** Asks the desktop App to open its Agent setup window (the App writes any config, never this page). */
  async function openDesktopAgentSetup(): Promise<void> {
    const { showToast } = useToast();
    try {
      await openAgentSetupMutation.mutateAsync();
      showToast(t("systemStatus.agentSetupOpenedInDesktopApp"), "success");
    } catch (error) {
      showToast(errorMessage(error, t("systemStatus.couldNotOpenAgentSetupInDesktopApp")), "danger");
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
    agentSetupOpening,
    refreshSystemStatus,
    openDesktopAgentSetup,
    setSystemStatusActive,
  };
});
