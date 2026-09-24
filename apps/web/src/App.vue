<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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
import { useApi } from "./composables/useApi";
import { requestAppRefresh } from "./composables/useAppRefresh";
import { useDashboard } from "./composables/useDashboard";
import { useHotkeys } from "./composables/useHotkeys";
import { useProjects } from "./composables/useProjects";
import { errorMessage as toErrorMessage } from "./utils/format";

const route = useRoute();
const { dashboard, trackedProjects, loadProjects } = useProjects();
const { inbox, loadDashboardData } = useDashboard();
const loading = ref(true);
const refreshing = ref(false);
const errorMessage = ref("");
const paletteOpen = ref(false);

const counts = computed(() => ({
  dashboard: { value: inbox.value.length, tone: "attention" as const },
  sessions: { value: dashboard.value.finalizedSessions },
  projects: { value: trackedProjects.value.length },
}));

async function loadShared(): Promise<void> {
  errorMessage.value = "";
  try {
    await Promise.all([loadDashboardData(), loadProjects()]);
  } catch (error) {
    errorMessage.value = toErrorMessage(error, "無法載入 Work Intelligence，請確認本機 API 是否已啟動。");
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  await loadShared();
  requestAppRefresh();
  refreshing.value = false;
}

useHotkeys({ openPalette: () => (paletteOpen.value = true) });

onMounted(async () => {
  await loadShared();
  loading.value = false;
});

onBeforeUnmount(() => useApi().abortAll());
</script>

<template>
  <AppShell
    :refreshing="refreshing"
    :counts="counts"
    :full-width="route.name === 'graph'"
    @refresh="refresh"
    @search="paletteOpen = true"
  >
    <UiFlash v-if="errorMessage" tone="danger" title="無法連線">
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
