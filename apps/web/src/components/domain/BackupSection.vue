<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { Archive, DatabaseBackup, Download, RefreshCw, Trash2 } from "lucide-vue-next";
import type { ProjectDataImportConflictCategory, ProjectDataImportPreview } from "@work-intelligence/core";
import { useBackupsStore } from "../../stores/backups";
import { useProjectDataTransferStore } from "../../stores/project-data-transfer";
import { useProjectsStore } from "../../stores/projects";
import { formatBytes, formatDate, formatRelative } from "../../utils/format";
import { databaseBackupKindLabels } from "../../utils/labels";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCopyButton from "../ui/UiCopyButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { t } from "../../i18n";

/**
 * Database backups and the whole-database export for moving to another computer. Restoring replaces
 * the database while nothing may hold it open, so it is a terminal command, not a button here.
 */
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
const projectsStore = useProjectsStore();
const { projects } = storeToRefs(projectsStore);
const { loadProjects } = projectsStore;
const projectDataTransferStore = useProjectDataTransferStore();
const {
  transferError,
  portableExporting,
  importProjects,
  importFileName,
  importProjectId,
  importStrategy,
  importLoading,
  importPreview,
  importError,
} = storeToRefs(projectDataTransferStore);
const {
  loadImportFile,
  previewProjectDataImport,
  chooseImportProjectLocation,
  applyProjectDataImport,
  exportProjectData,
} = projectDataTransferStore;

const scrollAfter = 6;

const exportScope = ref<"all" | "project">("all");
const exportProjectId = ref("");
const exportScopeOptions = [
  { value: "all", label: t("projects.allProjects") },
  { value: "project", label: t("projects.singleProject") },
];

