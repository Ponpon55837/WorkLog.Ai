import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { SystemStatus } from "@work-intelligence/core";
import type { BrowserPreferences } from "@work-intelligence/schema/port-handoff";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { errorMessage } from "../utils/format";
import { readBrowserPreferences } from "../utils/port-handoff";
import { databaseInspectionStatus } from "../utils/status";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

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

  const openPortSettingsMutation = useMutation({
    mutation: (handoff: { preferences: BrowserPreferences; route: string }) =>
      useApi().client.openDesktopPortSettings(handoff),
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

  const portSettingsOpening = computed(() => openPortSettingsMutation.isLoading.value);

  async function refreshSystemStatus(): Promise<void> {
    try {
      await systemStatusQuery.refetch(true);
    } catch {
      // The query keeps the error and the view renders it.
    }
  }

  /** The App writes any config, never this page. */
  async function openDesktopAgentSetup(): Promise<void> {
    const { showToast } = useToast();
    try {
      await openAgentSetupMutation.mutateAsync();
      showToast(t("systemStatus.agentSetupOpenedInDesktopApp"), "success");
    } catch (error) {
      showToast(errorMessage(error, t("systemStatus.couldNotOpenAgentSetupInDesktopApp")), "danger");
    }
  }

  /** The page's whitelisted preferences and current route path (not query or hash) travel with the request so the App can restore them at the new address. */
  async function openDesktopPortSettings(routePath: string): Promise<void> {
    const { showToast } = useToast();
    try {
      await openPortSettingsMutation.mutateAsync({
        preferences: readBrowserPreferences(browserStorage()),
        route: routePath,
      });
      showToast(t("systemStatus.portSettingsOpenedInDesktopApp"), "success");
    } catch (error) {
      showToast(errorMessage(error, t("systemStatus.couldNotOpenPortSettingsInDesktopApp")), "danger");
    }
  }

  function browserStorage(): Storage | undefined {
    try {
      return window.localStorage;
    } catch {
      return undefined;
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
    portSettingsOpening,
    refreshSystemStatus,
    openDesktopAgentSetup,
    openDesktopPortSettings,
    setSystemStatusActive,
  };
});
