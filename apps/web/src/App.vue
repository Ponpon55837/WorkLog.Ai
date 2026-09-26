<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useRoute } from "vue-router";
import AppShell from "./components/layout/AppShell.vue";
import CommandPalette from "./components/domain/CommandPalette.vue";
import HandoffImportDialog from "./components/domain/HandoffImportDialog.vue";
import KnowledgeEditorDialog from "./components/domain/KnowledgeEditorDialog.vue";
import KnowledgeHistoryPanel from "./components/domain/KnowledgeHistoryPanel.vue";
import RecordVoidDialog from "./components/domain/RecordVoidDialog.vue";
import SessionLinkDialog from "./components/domain/SessionLinkDialog.vue";
import SessionPanel from "./components/domain/SessionPanel.vue";
import SessionSummaryEditorDialog from "./components/domain/SessionSummaryEditorDialog.vue";
import UiButton from "./components/ui/UiButton.vue";
import UiFlash from "./components/ui/UiFlash.vue";
import UiSkeleton from "./components/ui/UiSkeleton.vue";
import { useApiConnection } from "./composables/useApiConnection";
import { invalidateActiveQueries, startAppRefreshEvents } from "./composables/useAppRefresh";
import { useHotkeys } from "./composables/useHotkeys";
import { useProjects } from "./composables/useProjects";
import { useAppStore } from "./stores/app";
import { useDashboardStore } from "./stores/dashboard";
import { errorMessage as toErrorMessage } from "./utils/format";

const route = useRoute();
const { dashboard, trackedProjects, loadDashboard, loadProjects } = useProjects();
const dashboardStore = useDashboardStore();
const { inbox } = storeToRefs(dashboardStore);
const { loadDashboardData } = dashboardStore;
const appStore = useAppStore();
const { appHealth, appHealthError } = storeToRefs(appStore);
const { loadHealth } = appStore;
const { isApiOffline } = useApiConnection();
const loading = ref(true);
const refreshing = ref(false);
const errorMessage = ref("");
const paletteOpen = ref(false);

const counts = computed(() => ({
  dashboard: { value: inbox.value.length, tone: "attention" as const },
  sessions: { value: dashboard.value.finalizedSessions },
  projects: { value: trackedProjects.value.length },
}));

async function loadRootData(): Promise<void> {
  errorMessage.value = "";
  try {
    await Promise.all([loadDashboard(), loadProjects(), loadHealth(), loadDashboardData()]);
  } catch (error) {
    errorMessage.value = toErrorMessage(error, "無法載入 Work Intelligence，請確認本機 API 是否已啟動。");
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  errorMessage.value = "";
  try {
    await invalidateActiveQueries();
  } catch (error) {
    errorMessage.value = toErrorMessage(error, "重新整理失敗，請稍後再試。");
  } finally {
    refreshing.value = false;
  }
}

useHotkeys({ openPalette: () => (paletteOpen.value = true) });
const stopAppRefreshEvents = startAppRefreshEvents();
watch(appHealthError, (message) => {
  if (message) {
    errorMessage.value = message;
  } else if (appHealth.value) {
    errorMessage.value = "";
  }
});
onMounted(() => void loadRootData());

onBeforeUnmount(() => {
  stopAppRefreshEvents();
  appStore.abortPendingRequests();
});
</script>

<template>
  <AppShell
    :refreshing="refreshing"
    :counts="counts"
    :app-health="appHealth"
    :full-width="route.name === 'graph'"
    @refresh="refresh"
    @search="paletteOpen = true"
  >
    <UiFlash v-if="isApiOffline" tone="danger" title="無法連線到 Work Intelligence API">
      API 恢復連線後會自動重新載入目前頁面資料。
    </UiFlash>
    <UiFlash v-if="errorMessage && !isApiOffline" tone="danger" title="無法載入">
      {{ errorMessage }}
      <template #actions><UiButton size="sm" @click="refresh">重試</UiButton></template>
    </UiFlash>
    <UiSkeleton v-if="loading" variant="card" :count="4" />
    <RouterView v-else />

    <template #overlays>
      <SessionPanel />
      <KnowledgeHistoryPanel />
      <KnowledgeEditorDialog />
      <SessionSummaryEditorDialog />
      <RecordVoidDialog />
      <SessionLinkDialog />
      <HandoffImportDialog />
      <CommandPalette v-model:open="paletteOpen" />
    </template>
  </AppShell>
</template>
