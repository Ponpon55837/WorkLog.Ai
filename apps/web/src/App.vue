<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import AppShell from "./components/layout/AppShell.vue";
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

// The global panels and dialogs render nothing until a store opens them, so their code loads as one separate chunk
// after the first paint instead of weighing down the entry bundle.
const AppOverlays = defineAsyncComponent(() => import("./components/layout/AppOverlays.vue"));

const projectsStore = useProjectsStore();
const { dashboard, trackedProjects } = storeToRefs(projectsStore);
const { loadDashboard, loadProjects } = projectsStore;
const dashboardStore = useDashboardStore();
const { attentionCount } = storeToRefs(dashboardStore);
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
const overlaysReady = ref(false);

useHotkeys({ openPalette: () => (paletteOpen.value = true) });
const stopAppRefreshEvents = startAppRefreshEvents();

const counts = computed(() => ({
  dashboard: { value: attentionCount.value ?? 0, tone: "attention" as const },
  sessions: { value: dashboard.value.finalizedSessions },
  projects: { value: trackedProjects.value.length },
}));

async function loadRootData(): Promise<void> {
  errorMessage.value = "";
  try {
    await Promise.all([loadDashboard(), loadProjects(), loadHealth(), loadDashboardData()]);
  } catch (error) {
    errorMessage.value = toErrorMessage(error, t("common.couldNotLoadWorkIntelligence"));
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
    errorMessage.value = toErrorMessage(error, t("app.refreshFailedPleaseTryAgain"));
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

onMounted(() => {
  void loadRootData();
  // Chunks are fetched once the browser is idle; a panel opened sooner mounts as soon as its chunk arrives.
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => (overlaysReady.value = true));
  else setTimeout(() => (overlaysReady.value = true), 0);
});

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
    @refresh="refresh"
    @search="paletteOpen = true"
  >
    <Transition name="fade" mode="out-in">
      <UiFlash v-if="isApiOffline" key="offline" tone="danger" :title="t('app.cannotReachTheWorkIntelligence')">
        {{ t("app.thisPageReloadsItsData") }}
      </UiFlash>
      <UiFlash v-else-if="errorMessage" key="error" tone="danger" :title="t('common.couldNotLoad')">
        {{ errorMessage }}
        <template #actions
          ><UiButton size="sm" @click="refresh">{{ t("common.retry") }}</UiButton></template
        >
      </UiFlash>
    </Transition>
    <UiSkeleton v-if="loading" variant="card" :count="4" :label="t('app.loadingWorkIntelligence')" />
    <RouterView v-else v-slot="{ Component, route: current }">
      <!-- Keyed by route name: switching tabs inside a page keeps the page and only fades its panel.
           The locale is part of the key so a language switch re-runs setup code that translated once. -->
      <Transition name="page" mode="out-in">
        <div
          :key="`${String(current.name)}:${locale}`"
          class="page-view"
          data-testid="page-view"
          :data-page="String(current.name)"
        >
          <component :is="Component" />
        </div>
      </Transition>
    </RouterView>

    <template v-if="overlaysReady" #overlays>
      <AppOverlays v-model:palette-open="paletteOpen" />
    </template>
  </AppShell>
</template>
