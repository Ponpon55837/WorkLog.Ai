<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { Archive, DatabaseBackup, Download, RefreshCw, Trash2, Upload } from "lucide-vue-next";
import type { ProjectDataImportConflictCategory } from "@work-intelligence/core";
import { useBackupsStore } from "../../stores/backups";
import { useProjectDataTransferStore } from "../../stores/project-data-transfer";
import { useProjectsStore } from "../../stores/projects";
import { useSystemStatusStore } from "../../stores/system-status";
import { formatBytes, formatDate, formatRelative } from "../../utils/format";
import { databaseBackupKindLabels, projectDataTableLabels } from "../../utils/labels";
import { importBreakdown, importCountKinds, totalCount } from "../../utils/project-data-import";
import type { ImportBreakdownRow, ImportCountKind } from "../../utils/project-data-import";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCopyButton from "../ui/UiCopyButton.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import UiStack from "../ui/UiStack.vue";
import UiStatCard from "../ui/UiStatCard.vue";
import UiStatGrid from "../ui/UiStatGrid.vue";
import VirtualList from "../VirtualList.vue";
import { useDiscardImportOnLeave } from "../../composables/useDiscardImportOnLeave";
import { useMediaQuery } from "../../composables/useMediaQuery";
import { t } from "../../i18n";

const backupsStore = useBackupsStore();
const {
  backups,
  backupKeep,
  automaticBackupKeep,
  backupsLoading,
  backupsLoaded,
  backupsError,
  backupCreating,
  backupDeleting,
  databaseExporting,
} = storeToRefs(backupsStore);
const { loadBackups, createBackup, deleteBackup, exportDatabase } = backupsStore;
const systemStatusStore = useSystemStatusStore();
const { systemStatus } = storeToRefs(systemStatusStore);
const projectsStore = useProjectsStore();
const { projects } = storeToRefs(projectsStore);
const { loadProjects } = projectsStore;
const projectDataTransferStore = useProjectDataTransferStore();
const {
  transferError,
  portableExporting,
  importProjects,
  importFileName,
  importUploading,
  importProjectId,
  importStrategy,
  importLoading,
  importPreview,
  importError,
  importResult,
} = storeToRefs(projectDataTransferStore);
const {
  loadImportFile,
  refuseMultipleImportFiles,
  discardImportFile,
  previewProjectDataImport,
  chooseImportProjectLocation,
  applyProjectDataImport,
  exportProjectData,
} = projectDataTransferStore;
useDiscardImportOnLeave();

const scrollAfter = 6;
const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

const exportScope = ref<"all" | "project">("all");
const exportProjectId = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const dropzone = ref<HTMLElement | null>(null);
const chooseButton = ref<InstanceType<typeof UiButton> | null>(null);
const previewPanel = ref<HTMLElement | null>(null);
const resultPanel = ref<HTMLElement | null>(null);
const dragging = ref(false);
const exportScopeOptions = [
  { value: "all", label: t("projects.allProjects") },
  { value: "project", label: t("projects.singleProject") },
];

