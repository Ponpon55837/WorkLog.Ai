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
  { value: "file", label: t("檔案") },
  { value: "directory", label: t("目錄") },
];
const periodOptions: { value: HotspotPeriod; label: string }[] = [
  { value: "30", label: t("最近 30 天") },
  { value: "90", label: t("最近 90 天") },
  { value: "365", label: t("最近一年") },
  { value: "all", label: t("全部期間") },
];

const hotspotsStore = useHotspotsStore();
const { groupBy, period, hotspots, hotspotsLoading, hotspotsError } = storeToRefs(hotspotsStore);
const sessionsStore = useSessionsStore();

const projectOptions = computed(() => [
  { value: "", label: t("所有記錄中專案") },
  ...props.projects.map((project) => ({ value: project.id, label: project.name })),
]);

function openSession(sessionId: string): void {
  void sessionsStore.openSessionDetail(sessionId, t("無法載入修改這個檔案的 Session。"));
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
      <UiBoxTitle :icon="Flame" :title="t('熱點檔案')" :count="hotspots.length" />
      <div class="graph-hotspots__tools">
        <UiSelect
          v-model="projectId"
          :options="projectOptions"
          :icon="FolderGit2"
          size="sm"
          :label="t('選擇熱點專案範圍')"
        />
        <UiSelect v-model="period" :options="periodOptions" size="sm" :label="t('選擇熱點期間')" />
        <UiSegmentedControl v-model="groupBy" :options="groupOptions" :label="t('熱點彙總方式')" />
      </div>
    </template>
    <UiFlash v-if="hotspotsError" tone="danger">{{ hotspotsError }}</UiFlash>
    <UiSkeleton v-if="hotspotsLoading && hotspots.length === 0" :count="4" :label="t('正在載入熱點檔案…')" />
    <UiEmptyState
      v-else-if="hotspots.length === 0"
      :icon="Flame"
      :title="t('這段期間沒有熱點')"
      :description="
        t('Session 記錄 changed files 後，這裡會列出被最多 Session 修改的檔案；改動超過 20 個檔案的 Session 不計入。')
      "
    />
    <HotspotList
      v-else
      :items="hotspots"
      :show-project="!projectId"
      :label="t('熱點檔案清單')"
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