const totalBackupBytes = computed(() => backups.value.reduce((total, backup) => total + backup.bytes, 0));
const restoreCommand = t("projects.pnpmDbRestoreExportFile");
const exportProjectOptions = computed(() =>
  projects.value.map((project) => ({ value: project.id, label: project.name })),
);
const importProjectOptions = computed(() => [
  { value: "", label: t("projects.allProjects") },
  ...importProjects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const importSummary = computed(() => (preview: ProjectDataImportPreview) => {
  const total = (counts: ProjectDataImportPreview["additions"]): number =>
    Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
  return {
    additions: total(preview.additions),
    updates: total(preview.updates),
    keptLocal: total(preview.keptLocal),
    renumbered: total(preview.renumbered),
    skipped: total(preview.skipped),
    conflicts: total(preview.conflicts),
    projects: preview.additions.projects ?? 0,
    sessions: preview.additions.sessions ?? 0,
    knowledge: preview.additions.knowledge ?? 0,
  };
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

function onImportFileChange(event: Event): Promise<void> {
  const input = event.target;
  return loadImportFile(input instanceof HTMLInputElement ? input.files?.[0] : undefined);
}

onMounted(() => {
  backupsStore.setBackupsActive(true);
  void loadProjects();
});
onBeforeUnmount(() => backupsStore.setBackupsActive(false));
</script>

<template>
  <div class="backup-section">
    <UiFlash v-if="backupsError" tone="danger">{{ backupsError }}</UiFlash>

    <UiBox>
      <template #header>
        <UiBoxTitle
          :icon="Archive"
          eyebrow="Backups"
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
        <UiBoxTitle :icon="Download" eyebrow="Move to another computer" :title="t('projects.exportAllData')" />
        <UiButton size="sm" variant="primary" :icon="Download" :loading="databaseExporting" @click="exportDatabase">{{
          t("common.export")
        }}</UiButton>
      </template>
      <p>
        {{ t("projects.exportA") }} <code>.sqlite</code>
        {{ t("projects.fileContainingEveryProjectSession") }}
      </p>
      <ol class="backup-section__steps">
        <li>{{ t("projects.installWorkIntelligenceOnThe") }} <code>pnpm build</code>{{ t("common.sentenceEnd") }}</li>
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
      <p class="backup-section__hint">
        {{ t("projects.beforeRestoringTheExistingData") }}
      </p>
    </UiBox>

    <UiBox padded>
      <template #header>
        <UiBoxTitle
          :icon="Archive"
          eyebrow="Portable project data"
          :title="t('projects.exportAndImportByProject')"
          :count="projects.length"
        />
      </template>
      <UiFlash v-if="transferError" tone="danger">{{ transferError }}</UiFlash>
      <p class="backup-section__hint">
        {{ t("projects.jsonExportsAreNotEncrypted") }}
      </p>

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
          size="sm"
          :icon="Download"
          :loading="portableExporting"
          :disabled="exportScope === 'project' && !exportProjectId"
          @click="exportPortableData"
        >
          {{ t("common.exportJson") }}
        </UiButton>
      </div>

      <div class="transfer-controls transfer-controls--import">
        <UiField :label="t('projects.importFile')" :hint="t('projects.chooseAWorkIntelligenceJson')">
          <!-- The native file picker is required so the user can select a local export without uploading it elsewhere. -->
          <input
            class="backup-section__file-input"
            type="file"
            accept=".json,application/json"
            :disabled="importLoading"
            @change="onImportFileChange"
          />
        </UiField>
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
        <p class="backup-section__hint">
          {{ t("projects.theFileIsPreviewedAs") }}
        </p>
        <UiButton size="sm" :loading="importLoading" :disabled="!importFileName" @click="previewProjectDataImport">
          {{ t("projects.previewAgain") }}
        </UiButton>
      </div>

      <UiFlash v-if="importError" tone="danger">{{ importError }}</UiFlash>
      <div v-if="importPreview" class="transfer-preview" data-testid="project-import-preview" aria-live="polite">
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
        <div class="transfer-preview__counts">
          <div data-testid="project-import-additions">
            <span>{{ t("common.added") }}</span>
            <strong>{{ importSummary(importPreview).additions }}</strong>
            <small>{{
              t("projects.projectsSessionsKnowledge", {
                value: importSummary(importPreview).projects,
                value2: importSummary(importPreview).sessions,
                value3: importSummary(importPreview).knowledge,
              })
            }}</small>
          </div>
          <div data-testid="project-import-updates">
            <span>{{ t("projects.updated") }}</span>
            <strong>{{ importSummary(importPreview).updates }}</strong>
          </div>
          <div data-testid="project-import-kept-local">
            <span>{{ t("projects.keptLocal") }}</span>
            <strong>{{ importSummary(importPreview).keptLocal }}</strong>
          </div>
          <div data-testid="project-import-skipped">
            <span>{{ t("projects.skipped") }}</span>
            <strong>{{ importSummary(importPreview).skipped }}</strong>
          </div>
          <div data-testid="project-import-conflicts">
            <span>{{ t("projects.conflicts") }}</span>
            <strong>{{ importSummary(importPreview).conflicts }}</strong>
          </div>
        </div>
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
        <p v-if="importSummary(importPreview).renumbered > 0" class="backup-section__hint">
          {{ t("projects.pageVersionsRenumbered", { count: importSummary(importPreview).renumbered }) }}
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
                  table: item.table,
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
        <UiButton size="sm" variant="primary" :loading="importLoading" @click="applyProjectDataImport">{{
          t("projects.confirmAndImport")
        }}</UiButton>
      </div>
    </UiBox>
  </div>
</template>

<style scoped>
.backup-section {
  display: grid;
  gap: var(--space-4);
}

.backup-section > .ui-box + .ui-box {
  margin-top: 0;
}

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
.backup-section__hint,
.backup-section__time {
  color: var(--fg-muted);
  font-size: var(--text-xs);
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

.backup-section__steps {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-3) 0;
  padding-left: var(--space-6);
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
  grid-template-columns: minmax(160px, 220px) minmax(180px, 1fr) auto;
  align-items: end;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.transfer-controls--import {
  grid-template-columns: minmax(220px, 1.3fr) repeat(2, minmax(160px, 1fr)) minmax(160px, 1fr) auto;
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.backup-section__file-input {
  width: 100%;
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-muted);
  color: var(--fg);
  font-size: var(--text-xs);
}

.backup-section__file-input::file-selector-button {
  margin-right: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

.backup-section__file-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.transfer-preview {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.transfer-preview__project-row :deep(.ui-box-row__meta) {
  overflow-wrap: anywhere;
  text-overflow: clip;
  white-space: normal;
}

.transfer-preview__counts {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-3);
}

.transfer-preview__counts > div {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}

.transfer-preview__counts span,
.transfer-preview__counts small {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.transfer-preview__counts strong {
  font-size: var(--text-lg);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1279px) {
  .transfer-controls,
  .transfer-controls--import {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .transfer-preview__counts {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 639px) {
  .transfer-controls,
  .transfer-controls--import,
  .transfer-preview__counts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
