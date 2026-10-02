<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { storeToRefs } from "pinia";
import { Flame, FolderGit2 } from "lucide-vue-next";
import type { HotspotGroup, ProjectRecord } from "@work-intelligence/core";
import { useHotspotsStore, type HotspotPeriod } from "../../stores/hotspots";
import { useSessionsStore } from "../../stores/sessions";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSegmentedControl from "../ui/UiSegmentedControl.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import HotspotList from "./HotspotList.vue";
import { t } from "../../i18n";

/** The graph page's hotspot view: files or directories many Sessions changed, and how often they failed. */
const props = defineProps<{ projects: readonly ProjectRecord[] }>();
const projectId = defineModel<string>("projectId", { required: true });

const groupOptions: { value: HotspotGroup; label: string }[] = [
  { value: "file", label: t("graph.filesColumn") },
  { value: "directory", label: t("graph.folder") },
];
const periodOptions: { value: HotspotPeriod; label: string }[] = [
  { value: "30", label: t("graph.last30Days") },
  { value: "90", label: t("graph.last90Days") },
  { value: "365", label: t("graph.lastYear") },
  { value: "all", label: t("graph.allTime") },
];

const hotspotsStore = useHotspotsStore();
const { groupBy, period, hotspots, hotspotsLoading, hotspotsError } = storeToRefs(hotspotsStore);
const sessionsStore = useSessionsStore();

const projectOptions = computed(() => [
  { value: "", label: t("common.allTrackedProjects") },
  ...props.projects.map((project) => ({ value: project.id, label: project.name })),
]);

function openSession(sessionId: string): void {
  void sessionsStore.openSessionDetail(sessionId, t("graph.couldNotLoadTheSessionThatChangedThis"));
}

// The graph page keeps the project filter in the URL; the store follows it.
watch(
  projectId,
  (value) => {
    hotspotsStore.projectId = value;
  },
  { immediate: true },
);

onMounted(() => hotspotsStore.setActive(true));
onBeforeUnmount(() => hotspotsStore.setActive(false));
</script>

<template>
  <UiBox class="graph-hotspots" sticky-header data-testid="graph-hotspots">
    <template #header>
      <UiBoxTitle :icon="Flame" :title="t('graph.hotspotFiles')" :count="hotspots.length" />
      <div class="graph-hotspots__tools">
        <UiSelect
          v-model="projectId"
          :options="projectOptions"
          :icon="FolderGit2"
          size="sm"
          :label="t('graph.chooseHotspotProjectScope')"
        />
        <UiSelect v-model="period" :options="periodOptions" size="sm" :label="t('graph.chooseHotspotPeriod')" />
        <UiSegmentedControl v-model="groupBy" :options="groupOptions" :label="t('graph.hotspotGrouping')" />
      </div>
    </template>
    <UiFlash v-if="hotspotsError" tone="danger">{{ hotspotsError }}</UiFlash>
    <UiSkeleton v-if="hotspotsLoading && hotspots.length === 0" :count="4" :label="t('graph.loadingHotspotFiles')" />
    <UiEmptyState
      v-else-if="hotspots.length === 0"
      :icon="Flame"
      :title="t('graph.noHotspotsInThisPeriod')"
      :description="t('graph.onceSessionsRecordChangedFiles')"
    />
    <HotspotList
      v-else
      :items="hotspots"
      :show-project="!projectId"
      :label="t('graph.hotspotFileList')"
      @open-session="openSession"
    />
  </UiBox>
</template>

<style scoped>
.graph-hotspots__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
