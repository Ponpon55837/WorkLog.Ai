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
import { useAppearance } from "./composables/useAppearance";
import { invalidateActiveQueries, startAppRefreshEvents } from "./composables/useAppRefresh";
import { useHotkeys } from "./composables/useHotkeys";
import { useAppStore } from "./stores/app";
import { useDashboardStore } from "./stores/dashboard";
import { useProjectsStore } from "./stores/projects";
import { errorMessage as toErrorMessage } from "./utils/format";
import { locale, t } from "./i18n";

const route = useRoute();
const projectsStore = useProjectsStore();
const { dashboard, trackedProjects } = storeToRefs(projectsStore);
const { loadDashboard, loadProjects } = projectsStore;
const dashboardStore = useDashboardStore();
const { inbox } = storeToRefs(dashboardStore);
const { loadDashboardData } = dashboardStore;
const appStore = useAppStore();
const { appHealth, appHealthError } = storeToRefs(appStore);
const { loadHealth } = appStore;
const { isApiOffline } = useApiConnection();
useAppearance();

const loading = ref(true);
const refreshing = ref(false);
const errorMessage = ref("");
const paletteOpen = ref(false);

useHotkeys({ openPalette: () => (paletteOpen.value = true) });
const stopAppRefreshEvents = startAppRefreshEvents();

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
    errorMessage.value = toErrorMessage(error, t("無法載入 Work Intelligence，請確認本機 API 是否已啟動。"));
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
    errorMessage.value = toErrorMessage(error, t("重新整理失敗，請稍後再試。"));
  } finally {
    refreshing.value = false;
  }
}

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
    <Transition name="fade" mode="out-in">
      <UiFlash v-if="isApiOffline" key="offline" tone="danger" :title="t('無法連線到 Work Intelligence API')">
        {{ t("API 恢復連線後會自動重新載入目前頁面資料。") }}
      </UiFlash>
      <UiFlash v-else-if="errorMessage" key="error" tone="danger" :title="t('無法載入')">
        {{ errorMessage }}
        <template #actions
          ><UiButton size="sm" @click="refresh">{{ t("重試") }}</UiButton></template
        >
      </UiFlash>
    </Transition>
    <UiSkeleton v-if="loading" variant="card" :count="4" :label="t('正在載入 Work Intelligence…')" />
    <RouterView v-else v-slot="{ Component, route: current }">
      <!-- Keyed by route name: switching tabs inside a page keeps the page and only fades its panel.
           The locale is part of the key so a language switch re-runs setup code that translated once. -->
      <Transition name="page" mode="out-in">
        <div :key="`${String(current.name)}:${locale}`" class="page-view"><component :is="Component" /></div>
      </Transition>
    </RouterView>

    <template #overlays>
      <!-- Overlay state lives in stores, so remounting them on a language switch keeps what is open. -->
      <SessionPanel :key="`session-panel:${locale}`" />
      <KnowledgeHistoryPanel :key="`knowledge-history:${locale}`" />
      <KnowledgeEditorDialog :key="`knowledge-editor:${locale}`" />
      <SessionSummaryEditorDialog :key="`session-editor:${locale}`" />
      <RecordVoidDialog :key="`record-void:${locale}`" />
      <SessionLinkDialog :key="`session-link:${locale}`" />
      <HandoffImportDialog :key="`handoff-import:${locale}`" />
      <CommandPalette :key="`palette:${locale}`" v-model:open="paletteOpen" />
    </template>
  </AppShell>
</template>
