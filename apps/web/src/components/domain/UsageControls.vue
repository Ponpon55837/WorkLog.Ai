<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { FolderTree, Gauge, Plus, ScanSearch, Trash2 } from "lucide-vue-next";
import type { UsageProjectItem, UsageRange } from "@work-intelligence/core";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCheckbox from "../ui/UiCheckbox.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSegmentedControl from "../ui/UiSegmentedControl.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import type { SelectOption } from "../ui/types";
import { useUsageStore } from "../../stores/usage";
import {
  canScanUsage,
  MAX_MANUAL_FOLDERS,
  toggleUsageGroup,
  usageProblemMessage,
  usageProjectLayout,
  type UsageScanControls,
} from "../../utils/usage";
import { t } from "../../i18n";

/** The project picker, range and manual-folder inputs of the Usage page; the draft is the parent's `v-model`. */
const emit = defineEmits<{ scan: [] }>();
const controls = defineModel<UsageScanControls>({ required: true });

const usageStore = useUsageStore();
const { projects, projectGroups, projectsLoaded, projectsLoading, projectsError, sharedRows, scanning } =
  storeToRefs(usageStore);

const rangeOptions = computed<SelectOption<UsageRange>[]>(() => [
  { value: "7d", label: t("usage.range7d") },
  { value: "30d", label: t("usage.range30d") },
  { value: "custom", label: t("usage.rangeCustom") },
]);
const selectedSet = computed(() => new Set(controls.value.projectIds));
const hasSource = computed(() => canScanUsage(controls.value));
const canScan = computed(() => hasSource.value && !scanning.value);
const pickerRows = computed(() => {
  const layout = usageProjectLayout(projects.value, projectGroups.value);
  return [
    ...layout.sections.flatMap((section) => [
      { kind: "group" as const, key: section.key, section },
      ...section.members.map((project) => ({ kind: "project" as const, key: project.id, project })),
    ]),
    ...layout.loose.map((project) => ({ kind: "project" as const, key: project.id, project })),
  ];
});
const sharedCounts = computed(
  () => new Map(sharedRows.value.flatMap((group) => group.projects.map((entry) => [entry.projectId, entry] as const))),
);
const manualFolderItems = computed(() =>
  controls.value.manualFolders.map((_, index) => ({
    index,
    label: t("usage.folderLabel", { index: index + 1 }),
    removeLabel: t("usage.removeFolder", { index: index + 1 }),
  })),
);

function update(patch: Partial<UsageScanControls>): void {
  controls.value = { ...controls.value, ...patch };
}

function isGroupSelected(ids: readonly string[]): boolean {
  return controls.value.all || ids.every((id) => selectedSet.value.has(id));
}

function allocationText(project: UsageProjectItem): string {
  const entry = sharedCounts.value.get(project.id);
  if (!entry) return "";
  return `${t("usage.allocatedCount", { count: entry.conversations })} · ${t("usage.basisCounts", entry.byBasis)}`;
}

function toggleAll(checked: boolean): void {
  update(checked ? { all: true, projectIds: [] } : { all: false });
}

function toggleGroup(ids: readonly string[]): void {
  update({ all: false, projectIds: toggleUsageGroup(controls.value.projectIds, ids, !isGroupSelected(ids)) });
}

function toggleProject(id: string, checked: boolean): void {
  update({ all: false, projectIds: toggleUsageGroup(controls.value.projectIds, [id], checked) });
}

function addFolder(): void {
  if (controls.value.manualFolders.length < MAX_MANUAL_FOLDERS) {
    update({ manualFolders: [...controls.value.manualFolders, ""] });
  }
}

function updateFolder(index: number, value: string): void {
  update({
    manualFolders: controls.value.manualFolders.map((folder, position) => (position === index ? value : folder)),
  });
}

function removeFolder(index: number): void {
  update({ manualFolders: controls.value.manualFolders.filter((_, position) => position !== index) });
}
</script>