const totalBackupBytes = computed(() => backups.value.reduce((total, backup) => total + backup.bytes, 0));
// The desktop window never shows a command: it points to the App's Data tab instead.
const desktopManaged = computed(() => systemStatus.value?.desktop?.managed === true);
const restoreCommand = t("projects.pnpmDbRestoreExportFile");
const exportProjectOptions = computed(() =>
  projects.value.map((project) => ({ value: project.id, label: project.name })),
);
const importProjectOptions = computed(() => [
  { value: "", label: t("projects.allProjects") },
  ...importProjects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const previewSummary = computed(() => {
  const preview = importPreview.value;
  if (!preview) return null;
  return {
    additions: totalCount(preview.additions),
    updates: totalCount(preview.updates),
    keptLocal: totalCount(preview.keptLocal),
    renumbered: totalCount(preview.renumbered),
    replacedLocal: totalCount(preview.replacedLocal),
    skipped: totalCount(preview.skipped),
    conflicts: totalCount(preview.conflicts),
    breakdown: importBreakdown(preview),
  };
});
const conflictCategories = computed(() => new Set(importPreview.value?.conflictGroups.map((group) => group.category)));
const blockedByConflicts = computed(
  () => importPreview.value?.writesData === false && (previewSummary.value?.conflicts ?? 0) > 0,
);
const canUseNewerWins = computed(
  () => importPreview.value?.strategy === "merge" && conflictCategories.value.has("newer_content"),
);
const importCountLabels: Record<ImportCountKind, string> = {
  additions: t("common.added"),
  updates: t("projects.updated"),
  keptLocal: t("projects.keptLocal"),
  skipped: t("projects.skipped"),
  conflicts: t("projects.conflicts"),
};
const importFileLabel = computed(() => importFileName.value || t("projects.noFileChosen"));
const importResultMessage = computed(() => {
  const result = importResult.value;
  if (!result) return "";
  if (!result.changed) return t("projects.importFinishedNothingChanged");
  return t("projects.importFinishedAddedSkippedIn", {
    value: totalCount(result.additions),
    updates: totalCount(result.updates),
    value2: totalCount(result.skipped),
    value3: totalCount(result.conflicts),
  });
});
const importProjectResolutionLabels = {
  existing: t("projects.matchedAnExistingProject"),
  new: t("projects.projectsToAdd"),
  conflict: t("projects.projectConflicts"),
} as const;
const importStrategyOptions = [
  { value: "newer-wins", label: t("projects.importStrategyNewerWins") },
  { value: "merge", label: t("projects.importStrategyMerge") },
];
const importConflictCategoryLabels: Record<ProjectDataImportConflictCategory, string> = {
  path: t("projects.conflictCategoryPath"),
  newer_content: t("projects.conflictCategoryNewerContent"),
  content: t("projects.conflictCategoryContent"),
  unique: t("projects.conflictCategoryUnique"),
  dependency: t("projects.conflictCategoryDependency"),
  missing_parent: t("projects.conflictCategoryMissingParent"),
  deleted: t("projects.conflictCategoryDeleted"),
};
const importFolderStatusLabels = {
  found: t("projects.folderFound"),
  missing: t("projects.thisFolderWasNotFound"),
  unavailable: t("projects.cannotCheckTheFolder"),
} as const;
const remappedProjectCount = computed(
  () => importPreview.value?.remappedPaths.reduce((total, item) => total + item.projects, 0) ?? 0,
);
const remappedSnapshotCount = computed(
  () => importPreview.value?.remappedPaths.reduce((total, item) => total + item.snapshots, 0) ?? 0,
);
const autoRemappedSnapshotCount = computed(
  () => importPreview.value?.autoRemaps.reduce((total, item) => total + item.snapshots, 0) ?? 0,
);

function exportPortableData(): Promise<void> {
  if (exportScope.value === "project") {
    return exportProjectId.value
      ? exportProjectData({ type: "project", projectId: exportProjectId.value })
      : Promise.resolve();
  }
  return exportProjectData({ type: "all" });
}

function breakdownCounts(row: ImportBreakdownRow): string {
  return importCountKinds
    .filter((kind) => row.counts[kind] !== undefined)
    .map((kind) => `${importCountLabels[kind]} ${row.counts[kind]}`)
    .join(" · ");
}

function chooseImportFile(): void {
  fileInput.value?.click();
}

async function importFile(file: File): Promise<void> {
  await loadImportFile(file);
  await nextTick();
  const panel = previewPanel.value;
  if (!panel) return;
  panel.scrollIntoView({ behavior: reduceMotion.value ? "auto" : "smooth", block: "start" });
  panel.focus({ preventScroll: true });
}

async function onImportFileChange(event: Event): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  // Clearing the value lets the same file be chosen again after it was discarded.
  input.value = "";
  if (file) await importFile(file);
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

function onDragOver(event: DragEvent): void {
  dragging.value = !importLoading.value;
  if (event.dataTransfer) event.dataTransfer.dropEffect = importLoading.value ? "none" : "copy";
}

// A file dropped outside the zone would make the window open it and leave the app.
function blockWindowFileDrop(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  if (event.target instanceof Node && dropzone.value?.contains(event.target)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
}

function onDragLeave(event: DragEvent): void {
  const zone = event.currentTarget;
  if (zone instanceof Node && event.relatedTarget instanceof Node && zone.contains(event.relatedTarget)) return;
  dragging.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
  dragging.value = false;
  const files = event.dataTransfer?.files;
  if (!files?.length || importLoading.value) return;
  if (files.length > 1) refuseMultipleImportFiles();
  else await importFile(files[0]!);
}

async function finishImport(): Promise<void> {
  discardImportFile();
  await nextTick();
  const button = chooseButton.value?.$el;
  if (button instanceof HTMLElement) button.focus();
}

function useNewerWins(): void {
  importStrategy.value = "newer-wins";
}

watch(importResult, async (result) => {
  if (!result) return;
  await nextTick();
  resultPanel.value?.focus();
});

onMounted(() => {
  window.addEventListener("dragover", blockWindowFileDrop);
  window.addEventListener("drop", blockWindowFileDrop);
  backupsStore.setBackupsActive(true);
  systemStatusStore.setSystemStatusActive(true);
  void loadProjects();
});
onBeforeUnmount(() => {
  window.removeEventListener("dragover", blockWindowFileDrop);
  window.removeEventListener("drop", blockWindowFileDrop);
  backupsStore.setBackupsActive(false);
  systemStatusStore.setSystemStatusActive(false);
});
</script>

<template>
  <UiStack class="backup-section">
    <UiFlash v-if="backupsError" tone="danger">{{ backupsError }}</UiFlash>

    <UiFlash tone="accent" :title="t('projects.purposeGuideTitle')" data-testid="backup-purpose-guide">
      <ul class="backup-section__purposes">
        <li>
          <strong>{{ t("projects.purposeMoveLead") }}</strong>
          <span>{{ t("projects.purposeMoveBody") }}</span>
        </li>
        <li>
          <strong>{{ t("projects.purposeRestoreLead") }}</strong>
          <span>{{ t("projects.purposeRestoreBody") }}</span>
        </li>
      </ul>
    </UiFlash>

    <UiBox>
      <template #header>
        <UiBoxTitle
          :icon="Archive"
          :title="t('projects.dataBackup')"
          :count="backupsLoaded ? backups.length : undefined"
        />
        <div class="backup-section__actions">
          <UiIconButton
            :icon="RefreshCw"
            :label="t('projects.refreshBackupList')"
            size="sm"
            :loading="backupsLoading"
            @click="loadBackups"
          />
          <UiButton size="sm" :icon="DatabaseBackup" :loading="backupCreating" @click="createBackup">{{
            t("projects.backUpNow")
          }}</UiButton>
        </div>
      </template>
      <p v-if="backupsLoaded" class="backup-section__note">
        {{ t("projects.theApiServerMakesOne") }}
        <code>backups/</code>
        {{
          t("projects.folderAutomaticBackupsAreKept", {
            automaticBackupKeep,
            backupKeep,
            length: backups.length,
            value: formatBytes(totalBackupBytes),
          })
        }}
      </p>
      <UiSkeleton v-if="!backupsLoaded && !backupsError" :count="2" :label="t('projects.loadingBackups')" />
      <UiEmptyState
        v-else-if="backups.length === 0 && !backupsLoading"
        compact
        :icon="Archive"
        :title="t('projects.noBackupsYet')"
        :description="t('projects.pressBackUpNowTo')"
      />
      <!-- Past a handful of backups the list scrolls inside its Box instead of stretching the page. -->
      <VirtualList
        v-else
        :items="backups"
        :enabled="backups.length > scrollAfter"
        fit-viewport
        :estimate-item-height="60"
        :label="t('projects.backupList')"
      >
        <template #default="{ item }">
          <UiBoxRow
            :title="item.fileName"
            :meta="`${databaseBackupKindLabels[item.kind]} · ${formatRelative(item.createdAt)} · ${formatBytes(item.bytes)}`"
          >
            <template #leading><Archive :size="16" :stroke-width="1.75" aria-hidden="true" /></template>
            <template #trailing>
              <div class="backup-section__row-actions">
                <time :datetime="item.createdAt" class="backup-section__time">{{ formatDate(item.createdAt) }}</time>
                <UiIconButton
                  :icon="Trash2"
                  variant="danger"
                  size="sm"
                  :label="t('projects.deleteBackup', { fileName: item.fileName })"
                  :loading="backupDeleting === item.fileName"
                  :disabled="backupDeleting !== null"
                  @click="deleteBackup(item)"
                />
              </div>
            </template>
          </UiBoxRow>
        </template>
      </VirtualList>
    </UiBox>

    <UiBox padded>
      <template #header>
        <UiBoxTitle :icon="Download" :title="t('projects.exportProjectDataTitle')" :count="projects.length" />
      </template>
      <UiFlash v-if="transferError" tone="danger">{{ transferError }}</UiFlash>
      <p class="backup-section__hint backup-section__hint--first">{{ t("projects.jsonExportNotEncrypted") }}</p>
      <div class="transfer-controls">
        <UiField :label="t('projects.exportScope')">
          <UiSelect v-model="exportScope" :options="exportScopeOptions" :label="t('projects.exportScope')" />
        </UiField>
        <UiField v-if="exportScope === 'project'" :label="t('projects.exportProjects')">
          <UiSelect
            v-model="exportProjectId"
            :options="exportProjectOptions"
            :label="t('projects.exportProjects')"
            :disabled="projects.length === 0"
          />
        </UiField>
        <UiButton
          class="transfer-controls__action"
          :icon="Download"
          :loading="portableExporting"
          :disabled="exportScope === 'project' && !exportProjectId"
          @click="exportPortableData"
        >
          {{ t("common.exportJson") }}
        </UiButton>
      </div>
    </UiBox>

    <UiBox padded>
      <template #header>
        <UiBoxTitle :icon="Upload" :title="t('projects.importProjectDataTitle')" />
      </template>
      <p class="backup-section__hint backup-section__hint--first">{{ t("projects.importMergesData") }}</p>

      <div
        ref="dropzone"
        :class="['transfer-drop', { 'is-dragging': dragging }]"
        data-testid="project-import-dropzone"
        @dragenter.prevent="onDragOver"
        @dragover.prevent="onDragOver"
        @dragleave="onDragLeave"
        @drop.prevent="onDrop"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          hidden
          :aria-label="t('projects.importFile')"
          :disabled="importLoading"
          @change="onImportFileChange"
        />
        <UiButton ref="chooseButton" :icon="Upload" :disabled="importLoading" @click="chooseImportFile">{{
          t("projects.chooseFile")
        }}</UiButton>
        <div class="transfer-drop__text">
          <strong class="transfer-drop__name" data-testid="project-import-file-name">{{ importFileLabel }}</strong>
          <span class="transfer-drop__hint">{{
            dragging ? t("projects.dropToChooseFile") : t("projects.dropJsonHere")
          }}</span>
          <span class="transfer-drop__hint">{{ t("projects.chooseAWorkIntelligenceJson") }}</span>
        </div>
      </div>

      <div class="transfer-controls transfer-controls--import">
        <UiField v-if="importProjects.length > 1" :label="t('projects.importScope')">
          <UiSelect v-model="importProjectId" :options="importProjectOptions" :label="t('projects.importScope')" />
        </UiField>
        <UiField :label="t('projects.importStrategy')">
          <UiSelect
            v-model="importStrategy"
            :options="importStrategyOptions"
            :label="t('projects.importStrategy')"
            data-testid="project-import-strategy"
          />
        </UiField>
      </div>
      <div class="transfer-controls__footer">
        <p class="backup-section__hint">
          {{ t("projects.theFileIsPreviewedAs") }}
        </p>
        <UiButton :loading="importLoading" :disabled="!importFileName" @click="previewProjectDataImport">
          {{ t("projects.previewAgain") }}
        </UiButton>
      </div>

      <!-- The browser's fetch exposes no upload progress, so the wait is shown as an indeterminate state. -->
      <UiSkeleton
        v-if="importUploading"
        variant="text"
        :count="1"
        :label="t('projects.uploadingAndCheckingImport', { name: importFileName })"
        data-testid="project-import-uploading"
      />
      <UiFlash v-if="importError" tone="danger">{{ importError }}</UiFlash>
      <div
        v-if="importResult"
        ref="resultPanel"
        class="transfer-result"
        tabindex="-1"
        data-testid="project-import-result"
      >
        <UiFlash tone="success" dismissible @dismiss="finishImport">
          <span>{{ importResultMessage }}</span>
          <template #actions>
            <UiButton size="sm" :to="{ name: 'projects', params: { tab: 'registry' } }">{{
              t("projects.goToProjectList")
            }}</UiButton>
          </template>
        </UiFlash>
      </div>
      <div
        v-if="importPreview && previewSummary"
        ref="previewPanel"
        class="transfer-preview"
        role="region"
        tabindex="-1"
        :aria-label="t('projects.importPreview')"
        data-testid="project-import-preview"
      >
        <p>{{ t("projects.importProjectsAndApplyPaths") }}</p>
        <VirtualList
          :items="importPreview.selectedProjects"
          :enabled="importPreview.selectedProjects.length > 4"
          :estimate-item-height="68"
          max-height="min(40vh, 320px)"
          :label="t('projects.importProjectsAndPaths')"
          data-testid="project-import-selected-projects"
        >
          <template #default="{ item }">
            <UiBoxRow
              class="transfer-preview__project-row"
              :title="item.name"
              :meta="`${item.sourceRootPath}${item.rootPath !== item.sourceRootPath ? ` → ${item.rootPath}` : ''} · ${importProjectResolutionLabels[item.resolution]}`"
            >
              <template #trailing>
                <span class="backup-section__folder-status">
                  {{ item.folderStatus ? importFolderStatusLabels[item.folderStatus] : t("projects.notCheckedYet") }}
                </span>
                <UiButton
                  v-if="item.folderStatus !== 'found'"
                  size="sm"
                  :disabled="importLoading"
                  @click="chooseImportProjectLocation(item.id)"
                  >{{ t("projects.chooseANewLocationFor", { name: item.name }) }}</UiButton
                >
              </template>
            </UiBoxRow>
          </template>
        </VirtualList>
        <UiStatGrid :columns="5">
          <UiStatCard
            compact
            data-testid="project-import-additions"
            :label="t('common.added')"
            :value="previewSummary.additions"
            :foot="t('projects.additionsMeaning')"
          />
          <UiStatCard
            compact
            data-testid="project-import-updates"
            :label="t('projects.updated')"
            :value="previewSummary.updates"
            :foot="t('projects.updatesMeaning')"
          />
          <UiStatCard
            compact
            data-testid="project-import-kept-local"
            :label="t('projects.keptLocal')"
            :value="previewSummary.keptLocal"
            :foot="t('projects.keptLocalMeaning')"
          />
          <UiStatCard
            compact
            data-testid="project-import-skipped"
            :label="t('projects.skipped')"
            :value="previewSummary.skipped"
            :foot="t('projects.skippedMeaning')"
          />
          <UiStatCard
            compact
            data-testid="project-import-conflicts"
            :label="t('projects.conflicts')"
            :value="previewSummary.conflicts"
            :foot="t('projects.conflictsMeaning')"
          />
        </UiStatGrid>
        <UiDisclosure
          v-if="previewSummary.breakdown.length > 0"
          :title="t('projects.breakdownByRecordType')"
          :count="previewSummary.breakdown.length"
          data-testid="project-import-breakdown"
        >
          <ul class="transfer-breakdown" tabindex="0" :aria-label="t('projects.breakdownByRecordType')">
            <li v-for="row in previewSummary.breakdown" :key="row.table">
              <span class="transfer-breakdown__name">{{ projectDataTableLabels[row.table] }}</span>
              <span class="transfer-breakdown__counts">{{ breakdownCounts(row) }}</span>
            </li>
          </ul>
        </UiDisclosure>
        <p v-if="remappedProjectCount > 0 || remappedSnapshotCount > 0" class="backup-section__hint">
          {{
            t("projects.pathRemappingAppliedProjectsHandoffs", {
              remappedProjectCount,
              remappedSnapshotCount,
            })
          }}
        </p>
        <p v-if="importPreview.autoRemaps.length > 0" class="backup-section__hint">
          {{
            t("projects.autoRemappedRoots", {
              count: importPreview.autoRemaps.length,
              snapshots: autoRemappedSnapshotCount,
            })
          }}
        </p>
        <p v-if="previewSummary.renumbered > 0" class="backup-section__hint">
          {{ t("projects.pageVersionsRenumbered", { count: previewSummary.renumbered }) }}
        </p>
        <p v-if="previewSummary.replacedLocal > 0" class="backup-section__hint">
          {{ t("projects.staleDecisionsReplaced", { count: previewSummary.replacedLocal }) }}
        </p>
        <p v-if="importPreview.conventionsWithdrawn" class="backup-section__hint">
          {{ t("projects.conventionsWithdrawnOnImport", { count: importPreview.conventionsWithdrawn }) }}
        </p>
        <VirtualList
          v-if="importPreview.conflictGroups.length > 0"
          :items="importPreview.conflictGroups"
          :enabled="importPreview.conflictGroups.length > 4"
          :estimate-item-height="68"
          max-height="min(40vh, 320px)"
          :label="t('projects.importConflicts')"
          data-testid="project-import-conflict-groups"
        >
          <template #default="{ item }">
            <UiBoxRow
              class="transfer-preview__project-row"
              :title="item.reason"
              :meta="
                t('projects.conflictGroupMeta', {
                  category: importConflictCategoryLabels[item.category],
                  table: projectDataTableLabels[item.table],
                  count: item.count,
                  samples: item.sampleIds.join(', '),
                })
              "
            />
          </template>
        </VirtualList>
        <p class="backup-section__hint">
          {{
            importPreview.strategy === "newer-wins" ? t("projects.importNewerWinsHint") : t("projects.importMergeHint")
          }}
        </p>
        <UiButton
          v-if="importPreview.writesData"
          class="transfer-preview__action"
          variant="primary"
          :loading="importLoading"
          @click="applyProjectDataImport"
          >{{ t("projects.confirmAndImport") }}</UiButton
        >
        <template v-else-if="blockedByConflicts">
          <UiFlash tone="attention" :title="t('projects.blockedByConflicts')" data-testid="project-import-blocked">
            <p>{{ t("projects.blockedByConflictsDetail") }}</p>
            <p v-if="canUseNewerWins">{{ t("projects.blockedNewerContentHint") }}</p>
            <p v-if="conflictCategories.has('path')">{{ t("projects.blockedPathHint") }}</p>
          </UiFlash>
          <div class="transfer-preview__actions">
            <UiButton v-if="canUseNewerWins" :disabled="importLoading" @click="useNewerWins">{{
              t("projects.useNewerWins")
            }}</UiButton>
            <UiButton :disabled="importLoading" @click="finishImport">{{ t("projects.discardImportFile") }}</UiButton>
          </div>
        </template>
        <template v-else>
          <UiFlash tone="accent" :title="t('projects.nothingToImport')" data-testid="project-import-nothing">{{
            t("projects.nothingToImportDetail")
          }}</UiFlash>
          <UiButton class="transfer-preview__action" :disabled="importLoading" @click="finishImport">{{
            t("projects.finishImport")
          }}</UiButton>
        </template>
      </div>
    </UiBox>

    <UiBox padded>
      <template #header>
        <UiBoxTitle :icon="Download" :title="t('projects.exportAllData')" />
        <UiButton size="sm" variant="primary" :icon="Download" :loading="databaseExporting" @click="exportDatabase">{{
          t("common.export")
        }}</UiButton>
      </template>
      <p>
        {{ t("projects.exportA") }} <code>.sqlite</code>
        {{ t("projects.fileContainingEveryProjectSession") }}
      </p>
      <p v-if="desktopManaged" data-testid="restore-in-desktop-app">{{ t("projects.restoreInDesktopApp") }}</p>
      <UiDisclosure v-else class="backup-section__restore" :title="t('projects.advancedRestoreWithCommand')">
        <div class="backup-section__restore-body">
          <ol class="backup-section__steps">
            <li>
              {{ t("projects.installWorkIntelligenceOnThe") }} <code>pnpm build</code>{{ t("common.sentenceEnd") }}
            </li>
            <li>{{ t("projects.makeSureTheApiServer") }}</li>
            <li>
              {{ t("projects.runTheCommandBelowFrom") }}
              <code>--remap-root</code> {{ t("projects.toReplaceThePathPrefix") }}
            </li>
          </ol>
          <div class="backup-section__command">
            <code>{{ restoreCommand }}</code>
            <UiCopyButton
              :text="restoreCommand"
              :label="t('projects.copyRestoreCommand')"
              :success-message="t('projects.restoreCommandCopied')"
              size="sm"
            />
          </div>
        </div>
      </UiDisclosure>
      <p class="backup-section__hint">
        {{ t("projects.beforeRestoringTheExistingData") }}
      </p>
    </UiBox>
  </UiStack>
</template>

<style scoped>
.backup-section__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.backup-section__row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.backup-section__note,
.backup-section__hint {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.backup-section__time {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.backup-section__folder-status {
  max-width: 14rem;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  text-align: right;
}

.backup-section__note {
  padding: var(--space-3) var(--space-4) 0;
}

.backup-section__hint {
  margin-top: var(--space-3);
}

.backup-section__hint--first {
  margin-top: 0;
}

.backup-section__purposes {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-1) 0 0;
  padding-left: var(--space-4);
}

.backup-section__purposes strong,
.backup-section__purposes span {
  display: block;
}

.backup-section__steps {
  display: grid;
  gap: var(--space-1);
  margin: 0 0 var(--space-3);
  padding-left: var(--space-6);
}

.backup-section__restore {
  margin-top: var(--space-3);
}

.backup-section__restore-body {
  padding: var(--space-3) var(--space-4);
}

.backup-section__command {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-inset);
}

.backup-section__command code {
  flex: 1 1 280px;
  min-width: 0;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.transfer-controls {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 260px));
  align-items: end;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.transfer-controls__action {
  justify-self: start;
}

.transfer-controls--import {
  align-items: start;
}

.transfer-controls__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
  margin-top: var(--space-3);
}

.transfer-controls__footer .backup-section__hint {
  flex: 1 1 320px;
  margin: 0;
}

.transfer-drop {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-4);
  margin-top: var(--space-4);
  padding: var(--space-4);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}

.transfer-drop.is-dragging {
  border-style: solid;
  border-color: var(--accent);
  background: var(--accent-soft);
}

.transfer-drop__text {
  display: grid;
  flex: 1 1 240px;
  gap: 2px;
  min-width: 0;
}

.transfer-drop__name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.transfer-drop__hint {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.transfer-result {
  margin-top: var(--space-4);
}

.transfer-preview {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-muted);
  scroll-margin-top: calc(var(--page-toolbar-height, 0px) + var(--space-2));
}

.transfer-preview__action {
  justify-self: start;
}

.transfer-preview__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.transfer-preview__project-row :deep(.ui-box-row__meta) {
  overflow-wrap: anywhere;
  text-overflow: clip;
  white-space: normal;
}

.transfer-breakdown {
  display: grid;
  max-height: min(40vh, 320px);
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}

.transfer-breakdown li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-1) var(--space-4);
  padding: var(--space-2) var(--space-3);
}

.transfer-breakdown li + li {
  border-top: 1px solid var(--border-muted);
}

.transfer-breakdown__counts {
  color: var(--fg-muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 639px) {
  .transfer-controls {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
