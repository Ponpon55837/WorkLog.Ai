<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { Archive, DatabaseBackup, Download, RefreshCw, Trash2 } from "lucide-vue-next";
import type { ProjectDataImportPreview } from "@work-intelligence/core";
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
  { value: "all", label: t("全部專案") },
  { value: "project", label: t("單一專案") },
];

const totalBackupBytes = computed(() => backups.value.reduce((total, backup) => total + backup.bytes, 0));
const restoreCommand = t("pnpm db:restore <匯出的檔案> --remap-root <舊電腦的專案上層路徑>=<新電腦的路徑>");
const exportProjectOptions = computed(() =>
  projects.value.map((project) => ({ value: project.id, label: project.name })),
);
const importProjectOptions = computed(() => [
  { value: "", label: t("全部專案") },
  ...importProjects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const importSummary = computed(() => (preview: ProjectDataImportPreview) => {
  const total = (counts: ProjectDataImportPreview["additions"]): number =>
    Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
  return {
    additions: total(preview.additions),
    skipped: total(preview.skipped),
    conflicts: total(preview.conflicts),
    projects: preview.additions.projects ?? 0,
    sessions: preview.additions.sessions ?? 0,
    knowledge: preview.additions.knowledge ?? 0,
  };
});
const importProjectResolutionLabels = {
  existing: t("已對應既有專案"),
  new: t("將新增專案"),
  conflict: t("專案衝突"),
} as const;
const importFolderStatusLabels = {
  found: t("找到資料夾"),
  missing: t("這台電腦找不到這個資料夾"),
  unavailable: t("無法確認資料夾"),
} as const;
const remappedProjectCount = computed(
  () => importPreview.value?.remappedPaths.reduce((total, item) => total + item.projects, 0) ?? 0,
);
const remappedSnapshotCount = computed(
  () => importPreview.value?.remappedPaths.reduce((total, item) => total + item.snapshots, 0) ?? 0,
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
        <UiBoxTitle :icon="Archive" eyebrow="Backups" :title="t('資料備份')" :count="backups.length" />
        <div class="backup-section__actions">
          <UiIconButton
            :icon="RefreshCw"
            :label="t('重新整理備份清單')"
            size="sm"
            :loading="backupsLoading"
            @click="loadBackups"
          />
          <UiButton size="sm" :icon="DatabaseBackup" :loading="backupCreating" @click="createBackup">{{
            t("立即備份")
          }}</UiButton>
        </div>
      </template>
      <p class="backup-section__note">
        {{ t("API server 每個 UTC 日自動備份一次，存在資料庫旁的") }}
        <code>backups/</code>
        {{
          t(
            "資料夾；自動與其他備份分開保留，分別最多 {automaticBackupKeep} 份與 {backupKeep} 份。共 {length} 份，總大小 {value}。",
            { automaticBackupKeep, backupKeep, length: backups.length, value: formatBytes(totalBackupBytes) },
          )
        }}
      </p>
      <UiEmptyState
        v-if="backups.length === 0 && !backupsLoading"
        compact
        :icon="Archive"
        :title="t('還沒有備份')"
        :description="t('按「立即備份」建立第一份。')"
      />
      <!-- Past a handful of backups the list scrolls inside its Box instead of stretching the page. -->
      <VirtualList
        v-else
        :items="backups"
        :enabled="backups.length > scrollAfter"
        fit-viewport
        :estimate-item-height="60"
        :label="t('備份清單')"
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
                  :label="t('刪除備份 {fileName}', { fileName: item.fileName })"
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
        <UiBoxTitle :icon="Download" eyebrow="Move to another computer" :title="t('匯出整份資料')" />
        <UiButton size="sm" variant="primary" :icon="Download" :loading="databaseExporting" @click="exportDatabase">{{
          t("匯出")
        }}</UiButton>
      </template>
      <p>
        {{ t("匯出一個") }} <code>.sqlite</code>
        {{ t("檔，包含所有專案、Session、Knowledge、報告與 handoff。檔案沒有加密，請用可信任的方式帶到新電腦。") }}
      </p>
      <ol class="backup-section__steps">
        <li>{{ t("在新電腦安裝 Work Intelligence 並執行") }} <code>pnpm build</code>{{ t("。") }}</li>
        <li>{{ t("確認 API server 沒有在執行，也關閉會啟動 MCP 的 Codex／Claude 對話。") }}</li>
        <li>
          {{ t("在 repo 根目錄執行下面的指令。專案在新電腦的位置不同時，用") }}
          <code>--remap-root</code> {{ t("換掉路徑前綴；位置相同就不用加。") }}
        </li>
      </ol>
      <div class="backup-section__command">
        <code>{{ restoreCommand }}</code>
        <UiCopyButton
          :text="restoreCommand"
          :label="t('複製還原指令')"
          :success-message="t('已複製還原指令。')"
          size="sm"
        />
      </div>
      <p class="backup-section__hint">
        {{ t("還原前會自動備份新電腦上原本的資料；比目前版本新的資料檔會被拒絕，請先更新 Work Intelligence。") }}
      </p>
    </UiBox>

    <UiBox padded>
      <template #header>
        <UiBoxTitle
          :icon="Archive"
          eyebrow="Portable project data"
          :title="t('依專案匯出與匯入')"
          :count="projects.length"
        />
      </template>
      <UiFlash v-if="transferError" tone="danger">{{ transferError }}</UiFlash>
      <p class="backup-section__hint">
        {{
          t(
            "JSON 匯出檔沒有加密。匯入會合併資料，先顯示新增、略過與衝突數量，再由你確認執行；新匯入的專案會先暫停記錄。",
          )
        }}
      </p>

      <div class="transfer-controls">
        <UiField :label="t('匯出範圍')">
          <UiSelect v-model="exportScope" :options="exportScopeOptions" :label="t('選擇匯出範圍')" />
        </UiField>
        <UiField v-if="exportScope === 'project'" :label="t('匯出專案')">
          <UiSelect
            v-model="exportProjectId"
            :options="exportProjectOptions"
            :label="t('選擇匯出專案')"
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
          {{ t("匯出 JSON") }}
        </UiButton>
      </div>

      <div class="transfer-controls transfer-controls--import">
        <UiField :label="t('匯入檔')" :hint="t('選擇 Work Intelligence 的 .json 匯出檔，最大 50 MiB。')">
          <!-- The native file picker is required so the user can select a local export without uploading it elsewhere. -->
          <input
            class="backup-section__file-input"
            type="file"
            accept=".json,application/json"
            :disabled="importLoading"
            @change="onImportFileChange"
          />
        </UiField>
        <UiField v-if="importProjects.length > 1" :label="t('匯入範圍')">
          <UiSelect v-model="importProjectId" :options="importProjectOptions" :label="t('選擇匯入範圍')" />
        </UiField>
        <p class="backup-section__hint">
          {{ t("選取檔案後會立即預覽。找不到資料夾時，可逐一選擇新位置；也可以保留原始路徑匯入。") }}
        </p>
        <UiButton size="sm" :loading="importLoading" :disabled="!importFileName" @click="previewProjectDataImport">
          {{ t("重新預覽") }}
        </UiButton>
      </div>

      <UiFlash v-if="importError" tone="danger">{{ importError }}</UiFlash>
      <div v-if="importPreview" class="transfer-preview" data-testid="project-import-preview" aria-live="polite">
        <p>{{ t("匯入專案與套用路徑") }}</p>
        <VirtualList
          :items="importPreview.selectedProjects"
          :enabled="importPreview.selectedProjects.length > 4"
          :estimate-item-height="68"
          max-height="min(40vh, 320px)"
          :label="t('匯入專案與路徑')"
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
                  {{ item.folderStatus ? importFolderStatusLabels[item.folderStatus] : t("尚未檢查") }}
                </span>
                <UiButton
                  v-if="item.folderStatus !== 'found'"
                  size="sm"
                  :disabled="importLoading"
                  @click="chooseImportProjectLocation(item.id)"
                  >{{ t("選擇 {name} 的新位置", { name: item.name }) }}</UiButton
                >
              </template>
            </UiBoxRow>
          </template>
        </VirtualList>
        <div class="transfer-preview__counts">
          <div data-testid="project-import-additions">
            <span>{{ t("新增") }}</span>
            <strong>{{ importSummary(importPreview).additions }}</strong>
            <small>{{
              t("專案 {value} · Session {value2} · Knowledge {value3}", {
                value: importSummary(importPreview).projects,
                value2: importSummary(importPreview).sessions,
                value3: importSummary(importPreview).knowledge,
              })
            }}</small>
          </div>
          <div data-testid="project-import-skipped">
            <span>{{ t("略過") }}</span>
            <strong>{{ importSummary(importPreview).skipped }}</strong>
          </div>
          <div data-testid="project-import-conflicts">
            <span>{{ t("衝突") }}</span>
            <strong>{{ importSummary(importPreview).conflicts }}</strong>
          </div>
        </div>
        <p v-if="remappedProjectCount > 0 || remappedSnapshotCount > 0" class="backup-section__hint">
          {{
            t("已套用路徑轉換：專案 {remappedProjectCount} 個、handoff {remappedSnapshotCount} 個。", {
              remappedProjectCount,
              remappedSnapshotCount,
            })
          }}
        </p>
        <VirtualList
          v-if="importPreview.conflictDetails.length > 0"
          :items="importPreview.conflictDetails"
          :enabled="importPreview.conflictDetails.length > 4"
          :estimate-item-height="68"
          max-height="min(40vh, 320px)"
          :label="t('匯入衝突')"
        >
          <template #default="{ item }">
            <UiBoxRow :title="item.reason" :meta="`${item.table} · ${item.id}`" />
          </template>
        </VirtualList>
        <p v-if="importPreview.conflictDetailsTruncated" class="backup-section__hint">
          {{ t("衝突明細超過 100 筆，僅顯示前 100 筆。") }}
        </p>
        <p class="backup-section__hint">
          {{
            t("匯入不會覆寫衝突或已存在的資料，也不會改變既有專案的記錄狀態。新專案若保留原始路徑，會以暫停狀態匯入。")
          }}
        </p>
        <UiButton size="sm" variant="primary" :loading="importLoading" @click="applyProjectDataImport">{{
          t("確認並匯入")
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
}

@media (max-width: 639px) {
  .transfer-controls,
  .transfer-controls--import,
  .transfer-preview__counts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