<template>
  <UiBox data-testid="usage-controls">
    <template #header><UiBoxTitle :icon="Gauge" :title="t('usage.projects')" /></template>
    <UiFlash v-if="projectsError" tone="danger" :title="t('usage.errorTitle')">
      {{ projectsError }}
      <template #actions
        ><UiButton size="sm" @click="usageStore.refreshProjects">{{ t("common.retry") }}</UiButton></template
      >
    </UiFlash>
    <UiSkeleton
      v-else-if="projectsLoading && !projectsLoaded"
      variant="row"
      :count="2"
      :label="t('usage.loadingProjects')"
    />
    <template v-else>
      <UiBoxRow v-if="projects.length > 0">
        <template #leading
          ><UiCheckbox :model-value="controls.all" :label="t('usage.allProjects')" @update:model-value="toggleAll"
        /></template>
        <template #title>{{ t("usage.allProjects") }}</template>
      </UiBoxRow>
      <div class="usage-controls__list">
        <template v-for="row in pickerRows" :key="row.key">
          <UiBoxRow v-if="row.kind === 'group'" data-testid="usage-group">
            <template #title>{{ row.section.names }}</template>
            <template #labels
              ><UiLabel tone="accent" :icon="FolderTree">{{ t("usage.groupLabel") }}</UiLabel></template
            >
            <template #meta>{{ t("usage.groupHint") }}</template>
            <template #trailing
              ><UiButton
                size="sm"
                :disabled="controls.all"
                :title="row.section.names"
                data-testid="usage-group-select"
                @click="toggleGroup(row.section.projectIds)"
                >{{
                  isGroupSelected(row.section.projectIds) ? t("usage.groupClear") : t("usage.groupSelect")
                }}</UiButton
              ></template
            >
          </UiBoxRow>
          <UiBoxRow v-else data-testid="usage-project">
            <template #leading
              ><UiCheckbox
                :model-value="selectedSet.has(row.project.id)"
                :label="row.project.name"
                @update:model-value="toggleProject(row.project.id, $event)"
            /></template>
            <template #title>{{ row.project.name }}</template>
            <template #labels
              ><UiLabel v-if="row.project.current" tone="accent">{{ t("usage.currentProject") }}</UiLabel
              ><UiLabel v-if="row.project.problem" tone="attention">{{
                usageProblemMessage(row.project.problem)
              }}</UiLabel></template
            >
            <template #meta
              >{{
                t("usage.sourceCounts", {
                  claude: row.project.sources.claudeFolders,
                  codex: row.project.sources.codexFiles,
                })
              }}<template v-if="allocationText(row.project)"> · {{ allocationText(row.project) }}</template></template
            >
          </UiBoxRow>
        </template>
      </div>
      <UiEmptyState
        v-if="projects.length === 0"
        compact
        :icon="Gauge"
        :title="t('usage.noProjectsTitle')"
        :description="t('usage.noProjectsDescription')"
      />
    </template>

    <p v-if="!hasSource && projectsLoaded && projects.length > 0" class="usage-controls__hint">
      {{ t("usage.selectProject") }}
    </p>

    <div class="usage-controls__options">
      <UiField :label="t('usage.range')" group>
        <UiSegmentedControl
          :model-value="controls.range"
          :options="rangeOptions"
          :label="t('usage.range')"
          @update:model-value="update({ range: $event })"
        />
      </UiField>
      <template v-if="controls.range === 'custom'">
        <UiField :label="t('usage.since')">
          <UiTextInput
            :model-value="controls.since"
            type="date"
            :label="t('usage.since')"
            @update:model-value="update({ since: $event })"
          />
        </UiField>
        <UiField :label="t('usage.until')">
          <UiTextInput
            :model-value="controls.until"
            type="date"
            :label="t('usage.until')"
            @update:model-value="update({ until: $event })"
          />
        </UiField>
      </template>
    </div>

    <div class="usage-controls__advanced">
      <UiDisclosure :title="t('usage.advancedFolders')" :count="controls.manualFolders.length">
        <p class="usage-controls__hint">{{ t("usage.folderHint", { max: MAX_MANUAL_FOLDERS }) }}</p>
        <div v-for="item in manualFolderItems" :key="item.index" class="usage-controls__folder">
          <UiTextInput
            :model-value="controls.manualFolders[item.index] ?? ''"
            :label="item.label"
            :placeholder="t('usage.folderPlaceholder')"
            mono
            :maxlength="1024"
            @update:model-value="updateFolder(item.index, $event)"
          />
          <UiIconButton :icon="Trash2" :label="item.removeLabel" @click="removeFolder(item.index)" />
        </div>
        <UiButton
          size="sm"
          :icon="Plus"
          :disabled="controls.manualFolders.length >= MAX_MANUAL_FOLDERS"
          @click="addFolder"
          >{{ t("usage.addFolder") }}</UiButton
        >
      </UiDisclosure>
    </div>
    <template #footer>
      <UiButton
        variant="primary"
        class="usage-controls__scan"
        :icon="ScanSearch"
        :loading="scanning"
        :disabled="!canScan"
        @click="emit('scan')"
        >{{ t("usage.scan") }}</UiButton
      >
    </template>
  </UiBox>
</template>

<style scoped>
.usage-controls__list {
  border-top: 1px solid var(--border-muted);
}

.usage-controls__list > :deep(.ui-box-row:first-child) {
  border-top: 0;
}

.usage-controls__options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  align-items: end;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.usage-controls__advanced {
  padding: 0 var(--space-4) var(--space-4);
}

.usage-controls__folder {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-bottom: var(--space-2);
}

.usage-controls__folder > :first-child {
  flex: 1;
  min-width: 0;
}

.usage-controls__scan {
  flex: 1;
  justify-content: center;
}

.usage-controls__hint {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
</style>
